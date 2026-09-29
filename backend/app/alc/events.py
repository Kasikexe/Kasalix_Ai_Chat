"""ALC activity events.

ALC is visible through its own SSE events (``alc:*``) so the client can show
what the cycle is doing WITHOUT polluting the answer text. Emission follows the
existing pipeline callback pattern: ``run_alc_turn`` receives an ``onAlcEvent``
callback from the chat route and calls it with a plain dict.

Event vocabulary (see docs/ALC_DESIGN.md §4.8):

    alc:start              the cycle began                {model, roots, budget}
    alc:stage              coarse status for the status line  {stage}
    alc:goal               intake result                  {goal, questions, needsInfo}
    alc:decision           gather more / act / veto        {action, reason}
    alc:search             a source is being queried       {tool, query, args}
    alc:result             what the tool returned          {tool, ok, chars, count}
    alc:finding            kept information                {source, text, query}
    alc:conflict           two sources disagree            {count, names}
    alc:reject             dropped information             {source, reason}
    alc:gap                an unresolved gap               {gap}
    alc:verify             the answer was checked          {blocked, claims, released}
    alc:budget             budget accounting               {cycle, cycles, toolCalls, tokens}
    alc:index              documentation index progress    {phase, files, chunks}
    alc:knowledge-written  an excerpt note was appended      {topic, file, source}
    alc:study              what was learned, in one note    {topic, mode, bullets, dropped, conflicts}
    alc:done               the cycle finished              {cycles, toolCalls, findings, gaps}
    alc:notice             ALC could not run / had nothing {kind, message}
"""

from __future__ import annotations

from typing import Any, Callable

from ..logger import error as log_error

ALC_EVENT_TYPES = (
    "alc:start",
    "alc:stage",
    "alc:goal",
    "alc:decision",
    "alc:search",
    "alc:result",
    "alc:finding",
    "alc:conflict",
    "alc:reject",
    "alc:gap",
    "alc:verify",
    "alc:budget",
    "alc:index",
    "alc:knowledge-written",
    "alc:study",
    "alc:done",
    "alc:notice",
)


def _sink(opts: dict[str, Any]) -> Callable[[dict[str, Any]], None] | None:
    sink = opts.get("onAlcEvent")
    return sink if callable(sink) else None


def emit_alc(opts: dict[str, Any], event: str, **payload: Any) -> None:
    """Emit one ``alc:<event>`` payload to the client.

    Never raises: a broken sink (disconnected client, a test stub) must not be
    able to kill the cycle — the same rule the rest of the pipeline follows.
    """
    sink = _sink(opts)
    if sink is None:
        return
    try:
        sink({"type": f"alc:{event}", **payload})
    except Exception as e:  # noqa: BLE001
        log_error(f"[alc] Could not emit {event}:", e)


def emit_alc_notice(opts: dict[str, Any], kind: str, message: str) -> None:
    """Tell the user ALC is enabled but not running (or had nothing to search)."""
    emit_alc(opts, "notice", kind=kind, message=message)
