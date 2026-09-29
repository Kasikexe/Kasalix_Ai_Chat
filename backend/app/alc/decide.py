"""ALC decisions — the three structured questions the controller asks the model.

Every decision is a tiny JSON contract answered by a NON-STREAMED internal call
(no thinking, small token cap). A 1.7B model will sometimes answer with prose,
truncated JSON or nothing at all, so each decision also has a software heuristic
fallback: the cycle degrades instead of dying (docs/ALC_DESIGN.md D3).

    analyze_task   -> what is the task, is external information needed, what to find out
    choose_action  -> fetch something (which tool, which args) or act now
    judge_results  -> which retrieved chunks actually help, and why
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from ..logger import info as log_info
from ..ollama_client import StreamOptions, stream_chat
from .scratchpad import Scratchpad, looks_like_greeting

MAX_DECISION_TOKENS = 320
MAX_KEEP = 4


@dataclass
class LLMConn:
    """Everything needed for one internal ALC model call."""

    model: str
    signal: Any = None
    base_url: str | None = None
    api_key: str | None = None
    temperature: float = 0.2
    think: bool = False

    @property
    def usable(self) -> bool:
        return bool(self.model)


# ─── JSON plumbing ──────────────────────────────────────────────────────
_FENCE_RE = re.compile(r"```(?:json)?\s*(.+?)```", re.DOTALL)


def _balanced_object(text: str, start: int) -> str | None:
    """The substring from ``start`` to its matching '}': strings and escapes aware."""
    depth = 0
    in_string = False
    escaped = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None


def _loads_lenient(candidate: str) -> dict[str, Any] | None:
    for attempt in (candidate, re.sub(r",\s*([}\]])", r"\1", candidate)):
        try:
            parsed = json.loads(attempt)
        except (ValueError, TypeError):
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def extract_json_object(text: str) -> dict[str, Any] | None:
    """Find the first JSON object in a model reply, tolerating fences and chatter."""
    if not text:
        return None
    stripped = text.strip()
    fence = _FENCE_RE.search(stripped)
    if fence:
        stripped = fence.group(1).strip()
    for match in re.finditer(r"\{", stripped):
        candidate = _balanced_object(stripped, match.start())
        if not candidate:
            continue
        parsed = _loads_lenient(candidate)
        if parsed is not None:
            return parsed
    return None


def _as_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "yes", "y", "1", "needed"}:
            return True
        if lowered in {"false", "no", "n", "0", "not needed"}:
            return False
    return default


def _as_str(value: Any, limit: int = 400) -> str:
    if value is None:
        return ""
    return " ".join(str(value).split())[:limit]


def _as_str_list(value: Any, limit: int = 3, item_limit: int = 200) -> list[str]:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for item in value:
        if isinstance(item, dict):
            item = item.get("question") or item.get("q") or item.get("text")
        text = _as_str(item, item_limit)
        if text and text not in out:
            out.append(text)
    return out[:limit]


# ─── Model call ─────────────────────────────────────────────────────────
async def generate(conn: LLMConn, system: str, user: str, *, max_tokens: int = MAX_DECISION_TOKENS) -> str:
    """One internal, non-streamed completion. Returns '' when the model fails."""
    if not conn.usable:
        return ""
    chunks: list[str] = []
    try:
        await stream_chat(
            conn.model,
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            chunks.append,
            StreamOptions(
                signal=conn.signal,
                temperature=conn.temperature,
                max_tokens=max_tokens,
                think=conn.think,
                base_url=conn.base_url,
                api_key=conn.api_key,
            ),
        )
    except Exception as e:  # noqa: BLE001
        log_info(f"[alc] Internal call failed ({type(e).__name__}: {e}) — using the heuristic fallback")
        return ""
    return "".join(chunks).strip()


# ─── 1. Intake ──────────────────────────────────────────────────────────
INTAKE_SYSTEM = (
    "You are the planning step of an information-gathering cycle. Before anything is "
    "answered, decide whether external information is needed and what to look for.\n"
    "Reply with ONLY one JSON object — no markdown, no explanation:\n"
    '{"goal": "<one sentence: what the user actually wants>", "needs_info": true, '
    '"questions": ["<what must be looked up>"]}\n'
    "Rules:\n"
    "- needs_info is false ONLY when no lookup can help: small talk, thanks, rewriting or "
    "formatting text that is already given, an opinion, or a question about this conversation.\n"
    "- needs_info is true when the answer depends on facts, APIs, versions, syntax, docs, "
    "errors, prices, or anything that can be looked up.\n"
    "- questions: 0-3 short search questions, most important first. Use the words that would "
    "appear in the documentation (not 'how do I', but 'pygame key events').\n"
)

_INFO_TRIGGERS = re.compile(
    r"\?|\b(pygame|tkinter|docs?|documentation|api|error|exception|install|pip|npm|import|"
    r"how (do|to|can)|why|what is|what's|which|version|release|library|module|package|"
    r"framework|syntax|example|tutorial|config|configure|setup|usage|latest|price|license|"
    r"compatible|support|deprecated|migrate|upgrade)\b",
    re.IGNORECASE,
)


def heuristic_intake(text: str) -> dict[str, Any]:
    """What to do when the model's intake answer cannot be parsed."""
    trimmed = " ".join(str(text or "").split()).strip()
    if not trimmed or looks_like_greeting(trimmed) or len(trimmed) < 12:
        return {"goal": trimmed, "needs_info": False, "questions": [], "fallback": True}
    needs_info = bool(_INFO_TRIGGERS.search(trimmed))
    return {
        "goal": trimmed[:300],
        "needs_info": needs_info,
        "questions": [trimmed[:200]] if needs_info else [],
        "fallback": True,
    }


