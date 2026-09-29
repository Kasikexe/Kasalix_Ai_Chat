"""ALC tools — the curated information sources the cycle may use.

Deliberately separate from both existing registries: the plugin ``ToolRegistry``
(which Normal chat can call) and ``AGENT_TOOL_DEFS`` (Koding's JSON protocol).
ALC decides *when* a source is worth asking, so its tools are advertised only
inside the cycle, with the vetoes (no search key, web disabled, off-budget)
enforced by the controller — that is what makes "only search the web when
necessary" a real rule instead of a hope (docs/ALC_DESIGN.md D6).

Every tool returns the same shape::

    {"ok": bool, "output": str, "query": str,
     "candidates": [{"source": ..., "text": ...}], "error": ...}

``candidates`` are what the judging step rates; ``output`` is a bounded
human-readable rendering used for logs and the ``alc:result`` event.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from ..logger import error as log_error, info as log_info
from . import docs
from .events import emit_alc

MAX_CANDIDATES = 6
MAX_CANDIDATE_CHARS = 1000
MAX_OUTPUT_CHARS = 6000


@dataclass
class ALCToolContext:
    """Everything a tool may need, resolved once per turn."""

    model: str = ""
    workspace: str | None = None
    roots: list[str] = field(default_factory=list)
    signal: Any = None
    web_enabled: bool = True
    # Kept so the cycle can report which engine it is running under.
    mode: str = "chat"
    allow_writes: bool = True
    opts: dict[str, Any] = field(default_factory=dict)

    @property
    def knowledge_enabled(self) -> bool:
        """Whether this turn has a project directory to remember things in.

        The condition is the WORKSPACE, not the mode. Project knowledge was
        originally Koding-only on the reasoning that "chat has no project
        directory" — but a chat conversation with a workspace attached does, and
        excluding it meant chat could never learn anything: it gathered, answered
        and kept nothing, so every later turn re-searched the same facts. That is
        the difference between a cycle and a cache, so the store is now gated on
        what is actually available (docs/ALC_DESIGN.md D8, amended in Phase 4).
        """
        return bool(self.workspace)


# ─── Tool definitions (schema + the example the model copies) ───────────
# Examples use angle-bracket placeholders, deliberately NOT realistic sample
# queries. A small model copies an example verbatim out of its own prompt: with
# a realistic example it searched "pygame key events" on every task and reported
# it as a real lookup. Placeholders are also detectable, so an echoed one is
# replaced with the actual open question (see is_placeholder).
DOCS_SEARCH = {
    "name": "docs_search",
    "description": "Search the documentation installed on this machine and return the most relevant passages. Use this before answering anything about a library, API, tool or config option. Returns short passages with the file they came from — it does NOT return whole files.",
    "args": '{"query": "<search terms>"}',
    "example": {"query": "<search terms>", "k": 4},
    "kind": "docs",
}

DOCS_OPEN = {
    "name": "docs_open",
    "description": "Read more of ONE documentation file you already found with docs_search (a passage was truncated, or you need the next part). Pass the file path from the search result and optionally the line to start from.",
    "args": '{"path": "<file path from a search result>"}',
    "example": {"path": "<file path from a search result>", "line": 1},
    "kind": "docs",
}

WEB_SEARCH = {
    "name": "web_search",
    "description": "Search the live web for current information (releases, versions, APIs, news, prices). Expensive and slow — use ONLY when the documentation on this machine cannot answer the question, or when the question is about something that changes over time.",
    "args": '{"query": "<what only the live web can answer>"}',
    "example": {"query": "<what only the live web can answer>"},
    "kind": "web",
}

READ_URL = {
    "name": "read_url",
    "description": "Fetch ONE web page and return its readable text. Use after a web search when a specific page needs to be read in full.",
    "args": '{"url": "<https://page/to/read>"}',
    "example": {"url": "<https://page/to/read>"},
    "kind": "web",
}

KNOWLEDGE_SEARCH = {
    "name": "knowledge_search",
    "description": "Search the notes ALC saved for THIS project in earlier sessions (build commands, API details, constraints, gotchas) — the ALC/knowledge folder in the workspace. Use it before the web, and before assuming the project has no notes about something.",
    "args": '{"query": "<search terms>"}',
    "example": {"query": "<search terms>", "k": 4},
    "kind": "knowledge",
}

KNOWLEDGE_WRITE = {
    "name": "knowledge_write",
    "description": "Save ONE durable fact for future sessions in this project (ALC/knowledge/<topic>.md): an API detail, a build or test command, a constraint, a gotcha. Use it when you learn something worth keeping that is NOT needed for the current answer. Never save secrets, credentials, or one-off task notes.",
    "args": '{"topic": "<short topic>", "body": "<the durable fact>", "tags": ["<tag>"]}',
    "example": {"topic": "<short topic>", "body": "<the durable fact>", "tags": ["<tag>"]},
    "kind": "knowledge",
    "mutating": True,
}

# Order matters: it is the order the tools are described to the model, and a
# small model leans toward the first plausible tool. Project knowledge comes
# before the documentation, and the documentation before the web.
ALC_TOOLS: list[dict[str, Any]] = [
    KNOWLEDGE_SEARCH,
    KNOWLEDGE_WRITE,
    DOCS_SEARCH,
    DOCS_OPEN,
    WEB_SEARCH,
    READ_URL,
]


def tool_names() -> list[str]:
    return [tool["name"] for tool in ALC_TOOLS]


def available_tools(ctx: ALCToolContext) -> list[dict[str, Any]]:
    """The tools this turn may actually use.

    Docs tools need at least one configured folder; web tools need web enabled.
    A turn with nothing available is answered directly, with a notice.
    """
    tools: list[dict[str, Any]] = []
    for tool in ALC_TOOLS:
        if tool["kind"] == "docs" and not ctx.roots:
            continue
        if tool["kind"] == "web" and not ctx.web_enabled:
            continue
        if tool["kind"] == "knowledge" and not ctx.knowledge_enabled:
            continue
        tools.append(tool)
    return tools


def tool_spec(tools: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for tool in tools:
        lines.append(f"- {tool['name']}: {tool['description']}")
        lines.append(f"  example args: {tool['args']}")
    return "\n".join(lines)


# The argument that says WHAT to look up. These are never filled from the
# tool's example: a model that returns `{"tool": "docs_search", "args": {}}`
# would otherwise search the example text from its own prompt ("pygame key
# events") and report it as a real lookup. The controller substitutes the open
# question instead.
PRIMARY_ARGS = {
    "docs_search": "query",
    "docs_open": "path",
    "knowledge_search": "query",
    "knowledge_write": "topic",
    "web_search": "query",
    "read_url": "url",
}


def make_args(tool: dict[str, Any], args: dict[str, Any]) -> dict[str, Any]:
    """The model's args, with optional fields defaulted from the tool's example."""
    merged: dict[str, Any] = {}
    for key, value in (args or {}).items():
        if value is None or value == "":
            continue
        merged[str(key)] = value
    primary = PRIMARY_ARGS.get(str(tool.get("name")), "query")
    for key, value in (tool.get("example") or {}).items():
        if key == primary or key in merged:
            continue
        merged[key] = value
    return merged


def primary_arg(tool: dict[str, Any]) -> str:
    return PRIMARY_ARGS.get(str(tool.get("name")), "query")


# "<search terms>" and friends: the model either left the field out or echoed the
# placeholder from its prompt. Both mean "no query was given".
PLACEHOLDER_RE = re.compile(r"^\s*[<\[].{0,200}[>\]]\s*$")


def is_placeholder(value: Any, tool: dict[str, Any] | None = None) -> bool:
    """True when an argument is missing or is an echoed prompt placeholder."""
    text = " ".join(str(value or "").split()).strip()
    if not text:
        return True
    if PLACEHOLDER_RE.match(text):
        return True
    if tool is not None:
        example = str((tool.get("example") or {}).get(primary_arg(tool)) or "").strip()
        if example and text.lower() == example.lower():
            return True
    return False


# ─── Dispatch ───────────────────────────────────────────────────────────
def _web_candidates(sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Web hits as candidates.

    ``date`` is the PAGE's own publication/update date when the provider gives
    one, and empty when it does not. It used to be today's date, which made every
    web page look newer than every local document and let a stale page "win" a
    conflict it should have lost. When a page IS dated the label says where the
    date came from (see scratchpad._source_label).
    """
    candidates: list[dict[str, Any]] = []
    for source in sources[:MAX_CANDIDATES]:
        url = str(source.get("url") or "")
        text = str(source.get("content") or source.get("snippet") or source.get("text") or "")
        text = " ".join(text.split())
        if not text:
            continue
        candidates.append(
            {
                "source": f"web:{url}" if url else "web",
                "text": text[:MAX_CANDIDATE_CHARS],
                "url": url,
                "title": str(source.get("title") or url),
                "date": str(source.get("published_date") or source.get("date") or "")[:10],
                "fetchedOn": _today(),
            }
        )
    return candidates


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


