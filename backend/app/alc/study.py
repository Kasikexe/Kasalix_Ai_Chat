"""ALC study — the model reasons over what was gathered; software checks it.

Phase 2 promoted RAW EXCERPTS: ``knowledge.remember`` appended the passage the
judge kept. That stores what was *searched*, not what was *learned* — a later
turn receives a pile of quote-shaped text and has to do the reasoning again.

A study is the other order. The model writes down what the evidence means (what
it is, the facts, the exact signatures, what is still unanswered), and software
then refuses any line whose specifics cannot be traced back to the gathered
passages. The split is deliberate: prose is what a 1.7B model is good at, and
grounding is what it is not. So the model nominates and writes; software vetoes
(docs/ALC_DESIGN.md D9, amended for Phase 4 in §4.7).

Two software-owned checks:

* :func:`ground_sections` — every identifier, value, code, path and number in a
  line must appear verbatim in the gathered evidence, or the line is dropped. A
  section header carrying an unsourced specific drops its whole section.
* :func:`detect_conflicts` — when two sources state different values for the same
  name, the NEWER source wins, the older value is kept under ``## Conflicting
  sources``, and a line that presents the superseded value as current is dropped.

If nothing survives, the caller falls back to the Phase 2 excerpt note, so a bad
generation can never leave the cycle worse than it was before this module existed.

Everything here is pure except :func:`synthesise`, which makes exactly one model
call — so the checks are unit-testable with no model and no Ollama.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from ..logger import info as log_info
from . import decide
from .decide import LLMConn

#: Tokens that count as "a specific claim" — the things a study must not invent.
SPECIFICITY_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("snake", re.compile(r"\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b")),
    ("const", re.compile(r"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b")),
    ("dotted", re.compile(r"\b[A-Z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*\b")),
    ("code", re.compile(r"\b[A-Z]{3,}-[A-Z0-9]{2,}\b")),
    ("path", re.compile(r"\b[\w.-]+(?:/[\w.-]+)+\.\w{1,6}\b")),
    ("number", re.compile(r"(?<![\w.])(\d+(?:\.\d+)?)(?![\w])")),
)

_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")
_NUMBER_ONLY_RE = re.compile(r"^\d+(?:\.\d+)?$")
_HEADER_RE = re.compile(r"^(#{1,6})\s*(.+?)\s*#*\s*$")
_BULLET_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$")
_ASSIGN_WINDOW = 48
MAX_STUDY_TOKENS = 700
MAX_DROPPED_RECORDS = 12
MAX_OPEN_QUESTIONS = 5

#: Model section headers → the canonical section this module re-emits.
SECTION_ALIASES: dict[str, str] = {
    "what it is": "overview",
    "overview": "overview",
    "summary": "overview",
    "what this is": "overview",
    "about": "overview",
    "key facts": "facts",
    "facts": "facts",
    "key points": "facts",
    "details": "facts",
    "apis and signatures": "api",
    "apis / signatures": "api",
    "api and signatures": "api",
    "apis": "api",
    "api": "api",
    "signatures": "api",
    "pitfalls": "pitfalls",
    "gotchas": "pitfalls",
    "caveats": "pitfalls",
    "constraints": "pitfalls",
    "open questions": "questions",
    "unanswered": "questions",
    "unanswered questions": "questions",
    "gaps": "questions",
    "unknowns": "questions",
    "conflicting sources": "conflicts",
    "conflicts": "conflicts",
}

SECTION_TITLES: dict[str, str] = {
    "overview": "What it is",
    "facts": "Key facts",
    "api": "APIs and signatures",
    "pitfalls": "Pitfalls",
    "questions": "Open questions",
    "conflicts": "Conflicting sources",
    "notes": "Notes",
}

SECTION_ORDER = ("overview", "facts", "api", "pitfalls", "questions", "conflicts", "notes")


def _header_key(title: str) -> str:
    """A heading's identity: case, punctuation and spacing must not matter.

    So ``APIs and signatures``, ``APIs / signatures`` and ``## APIS  AND
    SIGNATURES`` are all one section — a 1.7B model rewords headings freely.
    """
    return " ".join(_NON_ALNUM_RE.sub(" ", str(title or "").lower()).split())


#: Alias lookup by normalised heading.
_ALIASES: dict[str, str] = {_header_key(key): value for key, value in SECTION_ALIASES.items()}


# ─── Evidence ───────────────────────────────────────────────────────────
@dataclass
class TopicEvidence:
    """The gathered material for one topic, as the study writer sees it."""

    topic: str
    sources: list[dict[str, str]] = field(default_factory=list)   # [{"source","date"}]
    passages: list[dict[str, str]] = field(default_factory=list)   # [{"source","date","text"}]
    existing: str = ""

    def evidence_text(self) -> str:
        """What a specific in the study is allowed to have come from.

        Includes the source lines, so quoting a path or a URL from a heading is
        grounded rather than flagged.
        """
        parts: list[str] = []
        for item in self.passages:
            parts.append(f"{item.get('source')} {item.get('date')}")
            parts.append(str(item.get("text") or ""))
        return "\n".join(parts)

    def sources_line(self) -> str:
        seen: list[str] = []
        for item in self.sources:
            source = str(item.get("source") or "").strip()
            if not source or source in seen:
                continue
            seen.append(source)
        return ", ".join(f"`{source}`" for source in seen[:8])


@dataclass
class StudyResult:
    ok: bool
    body: str = ""
    bullets: int = 0
    dropped: list[dict[str, Any]] = field(default_factory=list)
    conflicts: list[dict[str, Any]] = field(default_factory=list)
    reason: str = ""

    @property
    def dropped_count(self) -> int:
        return len(self.dropped)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "bullets": self.bullets,
            "dropped": self.dropped_count,
            "conflicts": len(self.conflicts),
            "reason": self.reason,
        }


# ─── Grounding (pure) ───────────────────────────────────────────────────
def normalise(text: str) -> str:
    return _NON_ALNUM_RE.sub("", str(text or "").lower())


def _is_year(token: str) -> bool:
    head = str(token).split(".")[0]
    return len(head) == 4 and head.isdigit() and 1900 <= int(head) <= 2100


def specificity_tokens(line: str) -> list[str]:
    """The claims in a line: identifiers, codes, paths and values."""
    text = str(line or "")
    found: list[str] = []
    for kind, pattern in SPECIFICITY_PATTERNS:
        for match in pattern.finditer(text):
            token = match.group(0)
            if kind == "number":
                # A bare year is calendar, not a claim about the sources.
                if _is_year(token):
                    continue
                # A single digit is a claim only when it is not a list marker.
                if len(token.split(".")[0]) == 1 and text[match.end() : match.end() + 1] in (".", ")"):
                    continue
            if token not in found:
                found.append(token)
    return found


def ungrounded_tokens(line: str, evidence_norm: str) -> list[str]:
    """The specifics in a line that appear nowhere in the evidence."""
    missing: list[str] = []
    for token in specificity_tokens(line):
        if normalise(token) not in evidence_norm:
            missing.append(token)
    return missing


def _parse_sections(raw: str) -> list[dict[str, Any]]:
    """Split model markdown into sections, tolerating any heading style."""
    text = str(raw or "").strip()
    fence = re.match(r"^```[a-zA-Z]*\s*\n(.*)\n```\s*$", text, re.DOTALL)
    if fence:
        text = fence.group(1)
    sections: list[dict[str, Any]] = []
    current: dict[str, Any] = {"key": "notes", "header": "", "lines": [], "ordered": False}
    for line in text.splitlines():
        header = _HEADER_RE.match(line)
        stripped = line.strip()
        bold = re.match(r"^\*\*(.+?)\*\*:?\s*$", stripped)
        if header or bold:
            title = (header.group(2) if header else bold.group(1)).strip().strip("*").strip()
            key = _ALIASES.get(_header_key(title), "")
            if current["lines"] or current["header"]:
                sections.append(current)
            current = {
                "key": key or "notes",
                "header": title,
                "lines": [],
                "ordered": bool(key),
            }
            continue
        if stripped:
            current["lines"].append(stripped)
    if current["lines"] or current["header"]:
        sections.append(current)
    return sections


def ground_sections(
    raw: str,
    evidence: str,
    *,
    drop_headers: list[str] | None = None,
) -> tuple[str, int, list[dict[str, Any]]]:
    """Filter model markdown down to what the evidence supports.

    Returns ``(markdown, kept_lines, dropped)``. Two rules:

    1. every line must be free of unsourced SPECIFICS (identifiers, codes, paths,
       versions, numbers), and a heading that carries one drops its whole section;
    2. lines in the APIs section must additionally appear VERBATIM in the evidence.

    Rule 2 exists because of a real failure found in a live snapshot: the source
    said "`peltarn_write_quota()` returns the number of concurrent writes a key may
    make", and the model wrote a `def peltarn_write_quota() -> int:` block with that
    sentence as its docstring.

    Every token in that is sourced, so rule 1 passed it — but the *form* is
    invented, and a fabricated signature is the most misleading thing a note can
    carry, because it looks like documented API surface. Verbatim-only is a
    deliberately blunt fix: a legitimately reformatted signature is lost too.
    """
    evidence_norm = normalise(evidence)
    dropped: list[dict[str, Any]] = []
    kept = 0
    out: list[str] = []
    for section in _parse_sections(raw):
        header = str(section.get("header") or "")
        if header and ungrounded_tokens(header, evidence_norm):
            dropped.append({"line": header, "tokens": ungrounded_tokens(header, evidence_norm), "why": "unsourced detail in a heading"})
            continue
        # The APIs section is held to the stricter rule: a signature has to be
        # the one the documentation actually shows.
        verbatim = section["key"] == "api"
        lines: list[str] = []
        for line in section["lines"]:
            missing = ungrounded_tokens(line, evidence_norm)
            if missing:
                dropped.append({"line": line, "tokens": missing, "why": "not in the gathered sources"})
                continue
            # `normalise` strips punctuation, so a bare ``` fence normalises to ""
            # and would pass any substring test — it has to be refused explicitly,
            # or the stored note keeps an empty code block.
            if verbatim and (not normalise(line) or normalise(line) not in evidence_norm):
                dropped.append(
                    {
                        "line": line,
                        "tokens": [],
                        "why": "not verbatim in the gathered sources (a signature must be copied)",
                    }
                )
                continue
            lines.append(line)
        if not lines and not header:
            continue
        title = str(SECTION_TITLES.get(section["key"], header or "")) if section.get("ordered") else (header or "")
        if title:
            out.append(f"## {title}")
        out.extend(lines)
        out.append("")
        kept += len(lines)
    return "\n".join(out).strip(), kept, dropped


# ─── Conflicts (pure) ───────────────────────────────────────────────────
def _assignments(text: str) -> dict[str, str]:
    """``identifier -> the first number stated near it`` in one passage."""
    out: dict[str, str] = {}
    body = str(text or "")
    for _kind, pattern in SPECIFICITY_PATTERNS:
        if _kind == "number":
            continue
        for match in pattern.finditer(body):
            window = body[match.end() : match.end() + _ASSIGN_WINDOW]
            number = re.search(r"(?<![\w.])(\d+(?:\.\d+)?)(?![\w])", window)
            if not number or _is_year(number.group(1)):
                continue
            out.setdefault(normalise(match.group(0)), f"{match.group(0)}={number.group(1)}")
    return out


#: Which kind of source outranks which when they disagree. The documentation is
#: the reference; the web is a primary source but unversioned; a project note is
#: ALC's OWN summary of things it read earlier, so it must never overrule the
#: material it was made from (a note that contradicts the live documentation is a
#: stale note, not newer news). Together with the dates this is what makes "the
#: newer source wins" safe instead of merely recent.
FAMILY_AUTHORITY: tuple[str, ...] = ("docs", "web", "note")


def _family_rank(family: str) -> int:
    try:
        return FAMILY_AUTHORITY.index(family)
    except ValueError:
        return len(FAMILY_AUTHORITY)


def detect_conflicts(passages: list[dict[str, Any]], evidence: str = "") -> list[dict[str, Any]]:
    """Same name, different values, different sources → the current one is decided.

    Two rules, in this order, because they answer different questions:

    1. **Authority** — a project note never supersedes the documentation it came
       from, and documentation outranks an undated web page. This is about what
       KIND of source each is.
    2. **Recency** — within one kind (or between two web sources), the newer date
       wins. Within a family an undated entry is the oldest, so a dated one can
       always supersede it.

    Software decides because both inputs are facts about the sources, not
    judgements about the subject. The superseded value is REPORTED, never hidden:
    a reader has to be able to see that the documentation changed.
    """
    rows: dict[str, list[dict[str, Any]]] = {}
    for passage in passages:
        source = str(passage.get("source") or "")
        date = str(passage.get("date") or "")
        family = str(passage.get("family") or "docs").strip().lower() or "docs"
        for name, assignment in _assignments(str(passage.get("text") or "")).items():
            value = assignment.split("=", 1)[1]
            rows.setdefault(name, []).append(
                {
                    "value": value,
                    "source": source,
                    "date": date,
                    "family": family,
                    "assignment": assignment,
                }
            )

    conflicts: list[dict[str, Any]] = []
    for name, entries in rows.items():
        if len({entry["value"] for entry in entries}) < 2:
            continue
        if len({entry["source"] for entry in entries}) < 2:
            continue
        by_family: dict[str, list[dict[str, Any]]] = {}
        for entry in entries:
            by_family.setdefault(entry["family"], []).append(entry)
        # Each family speaks with one voice: its newest dated entry.
        winner_family = min(by_family, key=_family_rank)
        current = sorted(by_family[winner_family], key=lambda entry: entry["date"] or "", reverse=True)[0]
        stale = sorted(
            (entry for entry in entries if entry is not current),
            key=lambda entry: (entry["date"] or "", -_family_rank(entry["family"])),
            reverse=True,
        )
        if not any(entry["value"] != current["value"] for entry in stale):
            continue  # the authoritative family already agrees with the rest
        conflicts.append(
            {
                "name": name,
                "current": current,
                "stale": stale,
                "staleValues": sorted({entry["value"] for entry in stale}),
            }
        )
    return conflicts


def conflict_block(conflicts: list[dict[str, Any]]) -> str:
    """The briefing block for a turn whose evidence contradicts itself.

    Before this existed the answering model was handed two values with their
    dates and left to sort it out, which is exactly the judgement a small model
    gets wrong. The facts are still shown — the user may need to know the
    documentation changed — but software names the one to act on.
    """
    if not conflicts:
        return ""
    lines = [
        "[ALC — SOURCES DISAGREE]",
        "These passages state different values for the same thing. The CURRENT value is "
        "already decided for you (the documentation outranks a web page, and a project "
        "note never overrules the documentation it summarises; within the same kind the "
        "newer date wins):",
        _conflict_report(conflicts),
        "INSTRUCTIONS:",
        "- Use the current value. Never present a superseded value as the answer.",
        "- If the difference matters to the user, say that the sources disagree and which "
        "one you are using — the older value may only be mentioned as outdated.",
    ]
    return "\n".join(line for line in lines if line)


def _conflict_report(conflicts: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for conflict in conflicts:
        current = conflict["current"]
        stale = conflict["stale"][0] if conflict.get("stale") else {}
        lines.append(
            f"- `{conflict['name']}`: {current['value']} "
            f"({current['source']}{', ' + current['date'] if current.get('date') else ''}) — "
            f"supersedes {stale.get('value')} "
            f"({stale.get('source')}{', ' + stale['date'] if stale.get('date') else ''})"
        )
    return "\n".join(lines)


def drop_superseded_lines(markdown: str, conflicts: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    """Remove lines that present a superseded value as if it were current.

    Grounding alone cannot catch this — both values are in the evidence. Only the
    date ordering says which one the reader should act on.
    """
    if not conflicts:
        return markdown, []
    stale: dict[str, set[str]] = {}
    current: dict[str, set[str]] = {}
    for conflict in conflicts:
        stale[conflict["name"]] = {str(value) for value in conflict.get("staleValues") or []}
        current[conflict["name"]] = {str(conflict["current"]["value"])}
    dropped: list[dict[str, Any]] = []
    out: list[str] = []
    for line in markdown.splitlines():
        line_norm = normalise(line)
        names = [name for name in stale if name in line_norm]
        hit = ""
        for name in names:
            for value in stale.get(name, set()):
                if value in line and not any(value in line for value in current.get(name, set())):
                    hit = f"{name}={value}"
                    break
            if hit:
                break
        if hit:
            dropped.append({"line": line, "tokens": [hit], "why": "states a superseded value as current"})
            continue
        out.append(line)
    return "\n".join(out), dropped


# ─── Assembly ───────────────────────────────────────────────────────────
def _bullet_lines(markdown: str, key: str) -> list[str]:
    lines: list[str] = []
    current = ""
    for line in markdown.splitlines():
        header = _HEADER_RE.match(line)
        if header:
            current = _ALIASES.get(_header_key(header.group(2)), "")
            continue
        if current == key and line.strip():
            lines.append(re.sub(r"^\s*(?:[-*+]|\d+[.)])\s+", "", line.strip()))
    return lines


def finalise(ev: TopicEvidence, raw: str, *, updated: str = "") -> StudyResult:
    """Turn the model's markdown into a grounded study body (or refuse it)."""
    evidence = ev.evidence_text()
    conflicts = detect_conflicts(ev.passages, evidence)
    markdown, kept, dropped = ground_sections(raw, evidence)
    if not markdown.strip():
        return StudyResult(False, reason="the model produced nothing that the sources support", dropped=dropped)

    markdown, superseded = drop_superseded_lines(markdown, conflicts)
    dropped = [*dropped, *superseded]
    if not markdown.strip():
        return StudyResult(False, reason="every line was dropped as unsupported", dropped=dropped)

    facts = _bullet_lines(markdown, "facts")
    overview = _bullet_lines(markdown, "overview")
    if not facts and not overview:
        return StudyResult(
            False,
            reason="the study had no grounded outline or key facts",
            dropped=dropped,
            conflicts=conflicts,
        )

    questions = _bullet_lines(markdown, "questions")[:MAX_OPEN_QUESTIONS]
    parts: list[str] = []
    # Say exactly what was verified. The grounding check covers specifics and
    # signatures; the prose sections are the model's summary and are NOT verifiable
    # against a source, so the note must not imply otherwise — a stored note that
    # overstates its own trustworthiness is worse than one that admits its limits.
    header = (
        f"_Updated {updated or 'today'} from {len(ev.sources) or 1} source(s) — "
        "identifiers, values and signatures checked against them"
    )
    if dropped:
        header += f"; {len(dropped)} unsourced line(s) removed"
    header += ". Prose is the model's summary._"
    parts.append(header)
    body = markdown
    # Replace the model's Open questions with the trimmed list, so the block stays
    # bounded no matter how chatty the model was.
    if questions:
        body = _replace_section(body, "questions", questions)
    parts.append(body.strip())
    if conflicts:
        parts.append("## Conflicting sources\n" + _conflict_report(conflicts))
    if ev.sources_line():
        parts.append(f"_Sources: {ev.sources_line()}_")
    return StudyResult(
        True,
        body="\n\n".join(part for part in parts if part).strip(),
        bullets=len(facts) + len(overview),
        dropped=dropped,
        conflicts=conflicts,
    )


