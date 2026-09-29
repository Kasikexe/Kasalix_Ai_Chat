#!/usr/bin/env python3
"""ALC eval harness — does the cycle actually improve an answer?

Run from ``backend/``::

    .venv/Scripts/python.exe -m tests.eval.alc_eval --list
    .venv/Scripts/python.exe -m tests.eval.alc_eval --arms normal,alc-none --limit 5 --label baseline
    .venv/Scripts/python.exe -m tests.eval.alc_eval --arms alc-raw,alc-study --resume

Why this exists
    ALC's value is asserted, not demonstrated: every phase so far could only say
    "the cycle ran". This harness builds a documentation folder of INVENTED facts
    (:mod:`tests.eval.corpus`) and asks each question through the real pipeline
    (``app.pipeline.run_pipeline`` — the same entry point the chat route calls), so
    the answer can only come from retrieval: no model has *halyard_set_pace* in its
    weights. It then scores every answer deterministically (:mod:`tests.eval.scoring`).

    The load-bearing measurement is not "does ALC retrieve" — it is:
      * ``docs_gain``   — credit(ALC) − credit(Normal) on the first turn, i.e. is
                          the cycle worth its latency at all;
      * ``decide_cost`` — credit(alc-heuristic) vs credit(alc-raw): does the model's
                          own decide/judge layer earn the extra generations, or do
                          the software heuristics do just as well?
      * ``carry_gain``  — a second turn asked in a FRESH conversation with the
                          documentation removed. Only the project's own notes can
                          answer it, so this is the only number that justifies the
                          knowledge store (and it is the metric the study synthesis
                          has to move).

Arms
    normal          no ALC (today's baseline)
    alc-none        ALC gathering, but nothing is written back (what chat did before
                    Project Knowledge was wired into it)
    alc-raw         ALC + excerpt notes (the Phase 2 behaviour)
    alc-study       ALC + synthesised studies (Phase 4, the shipped default)
    alc-heuristic   ALC with the model's decision layer disabled — every intake,
                    action and judge decision comes from the software heuristics

Offline by default: web search is stubbed out unless ``--web on`` (which needs a
Tavily key). Nothing here writes outside the scratch run directory.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shutil
import statistics
import sys
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

try:  # imported as tests.eval.alc_eval (module or pytest)
    from .corpus import (
        CASES,
        CLASSIC,
        SUITES,
        Case,
        Corpus,
        build as build_corpus,
        generated,
    )
    from .scoring import normalise, score_answer, tally
except ImportError:  # invoked as a plain script: python tests/eval/alc_eval.py
    sys.path.insert(0, str(HERE))
    from corpus import (  # type: ignore
        CASES,
        CLASSIC,
        SUITES,
        Case,
        Corpus,
        build as build_corpus,
        generated,
    )
    from scoring import normalise, score_answer, tally  # type: ignore

DEFAULT_MODEL = "qwen3:1.7b"
REPORTS_DIR = HERE / "reports"


# ─── Arms ───────────────────────────────────────────────────────────────
@dataclass(frozen=True)
class Arm:
    name: str
    alc: bool
    write_knowledge: bool = True
    #: None = leave the shipped default in place; False = excerpt notes only
    study: bool | None = None
    #: None = the turn's own model; "" = heuristic-only decisions
    decide_model: str | None = None
    #: None = the shipped behaviour (contradictions are resolved in software
    #: before the answer is written). False = the ablation that measures it.
    conflict: bool | None = None
    #: None = the shipped behaviour (the answer is checked before it is
    #: released). False = the ablation that measures it.
    answer_guard: bool | None = None
    label: str = ""
    #: What a human is shown. The ids above are the machine's names and stay
    #: stable so old reports keep loading; these are for people.
    display: str = ""
    #: An arm that exists to isolate one variable while building the cycle. Hidden
    #: unless asked for: five rows with four unfamiliar names is not a result.
    advanced: bool = False


ARMS: dict[str, Arm] = {
    "normal": Arm("normal", alc=False, label="Normal — no cycle", display="ALC off"),
    "alc-study": Arm(
        "alc-study",
        alc=True,
        study=True,
        label="ALC + synthesised studies",
        display="ALC on",
    ),
    "alc-none": Arm(
        "alc-none",
        alc=True,
        write_knowledge=False,
        label="ALC, nothing written back",
        display="ALC on, keeps nothing",
        advanced=True,
    ),
    "alc-raw": Arm(
        "alc-raw",
        alc=True,
        study=False,
        label="ALC + excerpt notes",
        display="ALC on, raw excerpts",
        advanced=True,
    ),
    "alc-heuristic": Arm(
        "alc-heuristic",
        alc=True,
        decide_model="",
        label="ALC with heuristic-only decisions",
        display="ALC on, software decides",
        advanced=True,
    ),
    # ── Ablations: the shipped cycle with exactly ONE guarantee off, so each is
    # provable on its own instead of being part of a bundle that "seems better".
    "alc-noconflict": Arm(
        "alc-noconflict",
        alc=True,
        conflict=False,
        label="ALC without in-turn conflict resolution",
        display="ALC on, conflicts unresolved",
        advanced=True,
    ),
    "alc-noguard": Arm(
        "alc-noguard",
        alc=True,
        answer_guard=False,
        label="ALC without the answer check",
        display="ALC on, answer unchecked",
        advanced=True,
    ),
}


def display_name(name: str) -> str:
    """What to call an arm in front of a person."""
    arm = ARMS.get(name)
    if arm is None:
        return name
    return arm.display or arm.label or arm.name


def main_arm(names: Iterable[str]) -> str:
    """The one arm a run is *about*.

    A generation comparison wants a single number per run: "ALC 0.13 scored 86%,
    Kasalix 1.0 scored 93%". `normal` is a reference point, never the headline, so
    it is only returned when there is nothing else.
    """
    available = [str(name) for name in names]
    for preferred in ("alc-study", *[name for name in ARMS if name != "normal"]):
        if preferred in available:
            return preferred
    return available[0] if available else ""


def arm_available(arm: Arm) -> tuple[bool, str]:
    """Whether an arm's mechanism exists in this checkout yet."""
    if arm.study is not None and arm.alc:
        try:
            import app.alc.study  # noqa: F401
        except Exception as err:  # noqa: BLE001
            return False, f"app.alc.study is not available ({type(err).__name__})"
    if arm.decide_model is not None and arm.alc:
        try:
            from app.alc import controller  # noqa: F401
        except Exception as err:  # noqa: BLE001
            return False, f"app.alc.controller is not available ({type(err).__name__})"
    return True, ""