async def analyze_task(text: str, conn: LLMConn) -> dict[str, Any]:
    prompt = f"TASK: {text[:1500]}"
    raw = await generate(conn, INTAKE_SYSTEM, prompt, max_tokens=256)
    parsed = extract_json_object(raw)
    if not parsed:
        return heuristic_intake(text)
    goal = _as_str(parsed.get("goal"), 300) or _as_str(text, 300)
    questions = _as_str_list(parsed.get("questions"))
    needs_info = _as_bool(parsed.get("needs_info"), default=bool(questions))
    if not questions and needs_info:
        questions = [_as_str(text, 200)]
    return {
        "goal": goal,
        "needs_info": needs_info and bool(questions),
        "questions": questions,
        "fallback": False,
    }


# ─── 2. Gather or act ───────────────────────────────────────────────────
# The example strings here are PLACEHOLDERS on purpose. A 1.7B model copies a
# realistic example straight out of its prompt and returns it as its own query,
# which produced a cycle that searched the prompt's sample text on every task.
# The angle brackets also let the controller detect an echoed example.
ACTION_SYSTEM = (
    "You control an information-gathering cycle for a small local model. You decide, one "
    "step at a time, whether to fetch more information or to act with what is already known.\n"
    "Reply with ONLY one JSON object — no markdown, no explanation:\n"
    '{"action": "tool", "tool": "docs_search", "args": {"query": "<your search terms>"}, '
    '"reason": "why this helps"}\n'
    'or {"action": "act", "reason": "why the current information is enough", "gaps": []}\n'
    "Rules:\n"
    "- Choose a tool when an OPEN QUESTION is still unanswered AND one of the tools can answer it.\n"
    "- Choose act when the gathered information covers the task, or when nothing available "
    "can close the remaining gap.\n"
    "- The <angle-bracket> text in an example is a placeholder — NEVER send it back as your "
    "answer. Write the actual query for THIS task.\n"
    "- If the notes list PROJECT KNOWLEDGE for this project, search THAT first: an earlier "
    "session may already have the answer, and it is cheaper than the documentation.\n"
    "- NEVER repeat a query already listed as tried, and never re-fetch something already "
    "rejected.\n"
    "- Use one tool call per step. Prefer the documentation over the web when both could work.\n"
    "- args must match the tool's example exactly in shape.\n"
)


# Cheapest source first: a project note is better than a document scan, and both
# beat the live web.
SEARCH_PRIORITY = ("knowledge_search", "docs_search", "web_search")