def _replace_section(markdown: str, key: str, lines: list[str]) -> str:
    """Swap one section's body for ``lines``, keeping everything else in place."""
    out: list[str] = []
    found = False
    skipping = False
    for line in markdown.splitlines():
        header = _HEADER_RE.match(line)
        if header:
            if _ALIASES.get(_header_key(header.group(2))) == key:
                found = True
                skipping = True
                out.append(f"## {SECTION_TITLES[key]}")
                out.extend(lines)
                continue
            skipping = False
        elif skipping:
            continue
        out.append(line)
    if not found:
        out.append(f"## {SECTION_TITLES[key]}")
        out.extend(lines)
    return "\n".join(out)


# ─── The one model call ─────────────────────────────────────────────────
SYNTHESIS_SYSTEM = (
    "You keep durable notes for an information-gathering cycle. You are given the passages "
    "that were gathered about ONE topic. Write the note that a later session should read "
    "instead of searching again.\n"
    "Reply with plain markdown and EXACTLY these section headings, in this order:\n"
    "## What it is\n"
    "## Key facts\n"
    "## APIs and signatures\n"
    "## Pitfalls\n"
    "## Open questions\n"
    "Rules:\n"
    "- Use ONLY the passages. Never add a value, name, version, path or default that is not "
    "in them — if something is missing, that belongs under Open questions.\n"
    "- What it is: two or three sentences, no bullet list.\n"
    "- Key facts: short bullets. Copy names and values character for character.\n"
    "- APIs and signatures: copy the exact signatures as written in the passages, one per line.\n"
    "- Open questions: what the passages do NOT answer. Write \"none\" when nothing is missing.\n"
    "- Keep a heading even when you have nothing to put under it.\n"
    "- Never write the words passage, excerpt, context or text above.\n"
    "- No preamble, no closing summary, no code fence around the whole reply.\n"
)


