"""ALC answer verification — software decides what the user is allowed to see.

The cycle already refuses to write an ungrounded *note*: :mod:`app.alc.study`
checks every specific in a synthesised study against the gathered passages. The
answer the user actually reads had no such check, which is the gap this module
closes.

Why the check runs DURING the stream rather than after it
--------------------------------------------------------
The chat route forwards ``onChunk`` text straight to the client, and the client
appends what it receives — nothing reconciles the streamed text with the final
message. So a fabricated value, once streamed, is in the user's transcript
whether or not a later step apologises for it. A post-hoc caveat therefore
cannot stop a wrong number from being read, and the eval harness (which scores
the concatenated stream) would still record a fabrication.

The gate below is the honest alternative: the answer is released one unit at a
time (a sentence, or a line), each unit is checked before it is emitted, and a
unit asserting specifics that appear in NO source is replaced by an honest
sentence that names what could not be verified. The fabricated text never
reaches the client, so the metric and the user's screen agree.

What counts as a claim
----------------------
:data:`app.alc.study.SPECIFICITY_PATTERNS` is the single definition of a
"specific" and is reused here for the identifier shapes. Numbers are handled
more conservatively than in the note path on purpose: an answer is prose, and
"here are 3 things" or "step 2" is not a claim about the sources, so a number
only counts when a value cue sits next to it ("default is 1000", "returns 60ms",
"= 16"). Missing a claim understates the guard; mangling ordinary prose would
make the answer worse than the fabrication it prevented.

Code is never gated. A fenced block or a code-shaped line is the model writing
what the user asked it to write, and withholding it would break the answer
rather than protect the user (docs/ALC_DESIGN.md §4.10).

Everything here is pure — no model, no I/O — so the whole guard is unit-testable.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .study import SPECIFICITY_PATTERNS, normalise

#: A unit longer than this is released anyway (a wall of text with no sentence
#: break must not stall the stream). Verification still runs on it.
MAX_UNIT_CHARS = 1200

#: Cues that turn a bare integer into a claim about the sources. Deliberately
#: narrow — these are the shapes a fabricated fact arrives in. A keyword cue may
#: be followed by up to two filler words ("defaults TO 120", "cap IS 4000"),
#: which is how values are actually written in prose.
#: The copula alternative needs a VALUE NOUN in front of it ("the default is
#: 120"), not a bare "is": "here are 3 things" is prose, and flagging it would
#: mangle correct answers.
_VALUE_CUE_RE = re.compile(
    r"(?:[=:]|"
    r"\b(?:returns?|returned|defaults?|values?|quota|floor|ceiling|limits?|"
    r"max(?:imum)?|min(?:imum)?|allows?|count|frames?|tokens?|caps?|budget|"
    r"version|ms|kb|mb|gb)\b(?:\s+[\w.%-]{1,10}){0,2}|"
    r"\b(?:defaults?|caps?|values?|limits?|max(?:imum)?|min(?:imum)?|ceiling|floor|"
    r"count|budget|quota|version|size|total|number|answer)s?\s+(?:is|are|was|were)\b|"
    r"%)\s*$",
    re.IGNORECASE,
)

#: Units carrying these look like code or data, not prose. List markers are
#: deliberately NOT here: a numbered or bulleted line is prose that must still be
#: checked (a fabricated value hiding in a bullet is the common case).
_CODEISH_RE = re.compile(
    r"^\s*(?:```|~~~|\||#!|[{}()\[\]]|import |from |def |class |"
    r"const |let |var |function |SELECT |curl |\$ |>\>\>)"
)

_FENCE_LINE_RE = re.compile(r"^[ \t]*(?:```|~~~)")
_NUMBER_RE = re.compile(r"(?<![\w.])(\d+(?:\.\d+)?)(?![\w])")

#: Template used when a unit asserts something no source supports. It must read
#: as honest ignorance — the eval scorer credits exactly this phrasing.
#:
#: It names NO value on purpose. Repeating the unverified number would put the
#: exact fabrication back in front of the reader (and back into the scored
#: answer), which is the thing the gate exists to prevent. WHAT was withheld is
#: not lost: it is recorded per unit and shown in the trajectory.
_CAVEAT = "I could not verify part of that against the sources I searched, so I am leaving it out."
_NOTHING_VERIFIED = (
    "I could not verify that against the sources I searched, so I am not going to guess at it."
)


def _is_year(token: str) -> bool:
    head = str(token).split(".")[0]
    return len(head) == 4 and head.isdigit() and 1900 <= int(head) <= 2100


def _number_claims(text: str) -> list[str]:
    """Numbers in a value position — the subset of numbers worth policing."""
    out: list[str] = []
    for match in _NUMBER_RE.finditer(text or ""):
        token = match.group(1)
        if _is_year(token):
            continue
        after = text[match.end() : match.end() + 2]
        if len(token.split(".")[0]) == 1 and after[:1] in (".", ")"):
            continue  # a list marker
        if "." not in token and not _VALUE_CUE_RE.search(text[max(0, match.start() - 24) : match.start()]):
            continue  # a plain integer with no value cue: prose, not a claim
        out.append(token)
    return out


def claim_tokens(text: str) -> list[str]:
    """Every specific in ``text`` that asserts something about the world."""
    found: list[str] = []
    for kind, pattern in SPECIFICITY_PATTERNS:
        if kind == "number":
            continue
        for match in pattern.finditer(str(text or "")):
            token = match.group(0)
            if token not in found:
                found.append(token)
    for token in _number_claims(str(text or "")):
        if token not in found:
            found.append(token)
    return found


def evidence_norm(*texts: str) -> str:
    """The normalised haystack a claim has to appear in to count as supported."""
    return normalise(" \n ".join(str(text or "") for text in texts if text))


def ungrounded_claims(text: str, evidence: str) -> list[str]:
    """Claims in ``text`` that appear nowhere in the normalised ``evidence``."""
    missing: list[str] = []
    for token in claim_tokens(text):
        if normalise(token) not in evidence:
            missing.append(token)
    return missing


def allowed_specifics(evidence: str, *, limit: int = 48) -> list[str]:
    """The specifics in this turn's evidence, for the pre-emptive prompt hint.

    Cheaper and stronger than a post-hoc check: telling a 1.7B model which
    values it may use stops most fabrications happening at all, and the gate
    above then covers the rest.
    """
    seen: list[str] = []
    for _kind, pattern in SPECIFICITY_PATTERNS:
        for match in pattern.finditer(evidence or ""):
            token = match.group(0)
            if _is_year(token) or token in seen:
                continue
            seen.append(token)
            if len(seen) >= limit:
                return seen
    return seen


def guard_hint(evidence_text: str) -> str:
    """The system-prompt block that lists the specifics the answer may use."""
    allowed = allowed_specifics(evidence_text)
    if not allowed:
        return (
            "[ALC — NOTHING TO CITE]\n"
            "No information was retrieved for this turn. Do not state versions, numbers, "
            "defaults, quotas, identifiers or paths as fact: say plainly that you could not "
            "check them. Only what the user themselves wrote may be repeated as a specific."
        )
    listing = ", ".join(allowed[:48])
    return (
        "[ALC — VALUES YOU MAY USE]\n"
        "These are the only specific values, names, codes, paths and numbers in this turn's "
        "evidence: " + listing + "\n"
        "Anything else is a fabrication: if the answer needs a value that is not on that list "
        "and not in the user's own message, say you could not verify it instead of supplying one."
    )


def _is_code_unit(unit: str) -> bool:
    stripped = unit.strip()
    if not stripped:
        return True
    if stripped.startswith("```") or stripped.startswith("~~~"):
        return True
    # A single long token, or a line with almost no natural-language words, is
    # code/data rather than a claim in prose.
    words = re.findall(r"[A-Za-z]{3,}", stripped)
    return bool(_CODEISH_RE.match(unit)) or (len(stripped) > 40 and len(words) <= 2)


def _scan(text: str, in_fence: bool) -> tuple[int | None, bool]:
    """Offset just past the first unit boundary, and the fence state there."""
    i = 0
    line_start = 0
    length = len(text)
    while i < length:
        ch = text[i]
        if ch == "\n":
            line = text[line_start:i]
            if _FENCE_LINE_RE.match(line):
                # A fence marker is always a safe boundary, and it flips the mode.
                return i + 1, not in_fence
            line_start = i + 1
            if not in_fence:
                return i + 1, in_fence
            i += 1
            continue
        if not in_fence and ch in ".!?":
            following = text[i + 1] if i + 1 < length else ""
            if following == "" or following.isspace():
                return i + 1, in_fence
        i += 1
    return None, in_fence


@dataclass
class GateResult:
    """What the gate did, for the event stream and the report."""

    released: str = ""
    blocks: int = 0
    withheld: list[dict[str, Any]] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(self.blocks)


class AnswerGate:
    """Release an answer only as far as software can vouch for it.

    Usage: feed every model chunk, then call :meth:`finish`. ``released`` is what
    the user actually saw — the caller returns THAT text, never the raw answer,
    so the transcript, the stored message and the measurement all agree.
    """

    def __init__(self, evidence: str, *, enabled: bool = True) -> None:
        self._evidence = evidence
        self._enabled = enabled
        self._buffer = ""
        self._in_fence = False
        self._result = GateResult()
        self._units = 0
        self._released_real = 0

    # ── public ──────────────────────────────────────────────────────────
    @property
    def result(self) -> GateResult:
        return self._result

    @property
    def released(self) -> str:
        return self._result.released

    @property
    def enabled(self) -> bool:
        return self._enabled

    def feed(self, text: str) -> str:
        """Accept a model chunk; return only the text safe to emit right now."""
        if not text:
            return ""
        if not self._enabled:
            self._result.released += text
            return text
        self._buffer += text
        out: list[str] = []
        while True:
            started_in_fence = self._in_fence
            cut, in_fence = _scan(self._buffer, self._in_fence)
            if cut is None:
                # No boundary yet. A runaway unit (no punctuation at all) must
                # not stall the stream, so it is verified and released whole.
                if len(self._buffer) >= MAX_UNIT_CHARS and not self._in_fence:
                    out.append(self._verify(self._buffer, code=False))
                    self._buffer = ""
                break
            unit, self._buffer = self._buffer[:cut], self._buffer[cut:]
            self._in_fence = in_fence
            out.append(self._verify(unit, code=started_in_fence))
        return "".join(out)

    def finish(self) -> str:
        """Flush whatever is left and return it (already verified)."""
        if not self._enabled:
            return ""
        if not self._buffer:
            return ""
        tail, self._buffer = self._buffer, ""
        return self._verify(tail, code=self._in_fence) if tail else ""

    # ── internals ───────────────────────────────────────────────────────
    def _verify(self, unit: str, *, code: bool) -> str:
        """``code`` is whether the unit BEGAN inside a fence (the closing fence
        flips the state, so the state after the cut cannot answer that)."""
        if not unit:
            return ""
        self._units += 1
        if not unit.strip():
            # Whitespace carries no claim, and it must not count as "something
            # survived" — that is what tells the caller the whole answer was
            # withheld (see closing_note).
            self._result.released += unit
            return unit
        # Code and data are the model writing what it was asked to write, not a
        # claim about the sources.
        if code or _is_code_unit(unit):
            self._released_real += 1
            self._result.released += unit
            return unit
        claims = ungrounded_claims(unit, self._evidence)
        if not claims:
            self._released_real += 1
            self._result.released += unit
            return unit
        self._result.blocks += 1
        self._result.withheld.append({"unit": unit.strip()[:400], "claims": claims[:6]})
        replacement = self._replacement(claims, unit)
        self._result.released += replacement
        return replacement

    def _replacement(self, _claims: list[str], unit: str) -> str:
        body = _CAVEAT
        # Keep the shape of the unit: a bullet stays a bullet, a paragraph is
        # followed by a space, so the answer still reads as prose.
        if re.match(r"^\s*[-*+]\s", unit):
            return re.sub(r"^(\s*[-*+]\s).*", lambda m: f"{m.group(1)}{body}", unit, count=1) + "\n"
        if unit.endswith("\n"):
            return body + "\n"
        if unit.endswith(" "):
            return body + " "
        return body

    def closing_note(self) -> str:
        """The extra sentence when NOTHING verifiable was released."""
        if not self._enabled or not self._result.blocks or self._released_real:
            return ""
        return "\n\n" + _NOTHING_VERIFIED

    def seal(self) -> str:
        """Close the answer: append the note (if any) and return it.

        The note goes through here rather than around the caller so that
        ``released`` stays the single source of truth for what the user saw.
        """
        note = self.closing_note()
        if note:
            self._result.released += note
        return note


__all__ = [
    "AnswerGate",
    "GateResult",
    "allowed_specifics",
    "claim_tokens",
    "evidence_norm",
    "guard_hint",
    "ungrounded_claims",
]