def heuristic_action(pad: Scratchpad, tools: list[dict[str, Any]]) -> dict[str, Any]:
    """Fallback when the model's decision is unusable: ask the next source.

    Walks the sources in priority order, skipping any that has already come up
    empty, and asks each the first open question it has not been asked yet. This
    is the software carrying the load a small model drops (docs/ALC_DESIGN.md D3).
    """
    for name in SEARCH_PRIORITY:
        if name in pad.failed_sources:
            continue
        if not any(tool["name"] == name for tool in tools):
            continue
        for candidate in [*pad.questions, pad.goal]:
            query = " ".join(str(candidate or "").split()).strip()
            # A degenerate query (one stray character) would search for noise AND
            # be recorded as "already tried", poisoning the rest of the cycle.
            if len(query) < 4 or pad.has_query(query, name):
                continue
            return {
                "action": "tool",
                "tool": name,
                "args": {"query": query, "k": 4},
                "reason": f"heuristic: asking {name} something it has not been asked yet",
                "gaps": [],
                "fallback": True,
            }
    return {
        "action": "act",
        "tool": "",
        "args": {},
        "reason": "heuristic: no source left to ask",
        "gaps": list(pad.gaps),
        "fallback": True,
    }


def _tool_names(tools: list[dict[str, Any]]) -> set[str]:
    return {str(tool.get("name")) for tool in tools}


async def choose_action(
    pad: Scratchpad,
    tools: list[dict[str, Any]],
    conn: LLMConn,
    tool_spec: str,
) -> dict[str, Any]:
    user = f"AVAILABLE TOOLS:\n{tool_spec}\n\nWORKING NOTES:\n{pad.render()}\n\nYour JSON:"
    raw = await generate(conn, ACTION_SYSTEM, user, max_tokens=MAX_DECISION_TOKENS)
    parsed = extract_json_object(raw)
    if not parsed:
        return heuristic_action(pad, tools)
    action = _as_str(parsed.get("action"), 20).lower()
    reason = _as_str(parsed.get("reason"), 300)
    gaps = _as_str_list(parsed.get("gaps"), limit=3)
    if action.startswith("act"):
        return {"action": "act", "tool": "", "args": {}, "reason": reason, "gaps": gaps, "fallback": False}
    tool = _as_str(parsed.get("tool"), 40)
    args = parsed.get("args") if isinstance(parsed.get("args"), dict) else {}
    if not tool or tool not in _tool_names(tools):
        # The model named a tool that does not exist (or is not available this
        # turn) — fall back rather than loop. Its own intent is kept alongside the
        # fallback's reason: overwriting the reason made the event stream claim
        # "searching…" on a turn that actually decided to act.
        fallback = heuristic_action(pad, tools)
        fallback["requested"] = {"tool": tool, "reason": reason}
        return fallback
    return {"action": "tool", "tool": tool, "args": args, "reason": reason, "gaps": gaps, "fallback": False}


# ─── 3. Relevance judging ───────────────────────────────────────────────
JUDGE_SYSTEM = (
    "You judge retrieved text for one question. Keep only what genuinely helps answer it.\n"
    "Reply with ONLY one JSON object — no markdown, no explanation:\n"
    '{"keep": [{"i": 1, "quote": "words copied from candidate 1", "why": "short reason"}], '
    '"drop": [{"i": 2, "why": "off-topic"}]}\n'
    "Rules:\n"
    "- i is the number in square brackets in the candidate list.\n"
    "- Keep at most {max_keep} — the most specific ones.\n"
    "- quote must be copied CHARACTER FOR CHARACTER from that candidate. A keep with a quote "
    "that is not in the candidate is thrown away, so never invent one.\n"
    "- Keep a passage that DISAGREES with another candidate instead of filing it as a "
    "duplicate — both are needed to tell which value is current.\n"
    "- A candidate that helps answer the USER'S QUESTION is relevant even when it does "
    "not match the lookup's wording.\n"
    "- Drop anything off-topic, too vague to use, or a true duplicate of a kept item.\n"
    "- If nothing helps, reply {\"keep\": [], \"drop\": []}.\n"
)


def _normalise_ws(text: str) -> str:
    return " ".join(str(text or "").lower().split())