# ─── Metering ───────────────────────────────────────────────────────────
@dataclass
class Meter:
    """Counts real model calls, so the report can price each arm honestly."""

    calls: list[dict[str, Any]] = field(default_factory=list)

    def reset(self) -> None:
        self.calls.clear()

    @property
    def count(self) -> int:
        return len(self.calls)

    @property
    def seconds(self) -> float:
        return round(sum(float(call.get("seconds") or 0.0) for call in self.calls), 3)


def _wrap_call(original: Callable[..., Any], name: str, meter: Meter) -> Callable[..., Any]:
    async def wrapper(*args: Any, **kwargs: Any) -> Any:
        record: dict[str, Any] = {"fn": name, "seconds": 0.0, "ok": True, "error": ""}
        meter.calls.append(record)
        started = time.perf_counter()
        try:
            return await original(*args, **kwargs)
        except BaseException as err:  # noqa: BLE001 — counted, then re-raised
            record["ok"] = False
            record["error"] = type(err).__name__
            raise
        finally:
            record["seconds"] = round(time.perf_counter() - started, 3)

    return wrapper


def install_meter(meter: Meter) -> None:
    """Wrap the two LLM entry points and re-point every module that imported them.

    Patching only ``app.ollama_client`` would miss modules that did
    ``from .ollama_client import stream_chat`` at import time (pipeline, agent,
    search, the ALC decide layer) — they hold their own reference.
    """
    import app.ollama_client as client

    for name in ("stream_chat", "stream_chat_with_tools"):
        original = getattr(client, name, None)
        if original is None or getattr(original, "_alc_eval_wrapped", False):
            continue
        wrapped = _wrap_call(original, name, meter)
        wrapped._alc_eval_wrapped = True  # type: ignore[attr-defined]
        setattr(client, name, wrapped)
        for module in list(sys.modules.values()):
            try:
                if getattr(module, name, None) is original:
                    setattr(module, name, wrapped)
            except Exception:  # noqa: BLE001 — odd module objects, ignore
                continue