#: How much of a document one finding may hold once it has been widened to its
#: neighbouring chunk. Larger than ``scratchpad.MAX_FINDING_CHARS`` on purpose:
#: the point is that BOTH halves of a multi-hop answer fit in one finding.
EXPANDED_FINDING_CHARS = 1400


def expand_doc_text(
    candidate: dict[str, Any],
    *,
    query: str = "",
    max_chars: int = EXPANDED_FINDING_CHARS,
) -> str:
    """One kept documentation hit, plus the neighbouring chunk that helps most.

    Multi-hop documentation puts the name in one section and the value in the
    next, so the single chunk that matched reads as a complete answer while the
    answer is one chunk away. Only a neighbour that shares terms with the query
    is added: an unrelated adjacent section is context the model has to unlearn.

    Returns "" when there is nothing worth adding, and the caller keeps the
    original text.
    """
    path = str(candidate.get("path") or "")
    chunk_no = candidate.get("chunk")
    if not path or chunk_no is None:
        return ""
    around = docs.neighbours(path, int(chunk_no), span=1)
    if not around:
        return ""
    centre = " ".join(str(candidate.get("text") or "").split())
    terms = docs.query_terms(f"{query} {candidate.get('heading') or ''}")
    best = ""
    best_hits = 0
    for item in around:
        lowered = str(item.get("text") or "").lower()
        hits = sum(1 for term in terms if term in lowered)
        if hits > best_hits:
            best, best_hits = str(item.get("text") or ""), hits
    if not best or best_hits == 0:
        return ""
    marker = "\n[same document, adjacent section]\n"
    room = max_chars - len(marker) - len(best)
    if room < 200:
        return centre[:max_chars]
    return (centre[:room] + marker + best)[:max_chars]