def quote_supported(quote: str, text: str) -> bool:
    """Whether a judge's quote really came from the candidate it cites.

    A fabricated citation is worse than a missing one: it makes the reasoning
    look grounded while the passage says something else. Software checks it
    because the model cannot (docs/ALC_DESIGN.md §4.8).
    """
    needle = _normalise_ws(quote)[:120]
    if len(needle) < 8:
        return False
    return needle in _normalise_ws(text)


#: Identifier shapes that make a term decisive: when the question itself names
#: one, a passage containing it is evidence rather than noise (D16).
ANCHOR_KINDS = ("snake", "const", "dotted", "code", "path")


def question_anchors(question: str) -> list[str]:
    """The exact identifiers a question names — `vintra_pace_default`, `QUORVEX-4513`.

    A small judge throws away the passage that holds the answer often enough to
    matter. Measured on the `vintra-pace` case: the file naming the current value
    was dropped as "off-topic" while an older, contradictory file was kept — on
    the shipped arm *and* on the ablation of the guarantee meant to catch it.
    A question naming `vintra_pace_default` is proof that a passage containing it
    is on-topic, and that is something software can check without judging content,
    which is why it does. Every other call stays the model's.
    """
    from .study import SPECIFICITY_PATTERNS  # local: study imports this module

    found: list[str] = []
    for kind, pattern in SPECIFICITY_PATTERNS:
        if kind not in ANCHOR_KINDS:
            continue
        for match in pattern.finditer(str(question or "")):
            token = match.group(0).strip("._")
            if len(token) < 4:
                continue
            if token not in found:
                found.append(token)
    return found


def anchor_in(question: str, text: str) -> str:
    """The identifier the question names that this passage contains, or ""."""
    body = str(text or "")
    for anchor in question_anchors(question):
        if anchor in body:
            return anchor
    return ""


#: Capitalised words that name nothing: they are capitalised by grammar, or they
#: are so common in questions that matching on them would mean nothing.
_GENERIC_CAPITALS = {
    "i",
    "the",
    "this",
    "that",
    "then",
    "also",
    "note",
    "yes",
    "no",
}
_SUBJECT_RE = re.compile(r"\b[A-Z][A-Za-z0-9_]{2,}\b")
_SENTENCE_END_RE = re.compile(r"(?:^|[.!?]\s|\n\s*)\s*$")


def named_subjects(text: str, *, first_word_counts: bool = False) -> list[str]:
    """Proper names a text uses, ignoring the capitalised first word of a sentence.

    "What does Halyard\u2026" names one subject, not two: the first word is capitalised
    because it starts the sentence. Mid-sentence capitals are names (`Halyard`,
    `Quorvex`), which is exactly the signal needed to tell whether a passage is
    even *about* the thing that was asked (see :func:`off_subject`). A *heading*
    is a title rather than a sentence, so its first word does count — that is what
    ``first_word_counts`` is for.
    """
    body = str(text or "")
    found: list[str] = []
    for match in _SUBJECT_RE.finditer(body):
        if not first_word_counts and _SENTENCE_END_RE.search(body[: match.start()]):
            continue
        token = match.group(0)
        if token.lower() in _GENERIC_CAPITALS or token in found:
            continue
        found.append(token)
    return found


def off_subject(question: str, candidate: dict[str, Any]) -> str:
    """The subject a passage is about when it is *not* the one the question names.

    A question that names a thing is about that thing, and a passage that mentions
    a different name and never the one asked about is not evidence for it.
    Measured live, on a held-out case: `halyard-config.md` (Halyard's 240) was
    retrieved for a question about Brimwall's ceiling, and the answering model
    reported Halyard's value as Brimwall's. No answer check can catch that, because
    the number really is in the gathered evidence — the only honest fix is not to
    hand it over in the first place.

    Returns "" when the question names nothing (`named_subjects` is empty), when
    the passage mentions the question's subject, or when the passage names nothing
    at all — a note or a code block is not "about" a different thing just because
    it has no proper noun in it.
    """
    subjects = named_subjects(question)
    if not subjects:
        return ""
    # The heading is a title, so its first word names something rather than opening
    # a sentence ("Halyard config > Limits"). The file path is left out because a
    # store's own folder is not a subject (`ALC/knowledge/...`).
    body = str(candidate.get("text") or "")
    heading = str(candidate.get("heading") or "")
    present: list[str] = []
    for subject in named_subjects(body) + named_subjects(heading, first_word_counts=True):
        if subject not in present:
            present.append(subject)
    if not present:
        return ""
    lowered = f"{body}\n{heading}".lower()
    if any(subject.lower() in lowered for subject in subjects):
        return ""
    # Name the *thing* in the reason, not a symbol from it: "about Halyard" reads
    # as a decision, "about HALYARD_MAX_FRAMES" reads as a bug.
    return next(
        (token for token in present if "_" not in token and not token.isupper()),
        present[0],
    )