class FakeModel:
    """Scripted stand-in for the model: the harness's own self-test.

    Used by ``--fake`` (and by the pytest for this harness) so the *plumbing* and
    the scoring can be verified without Ollama. It answers from the case's own
    expected tokens, which is exactly what a model with the retrieved evidence in
    front of it would do.
    """

    def __init__(self, mode: str = "oracle") -> None:
        self.mode = mode
        self.question = ""
        self.case: Case | None = None
        self.searches = 0
        self.judged = 0
        self.meter: Meter | None = None

    def _count(self, name: str) -> None:
        if self.meter is not None:
            self.meter.calls.append({"fn": f"fake:{name}", "seconds": 0.0, "ok": True, "error": ""})

    def answer_text(self, context: str = "") -> str:
        """Answer FROM THE CONTEXT IT WAS HANDED — never from the case.

        This is the whole point of the oracle: it can only state a fact that the
        pipeline actually put in front of it. If retrieval failed, the oracle
        says so, exactly as a compliant model should. A fake that answered from
        the case would score every arm 100% and measure nothing.
        """
        case = self.case
        if self.mode == "guesser":
            # Confidently wrong: a value from nowhere, in a shape a model would
            # really produce. This is what the invention check is for.
            return "The documented default is 99 frames, defined in pkg/guessed/thing.py."
        if case is None:
            return "I could not find anything about that in the documentation."
        haystack = normalise(context)
        seen = [token for token in case.expect if normalise(token) in haystack]
        if not seen:
            return "I could not find that in the documentation, so I cannot confirm a value."
        return "According to the documentation: " + ", ".join(seen) + "."

    async def generate(self, conn: Any, system: str, user: str, *, max_tokens: int = 256) -> str:
        self._count("generate")
        if "planning step of an information-gathering cycle" in system:
            return json.dumps({"goal": self.question, "needs_info": True, "questions": [self.question]})
        if "You control an information-gathering cycle" in system:
            if self.searches == 0:
                self.searches += 1
                return json.dumps(
                    {
                        "action": "tool",
                        "tool": "docs_search",
                        "args": {"query": self.question},
                        "reason": "the documentation should have this",
                    }
                )
            return json.dumps({"action": "act", "reason": "the gathered information is enough"})
        self.judged += 1
        return "{}"  # unparseable → the heuristic judge keeps by term overlap

    async def chat_tool_loop(self, *args: Any, **kwargs: Any) -> str:
        self._count("answer")
        messages = kwargs.get("messages")
        if messages is None and len(args) >= 3:
            messages = args[2]
        # The user's own question is NOT evidence: it names the identifier being
        # asked about, and a model that echoed it back would look like a model that
        # found the answer. Only what the pipeline INJECTED counts.
        context = "\n".join(
            str(message.get("content") or "")
            for message in (messages or [])
            if str(message.get("content") or "").strip() != self.question.strip()
        )
        on_chunk = kwargs.get("on_chunk")
        if on_chunk is None and len(args) >= 5:
            on_chunk = args[4]
        text = self.answer_text(context)
        if callable(on_chunk):
            on_chunk(text)
        return text

    async def plan_search(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        self._count("plan_search")
        return {"query": "", "source": "fake", "reason": "scripted", "context": "", "found": False, "attempts": []}

    async def search_web(self, query: str, *args: Any, **kwargs: Any) -> Any:
        from app.search import SearchOutcome

        return SearchOutcome(query=query, context="", sources=[], found=False, attempts=[query])


# ─── Runtime patches ────────────────────────────────────────────────────
_patch_state: dict[str, Any] = {"web": None, "fake": None}


def apply_patches(*, web: bool, fake: FakeModel | None) -> None:
    """Install (idempotently) the offline / scripted patches for a run."""
    import app.pipeline as pipeline
    import app.search as search

    if _patch_state.get("web") is None:
        _patch_state["web_original"] = search.search_web
    if not web:
        if _patch_state.get("web") is not False:
            stub = FakeModel().search_web
            search.search_web = stub  # type: ignore[assignment]
            pipeline.search_web = stub  # type: ignore[assignment]
            _patch_state["web"] = False
    else:
        original = _patch_state.get("web_original")
        if _patch_state.get("web") is not True and original is not None:
            search.search_web = original  # type: ignore[assignment]
            pipeline.search_web = original  # type: ignore[assignment]
            _patch_state["web"] = True

    if fake is None:
        return
    from app.alc import decide

    if _patch_state.get("fake") is None:
        _patch_state["fake_originals"] = {
            "generate": decide.generate,
            "chat_tool_loop": pipeline.run_chat_tool_loop,
            "plan_search": pipeline.plan_search,
        }
    # Always re-bind to the CURRENT fake instance so per-turn state is live.
    decide.generate = fake.generate  # type: ignore[assignment]
    pipeline.run_chat_tool_loop = fake.chat_tool_loop  # type: ignore[assignment]
    pipeline.plan_search = fake.plan_search  # type: ignore[assignment]
    _patch_state["fake"] = fake


def restore_patches() -> None:
    import app.pipeline as pipeline
    import app.search as search

    originals = _patch_state.get("fake_originals") or {}
    if originals:
        from app.alc import decide

        decide.generate = originals["generate"]  # type: ignore[assignment]
        pipeline.run_chat_tool_loop = originals["chat_tool_loop"]  # type: ignore[assignment]
        pipeline.plan_search = originals["plan_search"]  # type: ignore[assignment]
    original_web = _patch_state.get("web_original")
    if original_web is not None:
        search.search_web = original_web  # type: ignore[assignment]
        pipeline.search_web = original_web  # type: ignore[assignment]
    _patch_state.clear()


# ─── Run context ────────────────────────────────────────────────────────
@dataclass
class RunContext:
    corpus: Corpus
    root: Path
    model: str
    docs: bool = True
    web: bool = False
    fake: FakeModel | None = None
    timeout: float = 600.0
    max_tokens: int = 700
    temperature: float = 0.2
    tavily_key: str = ""
    #: What this run is measuring, free text — e.g. "alc-0.13.0" or "kasalix-1.0-lora".
    #: Recorded so two runs of different generations are comparable later.
    tag: str = ""
    #: Copy each turn's project knowledge aside, so what an arm actually learned can
    #: be read afterwards. The cold control wipes the store, so without this the
    #: run ends with every arm's store empty and nothing to inspect.
    keep_store: bool = False
    #: Which question set this run used. Recorded because two runs that answered
    #: DIFFERENT questions are not comparable, however similar their scores look.
    suite: str = "core"

    def arm_dir(self, arm: Arm) -> Path:
        path = self.root / arm.name
        path.mkdir(parents=True, exist_ok=True)
        return path

    def workspace(self, arm: Arm) -> Path:
        path = self.arm_dir(arm) / "workspace"
        path.mkdir(parents=True, exist_ok=True)
        return path

    def data_dir(self, arm: Arm) -> Path:
        path = self.arm_dir(arm) / "data"
        path.mkdir(parents=True, exist_ok=True)
        return path


def write_settings(ctx: RunContext, arm: Arm, *, docs: bool) -> None:
    """Write this arm's settings.json. Called before EVERY turn.

    The docs setting is per-turn, not per-arm, because the carry case removes the
    documentation for its second turn: "a later session where the folder is no
    longer configured". Settings are re-read from disk (with a 2s cache, which we
    invalidate), so flipping them between turns is enough.
    """
    from app.settings_store import invalidate_settings_cache

    payload: dict[str, Any] = {
        "cloudMode": "local",
        "modelAssignments": {},
        "alcDocsPaths": [str(ctx.corpus.docs_root)] if docs else [],
        "alcMaxCycles": 3,
        "alcMaxToolCalls": 12,
        "alcMaxTokens": 4000,
        "alcWebEnabled": bool(ctx.web),
        "alcWriteKnowledge": bool(arm.write_knowledge),
    }
    if ctx.tavily_key:
        payload["tavilyApiKey"] = ctx.tavily_key
    data_dir = ctx.data_dir(arm)
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "settings.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    os.environ["DATA_DIR"] = str(data_dir)
    invalidate_settings_cache()


#: Never written into a report. A key is not a result, and a report is a file that
#: gets copied around, quoted in docs, and committed.
SECRET_ARGS = ("tavily_key", "tavilyKey", "tavilyApiKey", "cloud_api_key")


def scrub_scratch_key(root: Path) -> int:
    """Delete the Tavily key from every scratch settings file this run wrote.

    The key has to reach the app through a settings file (that is how the app reads
    it), and for a run that file lives in a scratch directory which outlives the
    process and is deliberately left behind for inspection. A key left there is a
    key left on disk, so it is removed as soon as the run ends.
    """
    removed = 0
    for path in Path(root).glob("*/data/settings.json"):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if payload.pop("tavilyApiKey", None):
            path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            removed += 1
    return removed


def wipe_knowledge(workspace: Path) -> None:
    """Forget the project's notes — every case starts from an empty store."""
    shutil.rmtree(workspace / "ALC", ignore_errors=True)


def plant_note(workspace: Path, case: Case) -> Path:
    """Write a case's stale project note into the workspace's knowledge store.

    A note that contradicts the documentation is the one hazard a knowledge store
    creates for itself, and it cannot be tested without one being there.
    """
    directory = workspace / "ALC" / "knowledge"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{case.id}.md"
    path.write_text(case.planted_note, encoding="utf-8")
    return path


def knowledge_files(workspace: Path) -> list[str]:
    directory = workspace / "ALC" / "knowledge"
    if not directory.is_dir():
        return []
    return sorted(path.name for path in directory.glob("*.md"))


# ─── One turn ───────────────────────────────────────────────────────────
async def run_turn(
    ctx: RunContext,
    arm: Arm,
    case: Case,
    *,
    question: str,
    variant: str,
    turn: int,
    docs: bool,
    meter: Meter,
) -> dict[str, Any]:
    """Run one turn of one case through the real pipeline and score it."""
    from app.pipeline import run_pipeline

    workspace = ctx.workspace(arm)
    write_settings(ctx, arm, docs=docs)

    if ctx.fake is not None:
        ctx.fake.question = question
        ctx.fake.case = case
        ctx.fake.searches = 0
        ctx.fake.judged = 0
        ctx.fake.meter = meter

    chunks: list[str] = []
    events: list[dict[str, Any]] = []
    stages: list[str] = []
    first: dict[str, float] = {}

    def on_chunk(text: str) -> None:
        if "t" not in first:
            first["t"] = time.perf_counter()
        chunks.append(text)

    signal = asyncio.Event()
    opts: dict[str, Any] = {
        "model": ctx.model,
        "messages": [{"role": "user", "content": question}],
        "mode": "chat",
        "workspacePath": str(workspace),
        "alc": bool(arm.alc),
        "thinkingEnabled": False,
        "planningEnabled": False,
        "temperature": ctx.temperature,
        "max_tokens": ctx.max_tokens,
        "signal": signal,
        "onChunk": on_chunk,
        "onStage": lambda stage: stages.append(str(stage)),
        "onThinking": lambda _t: None,
        "onMetrics": lambda _m: None,
        "onAlcEvent": lambda event: events.append(dict(event)),
    }
    if arm.study is not None:
        opts["alcStudy"] = bool(arm.study)
    if arm.decide_model is not None:
        opts["alcDecideModel"] = arm.decide_model
    if arm.conflict is not None:
        opts["alcConflict"] = bool(arm.conflict)
    if arm.answer_guard is not None:
        opts["alcAnswerGuard"] = bool(arm.answer_guard)

    meter.reset()
    error = ""
    error_detail = ""
    started = time.perf_counter()
    try:
        await asyncio.wait_for(run_pipeline(opts), timeout=ctx.timeout)
    except asyncio.TimeoutError:
        error = f"timeout after {ctx.timeout:.0f}s"
        signal.set()
    except asyncio.CancelledError:
        error = "cancelled"
    except Exception as err:  # noqa: BLE001 — a failed turn is data, not a crash
        import traceback

        error = f"{type(err).__name__}: {err}"
        error_detail = traceback.format_exc(limit=3)
    total = time.perf_counter() - started

    answer = "".join(chunks)
    verdict = score_answer(answer, case, ctx.corpus, question=question)
    counts: dict[str, int] = {}
    for event in events:
        kind = str(event.get("type") or "")
        counts[kind] = counts.get(kind, 0) + 1
    done = next((event for event in reversed(events) if event.get("type") == "alc:done"), {})

    row: dict[str, Any] = {
        "key": f"{arm.name}|{case.id}|{variant}",
        "arm": arm.name,
        "case": case.id,
        "kind": case.kind,
        "variant": variant,
        "turn": turn,
        "docs": docs,
        "question": question,
        "verdict": verdict.verdict,
        "matched": verdict.matched,
        "missing": verdict.missing,
        "invented": verdict.invented,
        # A superseded value is not an invention — it is a stale fact, and the
        # difference matters when reading a failure: one is a retrieval problem,
        # the other is a recency problem.
        "stale": verdict.stale,
        "reason": verdict.reason,
        "suite": case.suite,
        "holdout": bool(case.holdout),
        "answer": answer[:1600],
        "error": error,
        "errorDetail": error_detail,
        "ttft": round((first.get("t", started + total) - started), 3),
        "total": round(total, 3),
        "calls": meter.count,
        "callSeconds": meter.seconds,
        "alcEvents": counts,
        **diagnostics(events),
        "alcCycles": int(done.get("cycles") or 0),
        "alcFindings": int(done.get("findings") or 0),
        "alcToolCalls": int(done.get("toolCalls") or 0),
        "stages": stages[-8:],
        "knowledgeFiles": knowledge_files(workspace),
        "learned": snapshot_knowledge(ctx, arm, case, variant) if ctx.keep_store else "",
    }
    row["failureStage"] = classify_failure(row, events)
    return row


def diagnostics(events: list[dict[str, Any]]) -> dict[str, Any]:
    """What the turn's own events say about *why* it lost, kept in the report.

    The stage names the part of the cycle to open; these say what it was looking
    at when it failed. `rejects` is the relevance judge's own reason for every
    passage it threw away (a `judge-drop` is otherwise unattributable — the
    passage and the reason are gone by the time the run ends), `queries` is what
    was actually asked of each source, and `withheld` is what the answer gate
    refused to release. The last one is the difference between "it never said
    that" and "it said it and software stopped it", which is the entire claim the
    guard makes, so it belongs in the record rather than only in a log line.
    """
    rejects: list[dict[str, str]] = []
    queries: list[dict[str, str]] = []
    withheld: list[str] = []
    verify: dict[str, Any] = {}
    for event in events:
        kind = str(event.get("type") or "")
        if kind == "alc:reject":
            rejects.append(
                {
                    "source": str(event.get("source") or ""),
                    "reason": str(event.get("reason") or ""),
                }
            )
        elif kind == "alc:search":
            queries.append(
                {
                    "tool": str(event.get("tool") or ""),
                    "query": str(event.get("query") or ""),
                }
            )
        elif kind == "alc:verify":
            verify = {
                "enabled": bool(event.get("enabled", True)),
                "blocked": int(event.get("blocked") or 0),
            }
            withheld = [str(claim) for claim in (event.get("claims") or [])][:8]
    return {
        "rejects": rejects[:8],
        "queries": queries[:12],
        "withheld": withheld,
        "verify": verify,
    }


#: Where a turn lost its case. A single "wrong" tells nobody what to fix; naming
#: the stage does, and the stages map onto the parts of the cycle that exist.
FAILURE_STAGES = (
    "no-cycle",
    "no-lookup",
    "retrieval-miss",
    "judge-drop",
    "conflict",
    "unsupported-claim",
    "empty-answer",
    "error",
    "unclassified",
)


def classify_failure(row: dict[str, Any], events: list[dict[str, Any]]) -> str:
    """Which stage lost this turn (empty string when it did not lose).

    Deterministic and derived from the events the turn already emitted, so it
    costs nothing and cannot disagree with the trajectory the user saw.
    """
    if row.get("error"):
        return "error"
    if str(row.get("verdict") or "") in ("correct", "admitted"):
        return ""
    types = {str(event.get("type") or "") for event in events}
    if "alc:start" not in types:
        return "no-cycle"
    if row.get("stale"):
        # It answered with a value the sources had already superseded.
        return "conflict"
    if row.get("invented"):
        return "unsupported-claim"
    if not row.get("answer"):
        return "empty-answer"
    if "alc:search" not in types:
        return "no-lookup"
    if not int(row.get("alcFindings") or 0):
        # Candidates came back and none survived judging, or nothing came back at
        # all: different stages, different fixes.
        found_any = any(int(event.get("count") or 0) > 0 for event in events if event.get("type") == "alc:result")
        return "judge-drop" if found_any else "retrieval-miss"
    return "unclassified"


def snapshot_knowledge(ctx: RunContext, arm: Arm, case: Case, variant: str) -> str:
    """Keep a copy of this turn's store under the arm, for inspection."""
    source = ctx.workspace(arm) / "ALC" / "knowledge"
    if not source.is_dir():
        return ""
    destination = ctx.arm_dir(arm) / "learned" / f"{case.id}-{variant}"
    try:
        shutil.rmtree(destination, ignore_errors=True)
        shutil.copytree(source, destination)
    except OSError:
        return ""
    return str(destination)


async def run_case(ctx: RunContext, arm: Arm, case: Case, meter: Meter) -> list[dict[str, Any]]:
    """All turns for one case under one arm.

    A ``carry`` case runs three turns: a seed (fresh store, docs present), then
    the follow-up TWICE — once with the store kept, once with it wiped — both in
    a fresh conversation with the documentation removed. The difference between
    those two is the only thing the project notes can be credited for.
    """
    rows: list[dict[str, Any]] = []
    wipe_knowledge(ctx.workspace(arm))
    if case.planted_note:
        plant_note(ctx.workspace(arm), case)
    rows.append(
        await run_turn(
            ctx,
            arm,
            case,
            question=case.question,
            variant="seed" if case.kind == "carry" else "single",
            turn=1,
            docs=ctx.docs,
            meter=meter,
        )
    )
    if case.kind != "carry":
        return rows

    rows.append(
        await run_turn(
            ctx,
            arm,
            case,
            question=case.follow_up,
            variant="warm",
            turn=2,
            docs=False,
            meter=meter,
        )
    )
    # The cold control: identical turn, but the store is gone. Everything else
    # (conversation, workspace path, settings) stays the same, so the pair
    # isolates the knowledge store itself.
    wipe_knowledge(ctx.workspace(arm))
    rows.append(
        await run_turn(
            ctx,
            arm,
            case,
            question=case.follow_up,
            variant="cold",
            turn=2,
            docs=False,
            meter=meter,
        )
    )
    return rows


# ─── Reporting ──────────────────────────────────────────────────────────
def _median(values: list[float]) -> float:
    clean = [value for value in values if value is not None]
    return round(statistics.median(clean), 2) if clean else 0.0


def _arm_rows(rows: list[dict[str, Any]], arm: str, variants: Iterable[str] | None = None) -> list[dict[str, Any]]:
    wanted = set(variants) if variants is not None else None
    return [
        row
        for row in rows
        if row.get("arm") == arm and (wanted is None or row.get("variant") in wanted)
    ]


def _credit(rows: list[dict[str, Any]]) -> float:
    return float(tally(rows)["credit_rate"]) if rows else 0.0


def _recall(rows: list[dict[str, Any]]) -> float:
    """The share of each case's expected details that actually appeared.

    Credit is all-or-nothing, which hides a real difference: an arm that gets one
    of two facts out of a note is better than one that gets neither, and on the
    carry measurement that difference IS the finding.
    """
    scores: list[float] = []
    for row in rows:
        expected = len(row.get("matched") or []) + len(row.get("missing") or [])
        if expected:
            scores.append(len(row.get("matched") or []) / expected)
    return round(sum(scores) / len(scores), 3) if scores else 0.0


def build_report(
    label: str,
    ctx: RunContext,
    arms: list[Arm],
    rows: list[dict[str, Any]],
    *,
    ran_at: str = "",
    rescored: bool = False,
) -> str:
    """The 20-second version: what each arm scored, what it cost, what the store carried.

    ``ran_at`` is the run's own start time. A report regenerated by ``--rescore``
    must keep saying when the *run* happened, not when it was re-scored, or the
    history it exists to preserve would be quietly wrong about its own dates.
    """
    first_turn = [row for row in rows if row.get("turn") == 1]
    lines: list[str] = []
    lines.append(f"# ALC eval — {label}")
    lines.append("")
    lines.append(
        f"- model: `{ctx.model}`  ·  docs: {'on' if ctx.docs else 'OFF'}  ·  "
        f"web: {'on' if ctx.web else 'off'}  ·  "
        f"{'SCRIPTED model (self-test)' if ctx.fake else 'live model'}"
    )
    lines.append(
        f"- measuring: {ctx.tag or '(untagged)'}  ·  fact set: `{ctx.corpus.variant}`  ·  "
        f"suite: `{ctx.suite}`"
    )
    held = [case.id for case in ctx.corpus.cases if case.holdout]
    if held:
        lines.append(
            "- held-out (reported, never tuned on): " + ", ".join(f"`{case_id}`" for case_id in held)
        )
    stamp = str(ran_at or "").replace("T", " ").replace("+00:00", "").strip()
    note = "  ·  verdicts re-scored with the current scorer" if rescored else ""
    lines.append(
        f"- cases: {len(ctx.corpus.cases)}  ·  turns: {len(rows)}  ·  "
        f"run at {(stamp or f'{datetime.now(timezone.utc):%Y-%m-%d %H:%M}')} UTC{note}"
    )
    lines.append("- credit = answered correctly **or** said plainly it could not find it (inventing is never credit)")
    lines.append("")

    # ── What each arm got, on the first turn of every case
    lines.append("## First turn — does ALC retrieve anything Normal does not?")
    lines.append("")
    lines.append("| arm | credit | correct | admitted | invented | wrong | ttft p50 | turn p50 | calls/turn |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for arm in arms:
        subset = _arm_rows(first_turn, arm.name)
        if not subset:
            continue
        summary = tally(subset)
        counts = summary["counts"]
        lines.append(
            f"| `{arm.name}` | {summary['credit_rate']:.0%} | {counts['correct']} | {counts['admitted']} | "
            f"{counts['invented']} | {counts['wrong']} | {_median([r['ttft'] for r in subset])}s | "
            f"{_median([r['total'] for r in subset])}s | {_median([float(r['calls']) for r in subset])} |"
        )
    lines.append("")

    # ── The carry measurement
    carry_cases = [case.id for case in ctx.corpus.cases if case.kind == "carry"]
    if carry_cases:
        lines.append("## Carry — a later session, fresh conversation, documentation gone")
        lines.append("")
        lines.append("| arm | credit, store kept | credit, store wiped | carried | facts kept | facts wiped | notes written |")
        lines.append("| --- | --- | --- | --- | --- | --- | --- |")
        for arm in arms:
            warm = _arm_rows(rows, arm.name, ["warm"])
            cold = _arm_rows(rows, arm.name, ["cold"])
            if not warm and not cold:
                continue
            warm_credit, cold_credit = _credit(warm), _credit(cold)
            wrote = len({name for row in _arm_rows(rows, arm.name, ["seed"]) for name in row.get("knowledgeFiles") or []})
            lines.append(
                f"| `{arm.name}` | {warm_credit:.0%} | {cold_credit:.0%} | **{warm_credit - cold_credit:+.0%}** | "
                f"{_recall(warm):.0%} | {_recall(cold):.0%} | {wrote} |"
            )
        lines.append("")

    # ── Where the failures came from: a score says how many, this says why
    lost = [row for row in rows if row.get("failureStage")]
    if lost:
        lines.append("## Where the lost turns were lost")
        lines.append("")
        lines.append("| arm | " + " | ".join(stage for stage in FAILURE_STAGES) + " |")
        lines.append("| --- |" + " --- |" * len(FAILURE_STAGES))
        for arm in arms:
            stages = [row for row in lost if row.get("arm") == arm.name]
            if not stages:
                continue
            tally_stage = {stage: sum(1 for row in stages if row.get("failureStage") == stage) for stage in FAILURE_STAGES}
            lines.append(
                f"| `{arm.name}` | "
                + " | ".join(str(tally_stage[stage]) if tally_stage[stage] else "·" for stage in FAILURE_STAGES)
                + " |"
            )
        lines.append("")
        lines.append(
            "_`retrieval-miss` = the passage was never found; `judge-drop` = it was found and "
            "dropped; `conflict` = a superseded value was answered; `unsupported-claim` = a value "
            "no source states (the failure the answer check exists to prevent)._",
        )
        lines.append("")

    # ── The verdict
    lines.append("## Verdict")
    lines.append("")
    normal = _credit(_arm_rows(first_turn, "normal"))
    for arm in arms:
        if arm.name == "normal" or not arm.alc:
            continue
        subset = _arm_rows(first_turn, arm.name)
        if not subset:
            continue
        gain = _credit(subset) - normal
        summary = tally(subset)
        timed = _median([r["total"] for r in subset])
        normal_time = _median([r["total"] for r in _arm_rows(first_turn, "normal")])
        wording = "beats" if gain > 0.05 else ("is level with" if gain > -0.05 else "is WORSE than")
        lines.append(
            f"- `{arm.name}` {wording} Normal on the first turn: {_credit(subset):.0%} vs {normal:.0%} "
            f"({gain:+.0%}), median turn {timed}s vs {normal_time}s, "
            f"{_median([float(r['calls']) for r in subset])} model calls vs "
            f"{_median([float(r['calls']) for r in _arm_rows(first_turn, 'normal')])}."
        )
        if summary["counts"]["invented"]:
            lines.append(f"  - **invented a value on {summary['counts']['invented']} turn(s)** — the failure this exists to prevent.")
    for arm in arms:
        if not arm.alc or not arm.write_knowledge:
            continue
        for case_id in carry_cases:
            warm = [
                row
                for row in rows
                if row.get("case") == case_id
                and row.get("variant") == "warm"
                and row.get("arm") == arm.name
            ]
            cold = [
                row
                for row in rows
                if row.get("case") == case_id
                and row.get("variant") == "cold"
                and row.get("arm") == arm.name
            ]
            if not warm and not cold:
                continue
            lines.append(
                f"- carry `{case_id}` (`{arm.name}`): store kept {_credit(warm):.0%} / {_recall(warm):.0%} of the "
                f"facts vs store wiped {_credit(cold):.0%} / {_recall(cold):.0%}"
            )
    lines.append("")

    # ── Per-case detail, to see WHERE a score came from
    lines.append("## Per case")
    lines.append("")
    lines.append("| case | kind | arm | turn | variant | verdict | matched | invented |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- | --- |")
    for row in rows:
        lines.append(
            f"| {row['case']} | {row['kind']} | `{row['arm']}` | {row['turn']} | {row['variant']} | "
            f"{'⚠️ ' if row['verdict'] == 'invented' else ''}{row['verdict']} | "
            f"{', '.join(row['matched']) or '—'} | {', '.join(row['invented']) or '—'} |"
        )
    lines.append("")

    # ── ALC's own bookkeeping, for the arms that ran it
    lines.append("## Cycle bookkeeping")
    lines.append("")
    lines.append("| arm | cycles/turn | tool calls/turn | findings/turn |")
    lines.append("| --- | --- | --- | --- |")
    for arm in arms:
        subset = _arm_rows(rows, arm.name, ["single", "seed"])
        if not subset:
            continue
        lines.append(
            f"| `{arm.name}` | {_median([float(r['alcCycles']) for r in subset])} | "
            f"{_median([float(r['alcToolCalls']) for r in subset])} | "
            f"{_median([float(r['alcFindings']) for r in subset])} |"
        )
    lines.append("")

    # ── The corpus self-check: every expected token must be in its own sources
    lines.append("## Corpus self-check")
    lines.append("")
    lines.append("| case | kind | expected token present in its sources? |")
    lines.append("| --- | --- | --- |")
    for case in ctx.corpus.cases:
        if not case.expect:
            lines.append(f"| {case.id} | {case.kind} | n/a (must stay unanswered) |")
            continue
        facts = normalise(ctx.corpus.facts_for(case))
        gaps = [token for token in case.expect if normalise(token) not in facts]
        mark = "✅" if not gaps else f"❌ {', '.join(gaps)}"
        lines.append(f"| {case.id} | {case.kind} | {mark} |")
    lines.append("")
    lines.append("_A ❌ means the fixture is wrong, not the arm: the harness would be asking for something its own sources do not say._")
    return "\n".join(lines)


# ─── CLI ────────────────────────────────────────────────────────────────
def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Measure whether ALC improves an answer.")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--arms", default="normal,alc-none,alc-raw,alc-heuristic", help=f"comma-separated; {', '.join(ARMS)}")
    parser.add_argument("--cases", default="", help="comma-separated case ids (default: all)")
    parser.add_argument("--limit", type=int, default=0, help="use only the first N cases")
    parser.add_argument("--docs", choices=["on", "off"], default="on")
    parser.add_argument("--web", choices=["on", "off"], default="off")
    parser.add_argument("--fake", choices=["oracle", "guesser"], default="", help="scripted model (harness self-test)")
    parser.add_argument("--label", default="live")
    parser.add_argument("--out-dir", default=str(REPORTS_DIR))
    parser.add_argument("--resume", action="store_true", help="skip turns already in the json")
    parser.add_argument("--keep", action="store_true", help="keep the scratch run directory")
    parser.add_argument("--run-dir", default="", help="scratch dir (default: a temp dir)")
    parser.add_argument("--timeout", type=float, default=600.0, help="seconds per turn")
    parser.add_argument(
        "--variant",
        default="classic",
        help="fact set: 'classic' (the fixed fixtures) or a seed number (fresh invented facts)",
    )
    parser.add_argument("--tag", default="", help="what is being measured, e.g. 'ALC v3' or 'kasalix-1.0-lora'")
    parser.add_argument(
        "--tavily-key",
        default="",
        help="Tavily key for --web on. Redacted from the report and scrubbed from the "
        "scratch settings afterwards; prefer the prompt so it never reaches a "
        "command line, which anything that can list processes can read",
    )
    parser.add_argument(
        "--suite",
        choices=[*SUITES, "all"],
        default="core",
        help="question set: core (the historical cases), hard (paraphrase/decoy/"
        "poisoned-note cases), or all. Runs from different suites are not comparable",
    )
    parser.add_argument(
        "--holdout-only",
        action="store_true",
        help="only the held-out cases, which are meant to be looked at rarely",
    )
    parser.add_argument("--list", action="store_true")
    return parser.parse_args(argv)


def resolve_variant(spec: str) -> Any:
    """``classic`` or a seed. A new seed is a new set of invented facts, so a
    model cannot pass a later generation by memorising an earlier one's fixture."""
    text = str(spec or "").strip().lower()
    if not text or text == "classic":
        return CLASSIC
    digits = text[5:] if text.startswith("seed-") else text
    if not digits.lstrip("-+").isdigit():
        raise ValueError(f"variant must be 'classic' or a seed number, not {spec!r}")
    return generated(int(digits))


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    # Point the app at scratch space BEFORE any app module is imported. The app
    # reads DATA_DIR lazily, but a run must never see (or touch) the real one.
    root = Path(args.run_dir) if args.run_dir else Path(tempfile.mkdtemp(prefix="alc-eval-"))
    (root / "bootstrap-data").mkdir(parents=True, exist_ok=True)
    os.environ["DATA_DIR"] = str(root / "bootstrap-data")

    if args.list:
        print("arms:")
        for name, arm in ARMS.items():
            ok, why = arm_available(arm)
            print(f"  {name:15s} {'ok   ' if ok else 'N/A  '} {arm.label}{'' if ok else f' — {why}'}")
        listed = resolve_variant(args.variant)
        print(f"\ncases (variant: {listed.name}, suite: {args.suite}):")
        for case in listed.cases:
            if args.suite != "all" and case.suite != args.suite:
                continue
            mark = " [holdout]" if case.holdout else ""
            print(f"  {case.id:20s} {case.kind:13s} {case.question[:68]}{mark}")
        return 0

    try:
        variant = resolve_variant(args.variant)
    except ValueError as err:
        print(str(err), file=sys.stderr)
        return 2

    chosen_cases = [
        case
        for case in variant.cases
        if args.suite == "all" or case.suite == args.suite
    ]
    if args.holdout_only:
        chosen_cases = [case for case in chosen_cases if case.holdout]
    if args.cases:
        wanted = {item.strip() for item in args.cases.split(",") if item.strip()}
        chosen_cases = [case for case in chosen_cases if case.id in wanted]
    if args.limit:
        chosen_cases = chosen_cases[: args.limit]
    if not chosen_cases:
        print(f"no cases in suite {args.suite!r} (have: {', '.join(SUITES)})", file=sys.stderr)
        return 2

    arms: list[Arm] = []
    for name in [item.strip() for item in args.arms.split(",") if item.strip()]:
        arm = ARMS.get(name)
        if arm is None:
            print(f"unknown arm: {name} (have: {', '.join(ARMS)})", file=sys.stderr)
            return 2
        ok, why = arm_available(arm)
        if not ok:
            print(f"skipping arm {name}: {why}", file=sys.stderr)
            continue
        arms.append(arm)
    if not arms:
        print("no runnable arms", file=sys.stderr)
        return 2

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / f"{args.label}.json"
    md_path = out_dir / f"{args.label}.md"
    started_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    corpus = build_corpus(root, variant=variant)
    ctx = RunContext(
        corpus=corpus,
        root=root,
        model=args.model,
        docs=args.docs == "on",
        web=args.web == "on",
        fake=FakeModel(args.fake) if args.fake else None,
        timeout=args.timeout,
        # An explicit --tavily-key wins, then the environment. The key is never
        # defaulted from anywhere else, and is never read back out of a report.
        tavily_key=(str(args.tavily_key or "").strip() or os.environ.get("TAVILY_API_KEY", "")),
        tag=str(args.tag or ""),
        keep_store=bool(args.keep),
        suite=str(args.suite),
    )

    rows: list[dict[str, Any]] = []
    done_keys: set[str] = set()
    if args.resume and json_path.exists():
        try:
            existing = json.loads(json_path.read_text(encoding="utf-8"))
            rows = list(existing.get("rows") or [])
            done_keys = {str(row.get("key")) for row in rows}
        except (OSError, ValueError) as err:
            print(f"could not resume {json_path}: {err}", file=sys.stderr)
            rows = []

    planned = [
        f"{arm.name}|{case.id}|{variant}"
        for arm in arms
        for case in chosen_cases
        for variant in ((["seed", "warm", "cold"] if case.kind == "carry" else ["single"]))
    ]
    todo = [key for key in planned if key not in done_keys]
    print(
        f"alc-eval: label={args.label} model={ctx.model} arms={','.join(a.name for a in arms)} "
        f"cases={len(chosen_cases)} turns={len(planned)} todo={len(todo)} docs={'on' if ctx.docs else 'off'} "
        f"web={'on' if ctx.web else 'off'}{' fake=' + args.fake if args.fake else ''}",
        flush=True,
    )
    if not todo:
        print("nothing to do — everything is already in the report (drop --resume to re-run)")

    def save() -> None:
        payload = {
            "label": args.label,
            "tag": str(args.tag or ""),
            # Both belong to a run's identity: a comparison across either one is
            # comparing different questions (suite) or different facts (variant).
            "suite": str(args.suite),
            "variant": corpus.variant,
            "model": ctx.model,
            "startedAt": started_at,
            # Whether a key was involved is a fact about the run and belongs in the
            # report; the key itself does not, so only the boolean is recorded.
            "usedTavilyKey": bool(ctx.tavily_key),
            # Redacted, not omitted: a report should show that a key was used
            # without carrying it. A report is a file that gets copied, quoted in
            # docs and committed; a key is not a result.
            "args": {
                key: ("(used, not saved)" if key in SECRET_ARGS and value else value)
                for key, value in vars(args).items()
            },
            "corpusRoot": str(root),
            "rows": rows,
        }
        json_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def on_row(row: dict[str, Any]) -> None:
        done_keys.add(str(row.get("key")))
        save()
        print(
            f"  {row['arm']:14s} {row['case']:20s} t{row['turn']} {row['variant']:6s} "
            f"{row['verdict']:8s} {row['total']:6.2f}s calls={row['calls']:2d}"
            + (f"  ERROR {row['error']}" if row.get("error") else ""),
            flush=True,
        )

    async def run() -> None:
        meter = Meter()
        install_meter(meter)
        apply_patches(web=ctx.web, fake=ctx.fake)
        try:
            for arm in arms:
                for case in chosen_cases:
                    keys = [f"{arm.name}|{case.id}|{v}" for v in (["seed", "warm", "cold"] if case.kind == "carry" else ["single"])]
                    if all(key in done_keys for key in keys) and args.resume:
                        continue
                    for row in await run_case(ctx, arm, case, meter):
                        if args.resume and str(row.get("key")) in done_keys:
                            continue
                        rows.append(row)
                        on_row(row)
        finally:
            restore_patches()

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        print("\ninterrupted — partial results are saved", file=sys.stderr)

    # Report every arm present in the rows, not just the ones this invocation ran:
    # `--resume` is how a long comparison is accumulated, and the whole point is
    # one table across all of them.
    report_arms = [ARMS[name] for name in ARMS if any(row.get("arm") == name for row in rows)]
    md_path.write_text(build_report(args.label, ctx, report_arms, rows), encoding="utf-8")
    print(f"\nwrote {json_path}\nwrote {md_path}")
    print(f"scratch: {root}" + ("" if args.keep else " (delete it yourself if you want it gone)"))
    if ctx.tavily_key:
        scrubbed = scrub_scratch_key(root)
        print(
            f"tavily key: used for this run, removed from {scrubbed} scratch settings "
            "file(s), and never written to the report"
        )

    # The verdict block, straight to stdout so a run can be read at a glance.
    first_turn = [row for row in rows if row.get("turn") == 1]
    for arm in report_arms:
        subset = [row for row in first_turn if row.get("arm") == arm.name]
        if subset:
            counts = tally(subset)["counts"]
            print(
                f"  {arm.name:14s} credit {tally(subset)['credit_rate']:.0%}  correct {counts['correct']}  "
                f"partial {counts['partial']}  admitted {counts['admitted']}  "
                f"invented {counts['invented']}  wrong {counts['wrong']}"
            )
    for arm in report_arms:
        if not arm.alc or not arm.write_knowledge:
            continue
        for case in chosen_cases:
            if case.kind != "carry":
                continue
            warm = [
                row
                for row in rows
                if row.get("case") == case.id and row.get("variant") == "warm" and row.get("arm") == arm.name
            ]
            cold = [
                row
                for row in rows
                if row.get("case") == case.id and row.get("variant") == "cold" and row.get("arm") == arm.name
            ]
            if warm or cold:
                print(
                    f"  carry {case.id:14s} {arm.name:11s} kept {_credit(warm):.0%}/{_recall(warm):.0%} "
                    f"wiped {_credit(cold):.0%}/{_recall(cold):.0%}"
                )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
