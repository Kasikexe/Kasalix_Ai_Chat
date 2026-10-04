"""ALC controller — one ALC cycle: intake → gather (judged) → act.

Two entry points, one cycle:

* ``run_alc_turn`` (chat) — gather, then answer, with the findings in the system
  prompt of the normal chat tool loop.
* ``run_alc_gather`` (Koding) — gather, save durable notes to project knowledge,
  and return a briefing that ``run_agent_loop`` receives as ``extraContext``. The
  acting phase is then the Koding agent itself: the coding work must not be
  duplicated here, and keeping the routing in ``pipeline.run_pipeline`` means the
  code model, plan mode and tool permissions behave exactly as in Normal mode.

The cycle is software-bounded. ``pad.cycles`` is incremented at the top of every
gather iteration, so even a model that loops forever, or vetoes every tool, runs
out of budget instead of hanging; the acting phase is always reached.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from ..ai_rules import with_ai_rules
from ..attachments import strip_image_markers
from ..logger import info as log_info
from ..settings_store import get_alc_settings
from . import docs
from . import knowledge
from . import tools as alc_tools
from .decide import LLMConn, analyze_task, choose_action, judge_results, reformulate_query
from .events import emit_alc, emit_alc_notice
from .scratchpad import Scratchpad, looks_like_greeting

# The acting prompt is ALC-specific on purpose: the plain chat persona says
# nothing about retrieved evidence, and this turn HAS evidence that must win over
# the model's own recall. Global user AI rules are still applied on top.
ACTING_SYSTEM = (
    "You are answering the user directly after an information-gathering step.\n"
    "Be conversational and concise: contractions, lead with the answer, no filler like "
    "\"Based on the gathered information...\", no preamble, no restating the question.\n"
    "Answer their ACTUAL question, never a nearby one.\n"
    "When the gathered information covers the question, treat it as the source of truth — it "
    "is more current than your training data.\n"
    "If the gathered information does NOT cover it, say plainly that you could not check it, "
    "and do not offer a guess dressed up as an answer.\n"
    "Never fabricate versions, numbers, dates, APIs or sources.\n"
    "Never apologize — fix it and move on."
)

# Mirrors the chat path's history cap (pipeline.MAX_HISTORY): an ALC turn must
# not send more conversation than Normal mode would.
MAX_HISTORY = 30

# How many kept findings one cycle may promote into project knowledge. A coding
# turn can retrieve more than that; the rest stay in this turn's briefing.
MAX_KNOWLEDGE_WRITES = 3


@dataclass
class Budget:
    max_cycles: int
    max_tool_calls: int
    max_tokens: int


@dataclass
class _Setup:
    """Everything the cycle needs, resolved once per turn."""

    opts: dict[str, Any]
    settings: dict[str, Any]
    budget: Budget
    ctx: alc_tools.ALCToolContext
    conn: LLMConn
    pad: Scratchpad
    user_text: str
    available: list[dict[str, Any]] = field(default_factory=list)

    @property
    def signal(self) -> Any:
        return self.opts.get("signal")

    @property
    def read_only(self) -> bool:
        return not self.ctx.allow_writes


def _check_abort(signal: Any) -> None:
    if signal is not None and signal.is_set():
        raise asyncio.CancelledError()


def _last_user_text(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages or []):
        if message.get("role") == "user":
            return strip_image_markers(str(message.get("content") or "")).strip()
    return ""


def _query_of(tool: dict[str, Any], args: dict[str, Any]) -> str:
    for key in ("query", "url", "path"):
        value = args.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _with_query(args: dict[str, Any], query: str) -> dict[str, Any]:
    retry = dict(args)
    if "query" in retry or "url" not in retry:
        retry["query"] = query
    else:
        retry["url"] = query
    return retry


def _first_text(items: list[str]) -> str:
    for item in items or []:
        text = " ".join(str(item or "").split()).strip()
        if len(text) >= 4:
            return text
    return ""


def _same_text(text: str, candidates: list[str]) -> bool:
    """True when ``text`` is the same thing as one of ``candidates`` (loose match)."""
    needle = " ".join(str(text or "").lower().split()).strip(" ?!.,;:")
    if not needle:
        return False
    for candidate in candidates or []:
        haystack = " ".join(str(candidate or "").lower().split()).strip(" ?!.,;:")
        if needle == haystack or needle in haystack or haystack in needle:
            return True
    return False


# Tools that SEARCH for information. ``docs_open`` and ``read_url`` need a path
# or a URL the model must supply, so they are not substitutes for a failed
# search — switching to one of them would only produce a second failure.
SEARCH_TOOLS = {"knowledge_search", "docs_search", "web_search"}


def _first_untried_tool(
    available: list[dict[str, Any]], pad: Scratchpad
) -> dict[str, Any] | None:
    """The next information source that has not already come up empty this turn.

    Ordered by ``ALC_TOOLS`` (project knowledge, then documentation, then the
    web), so the fallback prefers the cheapest source rather than the fastest
    one to type.
    """
    for tool in available:
        if tool["name"] not in SEARCH_TOOLS:
            continue
        if tool["name"] in pad.failed_sources:
            continue
        return tool
    return None


def _safe_args(args: dict[str, Any]) -> dict[str, Any]:
    """Args for the event stream: text only, bounded (never a whole document)."""
    out: dict[str, Any] = {}
    for key, value in (args or {}).items():
        if isinstance(value, (str, int, float, bool)):
            text = str(value)
            out[str(key)] = text[:300]
    return out


# ─── Setup ──────────────────────────────────────────────────────────────
async def _setup(opts: dict[str, Any], *, mode: str) -> _Setup:
    settings = await get_alc_settings()
    budget = Budget(
        max_cycles=int(settings.get("alcMaxCycles") or 3),
        max_tool_calls=int(settings.get("alcMaxToolCalls") or 12),
        max_tokens=int(settings.get("alcMaxTokens") or 4000),
    )
    roots = docs.resolve_roots(settings.get("alcDocsPaths"))
    model = str(opts.get("model") or "")
    messages = list(opts.get("messages") or [])
    read_only = str(opts.get("toolPermission") or "") == "read-only"
    ctx = alc_tools.ALCToolContext(
        model=model,
        workspace=opts.get("workspacePath"),
        roots=roots,
        signal=opts.get("signal"),
        web_enabled=bool(settings.get("alcWebEnabled", True)),
        mode=mode,
        allow_writes=not read_only,
        opts=opts,
    )
    pad = Scratchpad(goal=_last_user_text(messages))
    if ctx.knowledge_enabled:
        # What the project already knows, so the model can decide to search it
        # instead of re-exploring the workspace.
        pad.set_knowledge_topics(await asyncio.to_thread(knowledge.topics, ctx.workspace))
    return _Setup(
        opts=opts,
        settings=settings,
        budget=budget,
        ctx=ctx,
        conn=LLMConn(
            model=model,
            signal=opts.get("signal"),
            base_url=opts.get("cloudEndpoint") or None,
            api_key=opts.get("cloudApiKey") or None,
        ),
        pad=pad,
        user_text=pad.goal,
        available=alc_tools.available_tools(ctx),
    )


def _emit_start(setup: _Setup) -> None:
    emit_alc(
        setup.opts,
        "start",
        model=setup.conn.model,
        mode=setup.ctx.mode,
        roots=len(setup.ctx.roots),
        tools=[tool["name"] for tool in setup.available],
        knowledgeTopics=len(setup.pad.knowledge_topics),
        maxCycles=setup.budget.max_cycles,
        maxToolCalls=setup.budget.max_tool_calls,
        maxTokens=setup.budget.max_tokens,
        webEnabled=setup.ctx.web_enabled,
    )


async def _intake(setup: _Setup) -> bool:
    """Ask what the task needs, then gather if anything is missing."""
    opts, pad, conn = setup.opts, setup.pad, setup.conn
    emit_alc(opts, "stage", stage="alc:analyzing")

    analysis = await analyze_task(setup.user_text, conn)
    pad.goal = analysis["goal"] or setup.user_text
    for question in analysis["questions"]:
        pad.add_question(question)
    emit_alc(
        opts,
        "goal",
        goal=pad.goal,
        questions=pad.questions,
        needsInfo=analysis["needs_info"],
        fallback=analysis["fallback"],
    )
    log_info(
        f"[alc] mode={setup.ctx.mode} goal={pad.goal!r} needs_info={analysis['needs_info']} "
        f"questions={pad.questions}"
    )

    if analysis["needs_info"]:
        await alc_tools.ensure_index(setup.ctx, opts)
        await _gather(opts, pad, setup.ctx, conn, setup.budget, setup.available)
    return bool(analysis["needs_info"])


# ─── Chat: gather then answer ───────────────────────────────────────────
async def run_alc_turn(opts: dict[str, Any]) -> str:
    """Run one ALC turn and return the answer text (already streamed via onChunk)."""
    # Imported here (not at module level) so importing app.alc can never form a
    # cycle with app.pipeline, which imports this module lazily.
    from ..pipeline import build_memory_context, run_chat_tool_loop, to_chat_tools

    setup = await _setup(opts, mode=str(opts.get("mode") or "chat"))
    _emit_start(setup)

    # Nothing to gather with, or nothing worth gathering for: answer directly.
    if not setup.user_text or looks_like_greeting(setup.user_text) or not setup.available:
        if not setup.available and setup.user_text:
            emit_alc_notice(
                opts,
                "no-sources",
                "ALC is active but has nothing to search: no documentation folders are "
                "configured and web search is off. Answering directly.",
            )
        return await _act(opts, setup.pad, build_memory_context, run_chat_tool_loop, to_chat_tools)

    await _intake(setup)
    setup.pad.prune(setup.budget.max_tokens)
    answer = await _act(opts, setup.pad, build_memory_context, run_chat_tool_loop, to_chat_tools)
    emit_alc(opts, "done", **setup.pad.summary())
    log_info(
        f"[alc] done: {setup.pad.summary()} (budget {setup.budget.max_cycles} cycles/"
        f"{setup.budget.max_tool_calls} calls/{setup.budget.max_tokens} tokens)"
    )
    return answer


# ─── Koding: gather, then brief the agent loop ──────────────────────────
async def run_alc_gather(opts: dict[str, Any]) -> str:
    """Gather for a Koding turn and return the briefing for the agent loop.

    Returns "" when there is nothing to say, in which case the agent runs with
    exactly the context Normal mode gives it.
    """
    setup = await _setup(opts, mode="agent")
    _emit_start(setup)

    if not setup.user_text or looks_like_greeting(setup.user_text) or not setup.available:
        if not setup.available and setup.user_text:
            emit_alc_notice(
                opts,
                "no-sources",
                "ALC is active but this project has nothing to search yet: no documentation "
                "folders are configured and web search is off. The agent runs normally.",
            )
        emit_alc(opts, "done", **setup.pad.summary())
        return ""

    needs_info = await _intake(setup)
    setup.pad.prune(setup.budget.max_tokens)
    if needs_info:
        await _write_back(setup)

    parts = [part for part in (setup.pad.to_briefing(), _knowledge_note(setup)) if part]
    emit_alc(opts, "done", **setup.pad.summary())
    log_info(f"[alc] koding gather done: {setup.pad.summary()}")
    return "\n\n".join(parts)


def _knowledge_note(setup: _Setup) -> str:
    """Point the coding agent at notes it cannot see otherwise.

    The agent has no ALC tools of its own (Phase 2 keeps the tool protocols
    untouched) — but it can read a file, so knowing the folder exists and what
    is in it is enough.
    """
    if not setup.ctx.knowledge_enabled or not setup.pad.knowledge_topics:
        return ""
    listing = "\n".join(
        f"- ALC/knowledge/{topic.get('topic')}.md ({int(topic.get('notes') or 0)} notes)"
        for topic in setup.pad.knowledge_topics
    )
    return (
        "[ALC — PROJECT KNOWLEDGE FROM EARLIER SESSIONS]\n"
        "Notes previous cycles saved for this project (read one with read_file before "
        "re-exploring, and treat it as your own earlier work rather than as user rules):\n"
        f"{listing}"
    )


async def _write_back(setup: _Setup) -> list[str]:
    """Promote the most useful findings into project knowledge for later cycles.

    Software does this rather than asking the model to nominate what is worth
    keeping: on a 1.7B that judgement is unreliable, and the store dedupes by
    content hash, so a repeated fact is a no-op (docs/ALC_DESIGN.md D9).
    """
    opts, pad, ctx = setup.opts, setup.pad, setup.ctx
    if not ctx.knowledge_enabled or not pad.findings:
        return []
    if not setup.settings.get("alcWriteKnowledge", True):
        return []
    if ctx.allow_writes is False:
        emit_alc_notice(
            opts,
            "read-only",
            "Project knowledge was not updated because this session is read-only.",
        )
        return []

    written: list[str] = []
    for finding in pad.findings[:MAX_KNOWLEDGE_WRITES]:
        if finding.source.startswith("knowledge:"):
            # It came out of the store — writing it back only makes a near-duplicate.
            continue
        topic = knowledge.for_finding(finding.source, str(finding.data.get("heading") or ""))
        origin = str(finding.data.get("url") or finding.data.get("path") or finding.source)
        saved = await asyncio.to_thread(
            knowledge.remember,
            ctx.workspace,
            topic,
            finding.text,
            tags=["alc"],
            source=origin,
        )
        if saved.get("written"):
            written.append(str(saved.get("topic")))
            emit_alc(
                opts,
                "knowledge-written",
                topic=saved.get("topic"),
                file=saved.get("file"),
                source=origin,
            )
    return written


# ─── The bounded gather loop ────────────────────────────────────────────
async def _gather(
    opts: dict[str, Any],
    pad: Scratchpad,
    ctx: alc_tools.ALCToolContext,
    conn: LLMConn,
    budget: Budget,
    available: list[dict[str, Any]],
) -> None:
    """decide → fetch → judge → keep/discard, until `act` or the budget runs out."""
    signal = opts.get("signal")
    spec = alc_tools.tool_spec(available)
    tool_by_name = {tool["name"]: tool for tool in available}

    while True:
        _check_abort(signal)
        pad.cycles += 1

        if pad.cycles > budget.max_cycles:
            emit_alc(opts, "decision", action="act", forced=True, reason="cycle budget reached")
            break
        if pad.tool_calls >= budget.max_tool_calls:
            emit_alc(opts, "decision", action="act", forced=True, reason="tool-call budget reached")
            break
        if pad.tokens() >= budget.max_tokens:
            emit_alc(opts, "decision", action="act", forced=True, reason="context budget reached")
            break

        decision = await choose_action(pad, available, conn, spec)
        emit_alc(
            opts,
            "decision",
            action=decision["action"],
            tool=decision.get("tool") or None,
            reason=decision["reason"],
            fallback=bool(decision.get("fallback")),
            **({"requested": decision["requested"]} if decision.get("requested") else {}),
        )
        for gap in decision.get("gaps") or []:
            # A model that echoes its own open questions as "gaps" would clutter
            # the briefing with the unanswered questions it was just asked to
            # close — those are already tracked as questions.
            if _same_text(gap, pad.questions):
                continue
            pad.add_gap(gap)
            emit_alc(opts, "gap", gap=gap)
        if decision["action"] != "tool":
            break

        tool = tool_by_name.get(str(decision.get("tool")))
        if tool is None:
            # choose_action already filters unknown tools; this is belt and braces.
            emit_alc(opts, "reject", source=str(decision.get("tool")), reason="unknown tool")
            continue

        # The model picked a source that already came up empty this turn. Asking
        # it again cannot help, so the controller falls back to a source that has
        # not been tried — software carrying the load, as designed (D3) — and the
        # substituted query below comes from the open question.
        if tool["name"] in pad.failed_sources:
            alternate = _first_untried_tool(available, pad)
            if alternate is None:
                emit_alc(
                    opts,
                    "decision",
                    action="act",
                    reason="every available source has already come up empty",
                )
                break
            emit_alc(
                opts,
                "decision",
                action="tool",
                tool=alternate["name"],
                reason=f"{tool['name']} already came up empty — trying {alternate['name']}",
                fallback=True,
            )
            tool = alternate
            decision["args"] = {}

        # A write the user forbade is refused BEFORE it runs, so the model is told
        # why instead of watching a tool fail.
        if tool["name"] == "knowledge_write" and not ctx.allow_writes:
            reason = "this session is read-only — project knowledge was not changed"
            pad.add_reject("knowledge_write", reason)
            emit_alc(opts, "reject", source="knowledge_write", reason=reason)
            continue

        args = alc_tools.make_args(tool, decision.get("args") or {})
        # A weak model often names the tool and forgets the query. Substituting
        # the open question keeps the cycle useful; using the tool's example
        # would search the prompt's own text.
        substituted = False
        primary = alc_tools.primary_arg(tool)
        if alc_tools.is_placeholder(args.get(primary), tool):
            fallback_query = _first_text(pad.questions) or " ".join(pad.goal.split())
            if fallback_query and not alc_tools.is_placeholder(fallback_query):
                args[primary] = fallback_query
                substituted = True
        query = _query_of(tool, args)
        if query and pad.has_query(query, tool["name"]):
            reason = "this exact lookup was already tried"
            pad.add_reject(f"{tool['name']}:{query}", reason)
            emit_alc(opts, "reject", source=f"{tool['name']}:{query}", reason=reason)
            emit_alc(opts, "budget", **pad.summary())
            if pad.findings:
                # Repeating a lookup is the clearest signal a small model gives that
                # it has nothing further to ask. Keep gathering only while there is
                # nothing to answer with — otherwise this just burns the budget.
                emit_alc(
                    opts,
                    "decision",
                    action="act",
                    reason="the model repeated a lookup it had already tried",
                )
                break
            # With nothing gathered yet, re-asking the same thing is not progress:
            # mark the source empty so the next step moves to an untried one.
            pad.mark_failed(tool["name"])
            if _first_untried_tool(available, pad) is None:
                emit_alc(
                    opts,
                    "decision",
                    action="act",
                    reason="every available source has already come up empty",
                )
                break
            continue

        pad.note_query(query, tool["name"])
        pad.tool_calls += 1
        emit_alc(opts, "stage", stage="alc:gathering")
        emit_alc(
            opts,
            "search",
            tool=tool["name"],
            query=query,
            args=_safe_args(args),
            substituted=substituted,
        )
        result = await alc_tools.dispatch(tool["name"], args, ctx)

        if tool["name"] == "knowledge_write" and result.get("saved", {}).get("written"):
            # The model chose to remember something itself — report it like the
            # automatic write-back so the turn has one knowledge story.
            emit_alc(
                opts,
                "knowledge-written",
                topic=result["saved"].get("topic"),
                file=result["saved"].get("file"),
                source="model",
            )

        # A failed or empty lookup is retried ONCE with a reformulated query
        # (docs/ALC_DESIGN.md D11), then recorded as a gap.
        if not result["ok"] and query and tool["name"] != "knowledge_write":
            retry = reformulate_query(query)
            if retry and not pad.has_query(retry, tool["name"]):
                emit_alc(
                    opts,
                    "result",
                    tool=tool["name"],
                    ok=False,
                    query=query,
                    error=result.get("error") or "",
                    retrying=retry,
                )
                pad.note_query(retry, tool["name"])
                pad.tool_calls += 1
                args = _with_query(args, retry)
                query = retry
                emit_alc(opts, "search", tool=tool["name"], query=query, args=_safe_args(args))
                result = await alc_tools.dispatch(tool["name"], args, ctx)

        emit_alc(
            opts,
            "result",
            tool=tool["name"],
            ok=bool(result["ok"]),
            query=query,
            count=len(result["candidates"]),
            chars=len(result.get("output") or ""),
            error=result.get("error") or "",
        )
        if not result["ok"]:
            reason = result.get("error") or "no usable result"
            pad.add_reject(f"{tool['name']}:{query}", reason)
            if tool["name"] != "knowledge_write":
                pad.mark_failed(tool["name"])
                pad.add_gap(reason)
                emit_alc(opts, "gap", gap=reason)
            emit_alc(opts, "budget", **pad.summary())
            continue

        if not result["candidates"]:
            # A successful write has nothing to judge.
            emit_alc(opts, "budget", **pad.summary())
            continue

        decisions, _used_fallback = await judge_results(query or pad.goal, result["candidates"], conn)
        kept = 0
        for verdict in decisions:
            index = int(verdict.get("i", -1))
            if index < 0 or index >= len(result["candidates"]):
                continue
            candidate = result["candidates"][index]
            if verdict.get("keep"):
                added = pad.add_finding(
                    source=str(candidate.get("source") or "unknown"),
                    text=str(candidate.get("text") or ""),
                    query=query,
                    score=float(candidate.get("score") or 0.0),
                    data={k: v for k, v in candidate.items() if k in ("path", "url", "heading")},
                )
                if added is not None:
                    kept += 1
                    emit_alc(
                        opts,
                        "finding",
                        source=added.source,
                        text=added.text,
                        query=query,
                        reason=verdict.get("reason") or "",
                    )
                else:
                    pad.add_reject(str(candidate.get("source")), "duplicate of something already kept")
            else:
                reason = verdict.get("reason") or "not relevant to the task"
                pad.add_reject(str(candidate.get("source")), reason)
                emit_alc(opts, "reject", source=str(candidate.get("source")), reason=reason)

        if kept == 0:
            # Nothing usable came back: remember the gap so the answer is honest
            # and the next decision does not chase the same source again.
            pad.add_gap(f'no usable information from {tool["name"]} for "{query}"')
            emit_alc(opts, "gap", gap=f'no usable information from {tool["name"]} for "{query}"')

        emit_alc(opts, "budget", **pad.summary())


# ─── Acting phase (chat) ────────────────────────────────────────────────
async def _act(
    opts: dict[str, Any],
    pad: Scratchpad,
    build_memory_context: Any,
    run_chat_tool_loop: Any,
    to_chat_tools: Any,
) -> str:
    """Answer with the retained findings in the system prompt."""
    parts: list[str] = [await with_ai_rules(ACTING_SYSTEM, "chat")]

    briefing = pad.to_briefing()
    if briefing:
        parts.append(briefing)
    else:
        parts.append(
            "[ALC] No external information was retrieved for this turn. Answer from your own "
            "knowledge, and if the question depends on facts you cannot verify, say plainly "
            "that you could not check them."
        )

    memory_context = await build_memory_context(opts.get("userId"))
    if memory_context:
        parts.append(memory_context)

    history = list(opts.get("messages") or [])
    if len(history) > MAX_HISTORY:
        history = history[-MAX_HISTORY:]

    messages = [
        {"role": "system", "content": part} for part in parts if part
    ] + [
        {"role": message.get("role"), "content": message.get("content", "")}
        for message in history
    ]

    on_stage = opts.get("onStage")
    if on_stage:
        on_stage("chat:thinking")
    emit_alc(opts, "stage", stage="alc:answering")

    return await run_chat_tool_loop(
        "chat",
        str(opts.get("model") or ""),
        messages,
        bool(opts.get("think")),
        opts.get("onChunk"),
        opts.get("signal"),
        {
            "temperature": opts.get("temperature"),
            "top_p": opts.get("top_p"),
            "max_tokens": opts.get("max_tokens"),
        },
        opts.get("onThinking"),
        on_stage,
        to_chat_tools(),
        on_metrics=opts.get("onMetrics"),
    )


__all__ = ["Budget", "run_alc_gather", "run_alc_turn"]
