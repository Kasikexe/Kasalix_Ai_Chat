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
    '{"keep": [{"i": 1, "why": "short reason"}], "drop": [{"i": 2, "why": "off-topic"}]}\n'
    "Rules:\n"
    "- i is the number in square brackets in the candidate list.\n"
    "- Keep at most {max_keep} — the most specific ones.\n"
    "- Drop anything off-topic, too vague to use, or a duplicate of a kept item.\n"
    "- If nothing helps, reply {\"keep\": [], \"drop\": []}.\n"
)


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
    max_keep: int = MAX_KEEP,
) -> tuple[list[dict[str, Any]], bool]:
    """Returns (decisions, used_fallback) — one entry per candidate, in order."""
    if not candidates:
        return [], False
    listing = "\n\n".join(
        f"[{i + 1}] source={candidate.get('source') or candidate.get('path') or 'unknown'}\n"
        f"{str(candidate.get('text') or '')[:900]}"
        for i, candidate in enumerate(candidates)
    )
    user = f"QUESTION: {question}\n\nCANDIDATES:\n{listing}\n\nYour JSON:"
    system = JUDGE_SYSTEM.replace("{max_keep}", str(max_keep))
    raw = await generate(conn, system, user, max_tokens=MAX_DECISION_TOKENS)
    parsed = extract_json_object(raw)
    if not parsed:
        return heuristic_judge(question, candidates, max_keep=max_keep), True

    keep_reasons: dict[int, str] = {}
    drop_reasons: dict[int, str] = {}
    for bucket, target in (("keep", keep_reasons), ("drop", drop_reasons)):
        items = parsed.get(bucket)
        if isinstance(items, dict):
            items = [items]
        if not isinstance(items, list):
            continue
        for item in items:
            if isinstance(item, int):
                index, why = item, ""
            elif isinstance(item, dict):
                index = item.get("i") or item.get("index") or item.get("id")
                why = _as_str(item.get("why") or item.get("reason"), 200)
            else:
                continue
            try:
                index = int(index) - 1
            except (TypeError, ValueError):
                continue
            if 0 <= index < len(candidates):
                target[index] = why

    if not keep_reasons and not drop_reasons:
        return heuristic_judge(question, candidates, max_keep=max_keep), True

    decisions: list[dict[str, Any]] = []
    kept = 0
    for index in range(len(candidates)):
        if index in keep_reasons and kept < max_keep:
            kept += 1
            decisions.append({"i": index, "keep": True, "reason": keep_reasons[index] or "relevant"})
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