def dedupe_candidates(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop candidates whose opening text repeats one already listed.

    The same wording arrives from two files (a README copied into a manual) often
    enough that judging it twice wastes the judge's small budget and doubles the
    evidence the answering model has to wade through. The better-scoring copy
    wins; the kept one is preferred when the scores tie.
    """
    out: list[dict[str, Any]] = []
    seen: list[str] = []
    for candidate in candidates or []:
        head = _normalise_ws(candidate.get("text"))[:160]
        if head and any(head[:100] in existing or existing[:100] == head[:100] for existing in seen):
            continue
        if head:
            seen.append(head)
        out.append(candidate)
    return out


def _overlap_score(question: str, text: str) -> float:
    from .docs import _query_terms  # local import keeps module import costs low

    terms = [t for t in _query_terms(f"{question} {text}") if t in text.lower()]
    question_terms = _query_terms(question)
    if not question_terms:
        return 0.0
    return len({t for t in question_terms if t in text.lower()}) / len(question_terms)


def heuristic_judge(
    question: str,
    candidates: list[dict[str, Any]],
    *,
    max_keep: int = MAX_KEEP,
) -> list[dict[str, Any]]:
    """Fallback: keep the candidates that share the most terms with the question."""
    scored: list[tuple[float, int]] = []
    for index, candidate in enumerate(candidates):
        matched = candidate.get("matched")
        score = len(matched) if isinstance(matched, list) and matched else _overlap_score(
            question, str(candidate.get("text") or "")
        )
        scored.append((float(score), index))
    scored.sort(key=lambda item: item[0], reverse=True)
    keep: list[int] = []
    for score, index in scored:
        if score <= 0:
            continue
        keep.append(index)
        if len(keep) >= max_keep:
            break
    return [
        {
            "i": index,
            "keep": index in keep,
            "reason": "term overlap with the question" if index in keep else "little overlap with the question",
        }
        for index in range(len(candidates))
    ]


async def judge_results(
    question: str,
    candidates: list[dict[str, Any]],
    conn: LLMConn,
    *,
    goal: str = "",
    max_keep: int = MAX_KEEP,
) -> tuple[list[dict[str, Any]], bool]:
    """Returns (decisions, used_fallback) — one entry per candidate, in order.

    ``question`` is the lookup that produced these candidates and ``goal`` is what
    the user actually asked. The judge is given both, because a passage can answer
    the user's question without matching the wording of the sub-question the model
    chose to search: judged against the sub-question alone, evidence for the real
    question is filed as "off-topic" (measured on `vintra-pace`).
    """
    if not candidates:
        return [], False
    asked = " ".join(str(question or "").split()).strip()
    topic = " ".join(str(goal or "").split()).strip()
    #: What "relevant" is judged against: the goal, plus the lookup when it is a
    #: different question. Software decides this, so the judge cannot answer a
    #: narrower question than the user asked.
    whole = f"{topic} {asked}".strip() or asked
    header = f"USER'S QUESTION: {topic or asked}\n"
    if topic and asked and asked.lower() not in topic.lower():
        header += f"THE LOOKUP THIS TEXT CAME FROM: {asked}\n"
    listing = "\n\n".join(
        f"[{i + 1}] source={candidate.get('source') or candidate.get('path') or 'unknown'}\n"
        f"{str(candidate.get('text') or '')[:900]}"
        for i, candidate in enumerate(candidates)
    )
    user = f"{header}\nCANDIDATES:\n{listing}\n\nYour JSON:"
    system = JUDGE_SYSTEM.replace("{max_keep}", str(max_keep))
    raw = await generate(conn, system, user, max_tokens=MAX_DECISION_TOKENS)
    parsed = extract_json_object(raw)
    if not parsed:
        return heuristic_judge(whole, candidates, max_keep=max_keep), True

    keep_reasons: dict[int, str] = {}
    drop_reasons: dict[int, str] = {}
    quotes: dict[int, str] = {}
    for bucket, target in (("keep", keep_reasons), ("drop", drop_reasons)):
        items = parsed.get(bucket)
        if isinstance(items, dict):
            items = [items]
        if not isinstance(items, list):
            continue
        for item in items:
            raw_quote = ""
            if isinstance(item, int):
                index, why = item, ""
            elif isinstance(item, dict):
                index = item.get("i") or item.get("index") or item.get("id")
                why = _as_str(item.get("why") or item.get("reason"), 200)
                if bucket == "keep":
                    raw_quote = _as_str(item.get("quote"), 400)
            else:
                continue
            try:
                index = int(index) - 1
            except (TypeError, ValueError):
                continue
            if 0 <= index < len(candidates):
                target[index] = why
                if raw_quote:
                    quotes[index] = raw_quote

    if not keep_reasons and not drop_reasons:
        return heuristic_judge(whole, candidates, max_keep=max_keep), True

    decisions: list[dict[str, Any]] = []
    kept = 0
    for index in range(len(candidates)):
        wanted = index in keep_reasons
        text = str(candidates[index].get("text") or "")
        anchor = anchor_in(whole, text)
        if kept >= max_keep and (wanted or anchor):
            decisions.append({"i": index, "keep": False, "reason": "over the keep limit"})
            continue
        if wanted:
            quote = str(quotes.get(index) or "")
            verified = bool(quote) and quote_supported(quote, text)
            if quote and not verified and not anchor:
                # The citation does not exist in the passage it cites, and nothing
                # else vouches for the passage, so the model's own grounds for
                # keeping it are gone.
                decisions.append(
                    {
                        "i": index,
                        "keep": False,
                        "reason": "the quoted evidence is not in that candidate",
                        "quoteVerified": False,
                    }
                )
                continue
            kept += 1
            if quote and not verified:
                # The citation is fabricated; the passage is not. It is kept on the
                # identifier it contains, the citation is discarded, and the reason
                # says so — the answer keeps its evidence and the record keeps the
                # honesty about where it came from.
                decisions.append(
                    {
                        "i": index,
                        "keep": True,
                        "reason": f"kept — the passage contains {anchor}; the model's quote "
                        "could not be verified",
                        "quote": "",
                        "quoteVerified": False,
                    }
                )
                continue
            decisions.append(
                {
                    "i": index,
                    "keep": True,
                    "reason": keep_reasons[index] or "relevant",
                    "quote": quote,
                    "quoteVerified": verified,
                }
            )
        elif anchor:
            # The judge threw away a passage that names something the question
            # names. That is not a judgement call.
            kept += 1
            decisions.append(
                {
                    "i": index,
                    "keep": True,
                    "reason": f"kept — the passage contains {anchor}, which the question names",
                    "quote": "",
                    "quoteVerified": False,
                }
            )
        else:
            reason = drop_reasons.get(index) or "over the keep limit"
            decisions.append({"i": index, "keep": False, "reason": reason})
    return decisions, False


# ─── Query reformulation on an empty result ─────────────────────────────
def reformulate_query(query: str) -> str | None:
    """A cheaper query for the retry: drop question words, keep the specific terms."""
    from .docs import _query_terms

    terms = [t for t in _query_terms(query) if not t.endswith("ing")]
    if not terms:
        return None
    candidate = " ".join(terms[:6])
    if candidate.lower() == " ".join(_query_terms(query)[:6]).lower() and len(terms) < 2:
        return None
    return candidate if candidate.strip() and candidate.lower() != query.strip().lower() else None
