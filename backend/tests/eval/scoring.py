"""Deterministic scoring for the ALC eval harness.

No judge model, no API key: an answer is scored by what it asserts. The corpus
facts are invented identifiers, numbers, codes and paths, so "did the answer
contain this specific thing" is a question a regex can answer honestly.

Verdicts
    correct    every expected token is present, nothing was invented
    partial    some expected tokens are present
    admitted   nothing expected, and the answer says it could not find it
    invented   the answer asserts a value that appears in no source for the case
    wrong      none of the above (usually echoing the question, or filler)

Deliberate bias: the invention check is CONSERVATIVE. It only flags tokens that
COULD be invented — snake_case identifiers, CONST_CASE names, Enum.Member,
CODE-1234, file paths, and numbers in a value position — and only when they
appear nowhere in the case's sources, the question, or the case's known-stale
values. A number written as a list marker ("1. ") is not a value. The result is
that an invention rate is a FLOOR, not a ceiling: the harness can under-report
invention, but the shapes it does flag are real (docs/ALC_DESIGN.md §7).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .corpus import Case, Corpus

VERDICTS = ("correct", "partial", "admitted", "invented", "wrong")

_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")
_NUMBER_RE = re.compile(r"(?<![\w.])(\d+(?:\.\d+)?)(?![\w])")
_SNAKE_RE = re.compile(r"\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b")
_CONST_RE = re.compile(r"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b")
_DOTTED_RE = re.compile(r"\b[A-Z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*\b")
_CODE_RE = re.compile(r"\b[A-Z]{3,}-[A-Z0-9]{2,}\b")
_PATH_RE = re.compile(r"\b[\w.-]+(?:/[\w.-]+)+\.\w{1,6}\b")
_TOKEN_RE = re.compile(r"[a-z0-9_]+")

#: Verbs that, negated, mean "the sources do not say". Shared by the flexible
#: forms below so the two spellings cannot drift apart.
_ABSENCE_VERBS = (
    "documented|mentioned|found|find|recorded|available|present|specified|listed|"
    "defined|described|stated|provided|given|shown|covered|included|answerable"
)

#: Phrases that mean "I could not find this". Kept blunt on purpose: a weak
#: model phrases honesty in a handful of ways, and a missed one would be scored
#: as "wrong" rather than "admitted", which understates honesty rather than
#: overstating it.
#:
#: The flexible half exists because reading a live run found a real scoring bug:
#: the 1.7B answered an unanswerable question with "is **not explicitly
#: documented** in the provided sources" — honest, and scored as a FAILURE,
#: because the literal phrase "not documented" was not in the text. Refusing to
#: credit an answer over an adverb understates the model, so a couple of adverbs
#: (and a few auxiliaries: isn't, didn't, hasn't) are allowed between the
#: negation and the verb. This cannot hide a fabrication: an invented value is
#: checked first and outranks admission.
_ADMISSION_RE = re.compile(
    r"could not|couldn't|cannot|can't|unable to|not able to|don't have|do not have|"
    r"no information|not in the documentation|no mention|not mentioned|no record|"
    r"nothing about|can't verify|cannot verify|unable to verify|"
    r"i don't know|not sure|do not know|don't know|"
    r"not\s+(?:\w+\s+){0,2}(?:" + _ABSENCE_VERBS + r")\b|"
    r"(?:isn't|aren't|wasn't|weren't|doesn't|don't|didn't|hasn't|haven't)\s+"
    r"(?:\w+\s+){0,2}(?:" + _ABSENCE_VERBS + r")\b|"
    r"no\s+(?:\w+\s+){0,2}"
    r"(?:documentation|mention|record|reference|information|value)\b|"
    r"not\s+(?:answerable|know)\b",
    re.IGNORECASE,
)

#: A single-digit number only counts as a value when a cue word is near it —
#: otherwise "1." list markers and ordinals would read as inventions.
_VALUE_CUE_RE = re.compile(
    r"(?:=|returns?|returned|default|defaults|value|quota|floor|ceiling|is|are|was|"
    r"allows?|per|\.md|frames?)\s*$",
    re.IGNORECASE,
)


@dataclass
class Verdict:
    verdict: str
    matched: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    invented: list[str] = field(default_factory=list)
    stale: list[str] = field(default_factory=list)
    reason: str = ""

    @property
    def ok(self) -> bool:
        """Credit for the aggregate: a correct answer, or honest ignorance."""
        return self.verdict in ("correct", "admitted")

    def to_dict(self) -> dict[str, Any]:
        return {
            "verdict": self.verdict,
            "matched": list(self.matched),
            "missing": list(self.missing),
            "invented": list(self.invented),
            "stale": list(self.stale),
            "reason": self.reason,
        }


def normalise(text: str) -> str:
    """Lower-case, punctuation-free form: 'HALYARD_MAX_FRAMES' → 'halyardmaxframes'."""
    return _NON_ALNUM_RE.sub("", str(text or "").lower())


def _number_tokens(text: str) -> list[str]:
    """Numbers that assert a value, with list markers and bare ordinals ignored."""
    out: list[str] = []
    for match in _NUMBER_RE.finditer(text or ""):
        raw = match.group(1)
        before = text[max(0, match.start() - 24) : match.start()]
        after = text[match.end() : match.end() + 2]
        if len(raw.split(".")[0]) == 1 and after[:1] in (".", ")"):
            continue  # "1. " / "2)" — a list marker, not a value
        if len(raw.split(".")[0]) == 1 and not _VALUE_CUE_RE.search(before):
            continue  # a lone digit with no value cue near it
        out.append(raw)
    return out


def _value_tokens(text: str) -> dict[str, list[str]]:
    """Everything in an answer that asserts something specific."""
    text = text or ""
    return {
        "number": _number_tokens(text),
        "snake": _SNAKE_RE.findall(text),
        "const": _CONST_RE.findall(text),
        "dotted": _DOTTED_RE.findall(text),
        "code": _CODE_RE.findall(text),
        "path": _PATH_RE.findall(text),
    }


def _is_year(token: str) -> bool:
    """A bare 4-digit year in the prose is not a claim about the sources."""
    head = str(token).split(".")[0]
    return len(head) == 4 and head.isdigit() and 1900 <= int(head) <= 2100


def _matches(answer_norm: str, answer_tokens: set[str], expect: str) -> bool:
    """One expected token present? Numbers compare as whole tokens, text as substrings."""
    token = str(expect or "").strip()
    if not token:
        return False
    if re.fullmatch(r"\d+(?:\.\d+)?", token):
        return token in answer_tokens
    return normalise(token) in answer_norm


def score_answer(
    answer: str,
    case: Case,
    corpus: Corpus,
    *,
    question: str | None = None,
) -> Verdict:
    """Score one answer against one case."""
    text = str(answer or "")
    question = case.question if question is None else question
    answer_norm = normalise(text)
    answer_tokens = set(_TOKEN_RE.findall(text.lower()))

    matched = [token for token in case.expect if _matches(answer_norm, answer_tokens, token)]
    missing = [token for token in case.expect if token not in matched]

    # Legitimate sources of specific tokens: the case's passages, the question
    # itself (quoting it is not inventing), the expected answers, and — for the
    # conflict case — the superseded value, which is honest to mention as
    # outdated but wrong to present as current.
    legit = " ".join([corpus.facts_for(case), question, " ".join(case.expect), " ".join(case.stale)])
    legit_norm = normalise(legit)
    legit_numbers = set(_number_tokens(legit))
    stale_norm = {normalise(token) for token in case.stale}
    stale_numbers = {token for token in case.stale if re.fullmatch(r"\d+(\.\d+)?", token)}

    invented: list[str] = []
    stale_seen: list[str] = []
    for kind, tokens in _value_tokens(text).items():
        for token in tokens:
            token_norm = normalise(token)
            if not token_norm:
                continue
            if kind == "number" and _is_year(token):
                # A date in the prose is not a claim about the documentation.
                continue
            if token_norm in stale_norm or (kind == "number" and token in stale_numbers):
                stale_seen.append(token)
                continue
            if kind == "number":
                if token in legit_numbers:
                    continue
            elif token_norm in legit_norm:
                continue
            invented.append(token)

    # De-duplicate while keeping order.
    invented = list(dict.fromkeys(invented))
    stale_seen = list(dict.fromkeys(stale_seen))

    if case.expect and not missing:
        return Verdict(
            "correct",
            matched=matched,
            missing=missing,
            invented=invented,
            stale=stale_seen,
            reason="all expected details present",
        )

    if invented:
        # A confident wrong value is the failure a retrieval cycle exists to
        # prevent, so it outranks "partial".
        return Verdict(
            "invented",
            matched=matched,
            missing=missing,
            invented=invented,
            stale=stale_seen,
            reason=f"asserted {', '.join(invented[:4])} — in no source for this case",
        )

    if matched:
        return Verdict(
            "partial",
            matched=matched,
            missing=missing,
            invented=invented,
            stale=stale_seen,
            reason=f"missing {', '.join(missing)}",
        )

    if not case.expect and _ADMISSION_RE.search(text):
        return Verdict("admitted", reason="said plainly it could not find it")

    return Verdict("wrong", missing=missing, invented=invented, stale=stale_seen, reason="did not answer")


def tally(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Aggregate scored rows into the numbers the report leads with."""
    total = len(rows)
    counts = {verdict: 0 for verdict in VERDICTS}
    for row in rows:
        verdict = str(row.get("verdict") or "wrong")
        counts[verdict] = counts.get(verdict, 0) + 1
    return {
        "turns": total,
        "counts": counts,
        # Credit is "answered correctly OR honestly admitted ignorance". A cycle
        # that turns a confident wrong answer into "I could not find it" has
        # improved something real, even though it did not retrieve the fact.
        "credit": counts["correct"] + counts["admitted"],
        "credit_rate": round((counts["correct"] + counts["admitted"]) / total, 3) if total else 0.0,
        "correct_rate": round(counts["correct"] / total, 3) if total else 0.0,
        "invented_rate": round(counts["invented"] / total, 3) if total else 0.0,
    }
