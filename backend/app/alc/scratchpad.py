"""ALC scratchpad — the controller's working memory for one turn.

The whole point of ALC's context management is that raw tool output never
accumulates in the model's context. It is fetched, judged, reduced to a bounded
finding, and the raw text is dropped in the same round. Four context classes
(see docs/ALC_DESIGN.md §4.4) map onto this object:

    active context          -> render() (goal + questions + findings + gaps)
    retrieved information   -> Finding (bounded chars, with its source)
    no longer needed        -> rejected / dropped (metadata only, never re-injected)
    persistent knowledge    -> Phase 2 (ALC/knowledge in the workspace)
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

# One finding is a bounded excerpt, not a document: ~800 chars is enough for
# the model to judge and reuse, and small enough that ten of them still fit a
# 1.7B model's context next to the conversation.
MAX_FINDING_CHARS = 800
DEFAULT_BUDGET_TOKENS = 4000
MAX_FINDINGS = 24

#: How many of an open question's distinctive terms a passage must carry before
#: it can count as an answer. Two, because a question is phrased with verbs the
#: answer does not repeat ("how do I HANDLE pygame key events" vs "read pygame
#: key events") — a ratio would fail on that while a word-count floor accepts it.
#: A question with fewer distinctive terms than this needs all of them.
COVERAGE_MIN_TERMS = 2

#: Questions that ask for a VALUE cannot be "covered" by prose that merely uses
#: the same words: the multi-hop shape this guards against is a passage naming the
#: subject ("Vintra has a configurable pace") while the value lives in the next
#: file. A procedure question ("how do I handle key events") IS answered by the
#: passage that describes it, so it needs no number to count as covered.
_VALUE_SEEKING_RE = re.compile(
    r"\b(?:defaults?|values?|numbers?|counts?|quota|limits?|max(?:imum)?|min(?:imum)?|"
    r"version|size|length|price|cost|caps?|rates?|paces?|frames?|tokens?|seconds?|"
    r"milliseconds?|ms|date|how (?:many|much|long|often|fast|old)|which (?:number|version))\b",
    re.IGNORECASE,
)

_QUESTION_STOPWORDS = {
    "the", "and", "for", "with", "that", "this", "from", "what", "which", "when",
    "where", "does", "did", "are", "was", "were", "you", "your", "can", "could",
    "should", "would", "have", "has", "had", "not", "but", "use", "using", "about",
    "there", "their", "them", "then", "than", "also", "into", "how", "why", "many",
    "much", "there", "its", "name", "value", "tell", "give", "please",
}


def question_terms(question: str) -> list[str]:
    """The distinctive words of an open question (what a passage must mention)."""
    terms: list[str] = []
    for token in re.findall(r"[A-Za-z0-9_]{4,}", str(question or "").lower()):
        if token in _QUESTION_STOPWORDS or token in terms:
            continue
        terms.append(token)
    return terms


def estimate_tokens(text: str) -> int:
    """Same heuristic as the pipeline/agent (≈4 chars per token)."""
    return max(1, (len(text) + 3) // 4)


def normalize_query(query: str) -> str:
    """Dedupe key for queries: casing, spacing and punctuation must not matter."""
    text = " ".join(str(query or "").split()).strip().strip("\"'").lower()
    return text.rstrip(" ?!.,;:")


def _clip(text: str, limit: int = MAX_FINDING_CHARS) -> str:
    text = " ".join(str(text or "").split()).strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "…"


@dataclass
class Finding:
    """One piece of retained information, always with its provenance."""

    source: str
    text: str
    query: str = ""
    score: float = 0.0
    data: dict[str, Any] = field(default_factory=dict)

    def key(self) -> str:
        return f"{self.source}|{_clip(self.text, 96).lower()}"


@dataclass
class Scratchpad:
    goal: str = ""
    questions: list[str] = field(default_factory=list)
    # What the project already knows (Koding only): topic -> note count. A small
    # model will not think to search a store it does not know exists.
    knowledge_topics: list[dict[str, Any]] = field(default_factory=list)
    findings: list[Finding] = field(default_factory=list)
    rejected: list[dict[str, str]] = field(default_factory=list)
    dropped: list[Finding] = field(default_factory=list)
    gaps: list[str] = field(default_factory=list)
    queries: list[str] = field(default_factory=list)
    # Tools that produced nothing this turn. A small model will happily ask the
    # same empty source again; the controller uses this to fall back to a source
    # that has not been tried (see _gather).
    failed_sources: list[str] = field(default_factory=list)
    cycles: int = 0
    tool_calls: int = 0
    #: Whether contradictions in this turn's evidence are resolved in software
    #: before the model answers (D13). On by default; the eval harness turns it
    #: off to measure what it is worth, and nothing in the UI exposes it.
    conflict_guard: bool = True

    # ── mutation ────────────────────────────────────────────────────────
    def add_question(self, question: str) -> None:
        q = " ".join(str(question or "").split()).strip()
        if q and q not in self.questions:
            self.questions.append(q)

    def set_knowledge_topics(self, topics: list[dict[str, Any]]) -> None:
        self.knowledge_topics = list(topics or [])[:20]

    def note_query(self, query: str, tool: str = "") -> None:
        key = self._query_key(query, tool)
        if key and key not in self.queries:
            self.queries.append(key)

    def has_query(self, query: str, tool: str = "") -> bool:
        """True when this exact lookup was already made against this source.

        Tracked PER SOURCE on purpose: asking the documentation and then the
        project knowledge with the same question is normal retrieval, and a
        global dedupe would forbid the second — which is how a cycle that missed
        the documentation answer failed to find the same fact in project notes.
        """
        return self._query_key(query, tool) in self.queries

    @staticmethod
    def _query_key(query: str, tool: str = "") -> str:
        normalized = normalize_query(query)
        if not normalized:
            return ""
        return f"{tool}:{normalized}" if tool else normalized

    def add_finding(
        self,
        *,
        source: str,
        text: str,
        query: str = "",
        score: float = 0.0,
        data: dict[str, Any] | None = None,
        limit: int | None = None,
    ) -> Finding | None:
        """Keep one piece of information. Returns None when it is a duplicate.

        ``limit`` exists for findings that were widened to include a neighbouring
        section of the same document: the whole point of that widening is that
        both halves of a multi-hop answer survive in one finding, and clipping it
        back to the default length would cut off the half that was just fetched.
        """
        clipped = _clip(text, limit or MAX_FINDING_CHARS)
        if not clipped:
            return None
        finding = Finding(
            source=str(source or "unknown"),
            text=clipped,
            query=query,
            score=float(score or 0.0),
            data=dict(data or {}),
        )
        existing = {f.key() for f in self.findings}
        if finding.key() in existing:
            return None
        self.findings.append(finding)
        while len(self.findings) > MAX_FINDINGS:
            self._drop(self.findings.pop(0), "over the finding limit")
        return finding

    def add_reject(self, source: str, reason: str) -> None:
        """Remember what was discarded so it is not fetched and re-judged."""
        entry = {"source": str(source or "unknown"), "reason": str(reason or "")}
        if entry not in self.rejected:
            self.rejected.append(entry)

    def mark_failed(self, tool_name: str) -> None:
        name = str(tool_name or "").strip()
        if name and name not in self.failed_sources:
            self.failed_sources.append(name)

    def add_gap(self, gap: str) -> None:
        g = " ".join(str(gap or "").split()).strip()
        if g and g not in self.gaps:
            self.gaps.append(g)

    def _drop(self, finding: Finding, reason: str) -> None:
        self.dropped.append(finding)
        self.add_reject(finding.source, reason)

    def prune(self, max_tokens: int = DEFAULT_BUDGET_TOKENS) -> int:
        """Shrink to the token budget, cheapest findings first. Returns tokens after."""
        while len(self.findings) > 1 and self.tokens() > max_tokens:
            # Drop the least useful: lowest judge score, oldest on a tie.
            worst = min(range(len(self.findings)), key=lambda i: (self.findings[i].score, i))
            self._drop(self.findings.pop(worst), "dropped to stay inside the context budget")
        return self.tokens()

    # ── rendering ───────────────────────────────────────────────────────
    def tokens(self) -> int:
        return estimate_tokens(self.render())

    def render(self) -> str:
        """The controller's own view of the turn — what it feeds the model."""
        lines: list[str] = []
        lines.append(f"TASK: {self.goal or '(unknown)'}")
        if self.questions:
            lines.append("")
            lines.append("OPEN QUESTIONS:")
            lines.extend(f"- {q}" for q in self.questions)
        if self.knowledge_topics:
            lines.append("")
            lines.append(
                "PROJECT KNOWLEDGE ALREADY STORED for this project "
                "(search it with knowledge_search before using the web):"
            )
            for topic in self.knowledge_topics:
                lines.append(f"- {topic.get('topic') or topic.get('title')} ({topic_shape(topic)})")

        if self.findings:
            lines.append("")
            lines.append(
                "GATHERED INFORMATION (already available — do not fetch it again, and "
                "where two passages disagree the newer date wins):"
            )
            for i, f in enumerate(self.findings, start=1):
                lines.append(f"[{i}] ({_source_label(f)}) {f.text}")
        if self.failed_sources:
            lines.append("")
            lines.append(
                "SOURCES THAT CAME UP EMPTY (do not ask these again): "
                + ", ".join(self.failed_sources)
            )
        if self.rejected:
            lines.append("")
            lines.append("ALREADY REJECTED (off-topic, empty or duplicate — do not fetch again):")
            for r in self.rejected[-8:]:
                lines.append(f"- {r['source']} — {r['reason']}")
        if self.gaps:
            lines.append("")
            lines.append("UNRESOLVED GAPS:")
            lines.extend(f"- {g}" for g in self.gaps)
        if self.queries:
            lines.append("")
            lines.append("QUERIES ALREADY TRIED: " + " | ".join(self.queries[-12:]))
        return "\n".join(lines)

    def passages(self) -> list[dict[str, Any]]:
        """The findings as conflict-detection input, each tagged with its family.

        The family is what keeps "the newer source wins" honest: a note written
        today is not a newer version of the documentation it summarised, and a
        web page fetched today is not newer than the file it disagrees with.
        """
        return [
            {
                "source": f.source,
                "text": f.text,
                "date": str(f.data.get("date") or ""),
                "family": family_of(f.source),
            }
            for f in self.findings
        ]

    def conflicts(self) -> list[dict[str, Any]]:
        """Contradictions inside this turn's own evidence, with a winner."""
        from . import study as alc_study  # lazy: study imports decide imports this

        return alc_study.detect_conflicts(self.passages())

    def covered(self) -> bool:
        """Whether every open question is answered well enough to stop gathering.

        A question counts as covered only when a finding mentions most of its
        distinctive words AND asserts a value — prose that merely repeats the
        question is not an answer. Anything unresolved (a gap, an empty source)
        keeps the cycle going, and the caller never stops before the second
        cycle, so one lucky first search cannot end the turn.
        """
        if not self.findings or self.gaps:
            return False
        questions = self.questions or ([self.goal] if self.goal else [])
        if not questions:
            return False
        for question in questions:
            terms = question_terms(question)
            if not terms:
                return False
            needs_value = bool(_VALUE_SEEKING_RE.search(question))
            if not any(_covers(f.text, terms, needs_value=needs_value) for f in self.findings):
                return False
        return True

    def to_briefing(self) -> str:
        """What the acting phase receives: the findings, not the bookkeeping."""
        if not self.findings:
            return ""
        lines = [
            "[ALC — INFORMATION GATHERED IN THIS CYCLE]",
            "The following was retrieved before answering. It is not a summary and not a "
            "suggestion: it is the evidence for this turn.",
            "",
        ]
        for i, f in enumerate(self.findings, start=1):
            lines.append(f"[{i}] ({_source_label(f)})")
            lines.append(f.text)
            lines.append("")
        # Decided by software BEFORE the model sees it: the answering model was
        # previously handed two contradicting values and their dates and expected
        # to work out which to use, which is the judgement a 1.7B model loses.
        from . import study as alc_study  # lazy: study imports decide imports this

        block = alc_study.conflict_block(self.conflicts()) if self.conflict_guard else ""
        if block:
            lines.append(block)
            lines.append("")
        lines.append("INSTRUCTIONS:")
        lines.append("- Answer the user's question using this information as your primary source of truth.")
        lines.append("- Cite the source of a specific fact only when it is useful to the user.")
        lines.append("- Do not invent versions, numbers, dates or APIs that are not here or in the user's message.")
        if self.gaps:
            lines.append(
                "- These could not be resolved: " + "; ".join(self.gaps) + ". Say so plainly "
                "instead of guessing."
            )
        return "\n".join(lines)

    def summary(self) -> dict[str, Any]:
        return {
            "cycles": self.cycles,
            "toolCalls": self.tool_calls,
            "findings": len(self.findings),
            "rejected": len(self.rejected),
            "gaps": list(self.gaps),
            "knowledgeTopics": len(self.knowledge_topics),
            "tokens": self.tokens(),
        }