async def dispatch(name: str, args: dict[str, Any], ctx: ALCToolContext) -> dict[str, Any]:
    """Run one ALC tool. Never raises — a failed tool is a gap, not an exception."""
    result: dict[str, Any] = {"ok": False, "output": "", "query": "", "candidates": [], "error": ""}
    try:
        if name == "docs_search":
            query = str(args.get("query") or "").strip()
            result["query"] = query
            if not query:
                result["error"] = "query is required"
                return result
            hits = await asyncio.to_thread(
                docs.search_docs,
                query,
                k=_as_int(args.get("k"), 4, 1, docs.MAX_RESULTS),
                roots=ctx.roots,
            )
            if not hits:
                result["error"] = f'no documentation matched "{query}"'
                return result
            result["ok"] = True
            result["candidates"] = [
                {
                    "source": hit["source"] + (f" (line {hit.get('chunk', 0)})" if hit.get("chunk") else ""),
                    "text": hit["text"][:MAX_CANDIDATE_CHARS],
                    "path": hit["path"],
                    "heading": hit.get("heading") or "",
                    # So the briefing can say WHEN a passage was written — the
                    # only way to settle two sources that disagree.
                    "date": docs.source_date(str(hit.get("path") or "")),
                    # Which chunk of the file, so a kept hit can be widened to its
                    # neighbouring chunk (expand_doc_text).
                    "chunk": hit.get("chunk"),
                    "score": hit.get("score") or 0.0,
                    "matched": hit.get("matched") or [],
                }
                for hit in hits[:MAX_CANDIDATES]
            ]
            result["output"] = "\n\n".join(
                f"{candidate['source']}: {candidate['text'][:600]}" for candidate in result["candidates"]
            )[:MAX_OUTPUT_CHARS]
            return result

        if name == "docs_open":
            path = str(args.get("path") or "").strip()
            opened = await asyncio.to_thread(
                docs.open_doc,
                path,
                line=_as_int(args.get("line"), 1, 1, 10_000_000),
                max_chars=MAX_OUTPUT_CHARS,
                roots=ctx.roots,
            )
            if not opened.get("ok"):
                result["error"] = str(opened.get("error") or "could not read that file")
                return result
            text = " ".join(str(opened.get("text") or "").split())
            result["ok"] = True
            result["query"] = path
            result["candidates"] = [
                {"source": opened["source"], "text": text[:MAX_CANDIDATE_CHARS], "path": path}
            ]
            result["output"] = text[:MAX_OUTPUT_CHARS]
            return result

        if name == "web_search":
            from ..search import search_web

            query = str(args.get("query") or "").strip()
            result["query"] = query
            if not query:
                result["error"] = "query is required"
                return result
            outcome = await search_web(query)
            candidates = _web_candidates(list(outcome.sources or []))
            if not candidates and outcome.context:
                candidates = [{"source": f"web:{query}", "text": outcome.context[:MAX_CANDIDATE_CHARS]}]
            if not candidates:
                tried = ", ".join(f'"{a}"' for a in (outcome.attempts or [query]))
                result["error"] = f"the web search returned nothing usable (tried {tried})"
                return result
            result["ok"] = True
            result["candidates"] = candidates
            result["output"] = " ".join(str(outcome.context or "").split())[:MAX_OUTPUT_CHARS]
            return result

        if name == "knowledge_search":
            from . import knowledge

            query = str(args.get("query") or "").strip()
            result["query"] = query
            if not query:
                result["error"] = "query is required"
                return result
            hits = await asyncio.to_thread(
                knowledge.search,
                ctx.workspace,
                query,
                k=_as_int(args.get("k"), 4, 1, 10),
            )
            if not hits:
                known = await asyncio.to_thread(knowledge.stats, ctx.workspace)
                result["error"] = (
                    f'no project notes matched "{query}"'
                    + ("" if known.get("known") else " (nothing has been saved for this project yet)")
                )
                return result
            result["ok"] = True
            result["candidates"] = [
                {
                    "source": hit["source"],
                    "text": str(hit["text"])[:MAX_CANDIDATE_CHARS],
                    "path": hit.get("path") or "",
                    "date": str(hit.get("date") or ""),
                    "score": hit.get("score") or 0.0,
                    "matched": hit.get("matched") or [],
                }
                for hit in hits[:MAX_CANDIDATES]
            ]
            result["output"] = "\n\n".join(
                f"{candidate['source']}: {candidate['text'][:600]}" for candidate in result["candidates"]
            )[:MAX_OUTPUT_CHARS]
            return result

        if name == "knowledge_write":
            from . import knowledge

            topic = str(args.get("topic") or "").strip()
            body = str(args.get("body") or "").strip()
            result["query"] = topic or body[:80]
            if not ctx.allow_writes:
                result["error"] = "this session is read-only — nothing was saved"
                return result
            if not topic or not body:
                result["error"] = "both topic and body are required"
                return result
            saved = await asyncio.to_thread(
                knowledge.remember,
                ctx.workspace,
                topic,
                body,
                tags=args.get("tags") or [],
                source="alc",
            )
            result["ok"] = bool(saved.get("ok"))
            result["saved"] = saved
            result["error"] = "" if saved.get("ok") else str(saved.get("reason") or "could not save")
            if saved.get("written"):
                result["output"] = f'saved to project knowledge as "{saved.get("topic")}"'
            elif saved.get("ok"):
                result["output"] = "already in project knowledge — nothing to add"
            return result

        if name == "read_url":
            # Same fetcher the Koding agent's read_url tool uses, so extraction
            # behaviour is identical between engines.
            from ..search import _fetch_page_content

            url = str(args.get("url") or "").strip()
            result["query"] = url
            if not url.lower().startswith(("http://", "https://")):
                result["error"] = "url must start with http:// or https://"
                return result
            text = await _fetch_page_content(url, 8000)
            if not text:
                result["error"] = f"could not read {url}"
                return result
            clean = " ".join(text.split())
            result["ok"] = True
            result["candidates"] = [
                {
                    "source": f"web:{url}",
                    "text": clean[:MAX_CANDIDATE_CHARS],
                    "url": url,
                    # A page's content is current as of when it was fetched.
                    "date": _today(),
                }
            ]
            result["output"] = clean[:MAX_OUTPUT_CHARS]
            return result
    except asyncio.CancelledError:
        raise
    except Exception as e:  # noqa: BLE001
        log_error(f"[alc] Tool {name} failed:", e)
        result["error"] = f"{name} failed: {type(e).__name__}"
    return result