def _prompt(ev: TopicEvidence) -> str:
    listings = "\n".join(
        f"- {item.get('source')} ({item.get('date') or 'undated'})" for item in ev.sources
    ) or "- (unknown)"
    passages = "\n\n".join(
        f"[{index}] source={item.get('source')}"
        f"{' (' + item['date'] + ')' if item.get('date') else ''}\n{str(item.get('text') or '')[:1200]}"
        for index, item in enumerate(ev.passages, start=1)
    )
    existing = ev.existing.strip()[:2000] or "none"
    return (
        f"TOPIC: {ev.topic}\n\n"
        f"SOURCES (newest first):\n{listings}\n\n"
        f"PASSAGES:\n{passages}\n\n"
        f"EXISTING NOTE (rewrite it into the same sections, keeping anything still true):\n{existing}\n\n"
        "Your markdown:"
    )


async def synthesise(ev: TopicEvidence, conn: LLMConn, *, updated: str = "") -> StudyResult:
    """One model call to write the study, then the software checks."""
    if not conn.usable:
        return StudyResult(False, reason="no model available for the internal study call")
    # Called through the module (not a module-level `from .decide import generate`)
    # so that patching decide.generate — which is how the tests script decisions —
    # covers the study call too. A bound reference silently escaped the patch.
    raw = await decide.generate(conn, SYNTHESIS_SYSTEM, _prompt(ev), max_tokens=MAX_STUDY_TOKENS)
    if not raw:
        return StudyResult(False, reason="the model returned nothing")
    result = finalise(ev, raw, updated=updated)
    log_info(
        f"[alc] Study for '{ev.topic}': ok={result.ok} bullets={result.bullets} "
        f"dropped={result.dropped_count} conflicts={len(result.conflicts)}"
        + (f" ({result.reason})" if not result.ok else "")
    )
    for entry in result.dropped[:MAX_DROPPED_RECORDS]:
        log_info(f"[alc]   dropped from the study: {entry.get('why')} — {str(entry.get('line'))[:120]}")
    return result


__all__ = [
    "FAMILY_AUTHORITY",
    "SPECIFICITY_PATTERNS",
    "SECTION_ORDER",
    "StudyResult",
    "TopicEvidence",
    "conflict_block",
    "detect_conflicts",
    "drop_superseded_lines",
    "finalise",
    "ground_sections",
    "normalise",
    "specificity_tokens",
    "synthesise",
    "ungrounded_tokens",
]