def family_of(source: str) -> str:
    """Which kind of source a finding came from: docs, web or a project note."""
    text = str(source or "")
    if text.startswith("knowledge:"):
        return "note"
    if text.startswith("web:"):
        return "web"
    return "docs"


def _covers(text: str, terms: list[str], *, needs_value: bool) -> bool:
    """A passage mentions the question's subject — and states a value if one is asked for."""
    from .verify import claim_tokens  # lazy: verify imports study imports decide

    lowered = " ".join(str(text or "").lower().split())
    hits = sum(1 for term in terms if term in lowered)
    if hits < min(COVERAGE_MIN_TERMS, len(terms)):
        return False
    return bool(claim_tokens(text)) if needs_value else True


def _source_label(finding: Finding) -> str:
    """``source``, plus when it was written/fetched when that is known.

    The web label says "fetched" rather than "updated" on purpose: a page fetched
    now has not changed now, and calling that an update would make any web page
    look newer than every local document.
    """
    date = str(finding.data.get("date") or "")
    if date:
        word = "fetched" if family_of(finding.source) == "web" else "updated"
        return f"{finding.source}, {word} {date}"
    fetched = str(finding.data.get("fetchedOn") or "")
    if fetched and family_of(finding.source) == "web":
        return f"{finding.source}, fetched {fetched} (publication date unknown)"
    return finding.source


def topic_shape(topic: dict[str, Any]) -> str:
    """How a stored topic is described to the model: notes, a study, or both."""
    notes = int(topic.get("notes") or 0)
    studies = int(topic.get("studies") or 0)
    parts: list[str] = []
    if notes:
        parts.append(f"{notes} note{'s' if notes != 1 else ''}")
    if studies:
        parts.append("a study")
    return ", ".join(parts) or "empty"


def looks_like_greeting(text: str) -> bool:
    """Tiny guard used by the heuristic fallback paths (not a router)."""
    return bool(
        re.fullmatch(
            r"(hi|hey|hello|yo|thanks|thank you|ok|okay|k|cool|nice|great|bye|good (morning|night))[!. ]*",
            (text or "").strip().lower(),
        )
    )