def _as_int(value: Any, default: int, low: int, high: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(parsed, high))


# ─── Index maintenance ──────────────────────────────────────────────────


async def ensure_index(ctx: ALCToolContext, opts: dict[str, Any]) -> dict[str, Any]:
    """Build/refresh the documentation index when it is missing or stale.

    The build is incremental (unchanged files are skipped by mtime+hash), so
    refreshing is a stat-walk in the common case.
    """
    import time

    if not ctx.roots:
        return {"buildt": False, "reason": "no folders configured"}
    status = await asyncio.to_thread(docs.index_status)
    fresh = status.get("built") and (time.time() - float(status.get("lastBuiltAt") or 0)) < docs.INDEX_TTL_SECONDS
    if fresh:
        return status
    emit_alc(opts, "index", phase="start", roots=len(ctx.roots))
    emit_alc(opts, "stage", stage="alc:indexing")

    def on_progress(payload: dict[str, Any]) -> None:
        # The callback also reports its own phase; the event's phase is 'progress'.
        data = {key: value for key, value in payload.items() if key != "phase"}
        emit_alc(opts, "index", phase="progress", **data)

    stats = await asyncio.to_thread(docs.build_index, ctx.roots, on_progress=on_progress)
    emit_alc(opts, "index", phase="done", **stats)
    log_info(f"[alc] Index ready: {stats.get('files', 0)} files, {stats.get('chunks', 0)} chunks")
    return stats
