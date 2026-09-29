"""ALC controller — the cycle end to end, with the model scripted.

No Ollama is involved: the three model decisions are scripted by system prompt,
and the acting call is stubbed. What is being tested is the software
orchestration — what gets kept, what gets dropped, how the loop terminates, and
that a chat turn reaches ALC only when the client asked for it.
"""

from __future__ import annotations

import json
import os
import tempfile

import pytest

_TMP = tempfile.mkdtemp(prefix="kasalix-alc-controller-test-")
os.environ["DATA_DIR"] = _TMP
os.environ["OLLAMA_URL"] = "http://127.0.0.1:9"

from app.alc import controller, decide  # noqa: E402
from app.alc.controller import run_alc_turn  # noqa: E402
from app.alc.tools import ALCToolContext, available_tools  # noqa: E402
from app.settings_store import invalidate_settings_cache  # noqa: E402

DOC = "\n".join(
    [
        "# Game libraries",
        "",
        "## Pygame",
        "",
        "The event loop reads pygame.event.get() and KEYDOWN events carry event.key, "
        "for example pygame.K_LEFT. Use pygame.key.get_pressed() for held keys.",
        "",
        "## Requests",
        "",
        "Install requests with pip install requests.",
        "",
    ]
)


def configure_settings(tmp_path, monkeypatch, *, docs=True, web=False, **overrides):
    data_dir = tmp_path / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    docs_root = tmp_path / "documentation"
    docs_root.mkdir(exist_ok=True)
    (docs_root / "games.md").write_text(DOC, encoding="utf-8")

    settings = {
        "alcDocsPaths": [str(docs_root)] if docs else [],
        "alcMaxCycles": 3,
        "alcMaxToolCalls": 12,
        "alcMaxTokens": 4000,
        "alcWebEnabled": web,
    }
    settings.update(overrides)
    (data_dir / "settings.json").write_text(json.dumps(settings), encoding="utf-8")
    monkeypatch.setenv("DATA_DIR", str(data_dir))
    invalidate_settings_cache()
    return docs_root


DEFAULT_QUESTION = "pygame key events"


def script_model(monkeypatch, *, action_for=None, judge=None, intake=None):
    """Script the intake/action/judge calls; returns the list of prompts seen."""
    prompts: list[str] = []

    def default_action(pad, call_index):
        if call_index == 0:
            return (
                '{"action": "tool", "tool": "docs_search", '
                '"args": {"query": "pygame key events"}, "reason": "the docs cover pygame"}'
            )
        return '{"action": "act", "reason": "the gathered information is enough"}'

    state = {"actions": 0}

    async def fake_generate(conn, system, user, *, max_tokens=256):
        prompts.append(system)
        if "planning step of an information-gathering cycle" in system:
            if intake is not None:
                return intake
            return json.dumps(
                {
                    "goal": "handle pygame keyboard input",
                    "needs_info": True,
                    "questions": [DEFAULT_QUESTION],
                }
            )
        if "You control an information-gathering cycle" in system:
            index = state["actions"]
            state["actions"] += 1
            if action_for is not None:
                return action_for(index)
            return default_action(None, index)
        if "judge retrieved text" in system:
            if judge is not None:
                return judge
            return '{"keep": [{"i": 1, "why": "answers the question"}], "drop": []}'
        return ""

    monkeypatch.setattr(decide, "generate", fake_generate)
    return prompts


def stub_acting(monkeypatch, answer="ALC ANSWER"):
    """Replace the acting model call with a stub that records its messages."""
    import app.pipeline as pipeline

    captured: dict[str, object] = {}

    async def fake_loop(stage, model, messages, think, on_chunk, signal=None, extra_opts=None,
                        on_thinking=None, on_stage=None, tools_override=None, on_metrics=None):
        captured["messages"] = messages
        captured["model"] = model
        if on_chunk:
            on_chunk(answer)
        return answer

    monkeypatch.setattr(pipeline, "run_chat_tool_loop", fake_loop)
    return captured


async def run_turn(events, **extra):
    return await run_alc_turn(
        {
            "model": "test-model",
            "messages": [{"role": "user", "content": "How do I handle pygame key events?"}],
            "onChunk": lambda chunk: None,
            "onAlcEvent": events.append,
            **extra,
        }
    )


# ─── The happy path ─────────────────────────────────────────────────────
async def test_cycle_gathers_judges_then_answers(tmp_path, monkeypatch):
    configure_settings(tmp_path, monkeypatch)
    script_model(monkeypatch)
    captured = stub_acting(monkeypatch)
    events: list[dict] = []

    answer = await run_turn(events)

    assert answer == "ALC ANSWER"
    assert captured["model"] == "test-model"
    types = [event["type"] for event in events]
    for expected in ("alc:start", "alc:goal", "alc:search", "alc:result", "alc:finding", "alc:decision", "alc:budget", "alc:done"):
        assert expected in types, f"{expected} missing from {types}"

    finding = next(event for event in events if event["type"] == "alc:finding")
    assert "keydown" in finding["text"].lower()
    assert finding["reason"] == "answers the question"

    briefing = "\n".join(
        str(message["content"])
        for message in captured["messages"]
        if message.get("role") == "system"
    )
    assert "keydown" in briefing.lower(), "the answer must be composed from the finding"
    assert "pygame.event.get()" in briefing

    done = next(event for event in events if event["type"] == "alc:done")
    assert done["findings"] == 1
    assert done["toolCalls"] == 1


# ─── The answer gate (D13) ─────────────────────────────────────────────
async def test_a_fabricated_value_never_reaches_the_client(tmp_path, monkeypatch):
    """The whole point of the guard: the wrong number is not merely apologised for.

    The chat route forwards chunks to the client verbatim and nothing reconciles
    them with the final message, so a value that streams once is in the transcript
    for good — and in the scored answer. It must never stream at all.
    """
    configure_settings(tmp_path, monkeypatch)
    script_model(monkeypatch)
    stub_acting(monkeypatch, answer="The default is 12345 frames per second.\n")
    events: list[dict] = []
    chunks: list[str] = []

    answer = await run_turn(events, onChunk=chunks.append)

    streamed = "".join(chunks)
    assert "12345" not in streamed
    assert "12345" not in answer
    assert "could not verify" in streamed
    assert streamed == answer, "what was streamed and what is stored must agree"

    verify = next(event for event in events if event["type"] == "alc:verify")
    assert verify["enabled"] is True
    assert verify["blocked"] == 1
    assert "12345" in verify["claims"], "the trajectory still records what was withheld"


async def test_a_grounded_answer_is_left_completely_alone(tmp_path, monkeypatch):
    configure_settings(tmp_path, monkeypatch)
    script_model(monkeypatch)
    stub_acting(monkeypatch, answer="Read pygame key events with pygame.event.get().\n")
    events: list[dict] = []
    chunks: list[str] = []

    answer = await run_turn(events, onChunk=chunks.append)

    assert answer == "Read pygame key events with pygame.event.get().\n"
    assert "".join(chunks) == answer
    verify = next(event for event in events if event["type"] == "alc:verify")
    assert verify["blocked"] == 0


async def test_the_answer_check_can_be_switched_off_for_measurement(tmp_path, monkeypatch):
    configure_settings(tmp_path, monkeypatch)
    script_model(monkeypatch)
    stub_acting(monkeypatch, answer="The default is 12345 frames.\n")
    events: list[dict] = []
    chunks: list[str] = []

    answer = await run_turn(events, onChunk=chunks.append, alcAnswerGuard=False)

    assert "12345" in "".join(chunks)
    assert answer == "".join(chunks)
    verify = next(event for event in events if event["type"] == "alc:verify")
    assert verify["enabled"] is False
    assert verify["blocked"] == 0


async def test_the_prompt_lists_the_values_the_answer_may_use(tmp_path, monkeypatch):
    """Prevention beats correction: most fabrications never happen when the model
    can see which specifics its evidence actually contains."""
    configure_settings(tmp_path, monkeypatch)
    script_model(monkeypatch)
    captured = stub_acting(monkeypatch)

    await run_turn([])

    system = "\n".join(
        str(message["content"]) for message in captured["messages"] if message.get("role") == "system"
    )
    assert "VALUES YOU MAY USE" in system
    assert "pygame.event.get" in system


async def test_the_prompt_hint_never_promotes_the_question_to_evidence(tmp_path, monkeypatch):
    """A question naming an undocumented function must not look like a found fact.

    The gate may repeat a value the USER supplied; the prompt may not present it
    as retrieved evidence, or a model that echoes the question would score as one
    that retrieved the answer.
    """
    configure_settings(tmp_path, monkeypatch, docs=False)
    script_model(monkeypatch)
    captured = stub_acting(monkeypatch)

    await run_turn(
        [],
        messages=[
            {
                "role": "user",
                "content": "What is the default of brimwall_set_ceiling_quota()?",
            }
        ],
    )

    system = "\n".join(
        str(message["content"]) for message in captured["messages"] if message.get("role") == "system"
    )
    assert "NOTHING TO CITE" in system
    assert "brimwall_set_ceiling_quota" not in system


async def test_nothing_retrieved_still_gets_a_honesty_instruction(tmp_path, monkeypatch):
    """No findings at all is exactly the turn where a small model invents a value."""
    configure_settings(tmp_path, monkeypatch, docs=False)
    script_model(monkeypatch)
    captured = stub_acting(monkeypatch, answer="The pace limiter defaults to 1000.\n")
    events: list[dict] = []
    chunks: list[str] = []

    answer = await run_turn(events, onChunk=chunks.append)

    system = "\n".join(
        str(message["content"]) for message in captured["messages"] if message.get("role") == "system"
    )
    assert "NOTHING TO CITE" in system
    assert "1000" not in answer
    assert "not going to guess" in answer
    assert "".join(chunks) == answer


# ─── Conflicts resolved in software (D12) ───────────────────────────────
async def test_two_documents_that_disagree_are_settled_before_answering(tmp_path, monkeypatch):
    import os
    import time
    from pathlib import Path

    docs_root = configure_settings(tmp_path, monkeypatch)
    older = Path(docs_root) / "pace-old.md"
    newer = Path(docs_root) / "pace-new.md"
    older.write_text(
        "## Pace\n\nVINTRA_PACE defaults to 12 in the older reference.\n", encoding="utf-8"
    )
    newer.write_text(
        "## Pace\n\nVINTRA_PACE defaults to 16 in the current reference.\n", encoding="utf-8"
    )
    # The conflict is settled by which file is newer, so make that explicit.
    a_year_ago = time.time() - 365 * 24 * 3600
    os.utime(older, (a_year_ago, a_year_ago))

    script_model(
        monkeypatch,
        action_for=lambda index: (
            '{"action": "tool", "tool": "docs_search", '
            '"args": {"query": "vintra pace"}, "reason": "both files mention it"}'
            if index == 0
            else '{"action": "act", "reason": "enough"}'
        ),
        judge='{"keep": [{"i": 1, "why": "the old value"}, {"i": 2, "why": "the current value"}], "drop": []}',
    )
    captured = stub_acting(monkeypatch, answer="VINTRA_PACE defaults to 16 frames.\n")
    events: list[dict] = []

    await run_turn(events)

    conflict = next(event for event in events if event["type"] == "alc:conflict")
    assert conflict["count"] == 1
    assert "vintrapace" in [name.lower() for name in conflict["names"]]

    system = "\n".join(
        str(message["content"]) for message in captured["messages"] if message.get("role") == "system"
    )
    assert "SOURCES DISAGREE" in system
    block = system.split("SOURCES DISAGREE", 1)[1]
    assert "16" in block.split("INSTRUCTIONS", 1)[0], "the newer value is named as current"


# ─── Coverage-based stopping (D14) ─────────────────────────────────────
async def test_gathering_stops_once_every_question_is_covered(tmp_path, monkeypatch):
    configure_settings(tmp_path, monkeypatch)
    queries = ["pygame key events", "install requests"]
    script_model(
        monkeypatch,
        action_for=lambda index: (
            '{"action": "tool", "tool": "docs_search", "args": {"query": "%s"}, "reason": "more"}'
            % queries[index]
            if index < len(queries)
            else '{"action": "act", "reason": "enough"}'
        ),
    )
    stub_acting(monkeypatch)
    events: list[dict] = []

    await run_turn(events)

    decisions = [event for event in events if event["type"] == "alc:decision"]
    assert decisions[-1]["forced"] is True
    assert "covered" in decisions[-1]["reason"]
    assert next(event for event in events if event["type"] == "alc:done")["toolCalls"] == 2


# ─── Widening a hit to its neighbour (D12) ─────────────────────────────
def test_a_kept_hit_is_widened_to_the_neighbouring_section(tmp_path, monkeypatch):
    """The multi-hop win: name in one section, value in the next."""
    from pathlib import Path

    from app.alc import docs as alc_docs
    from app.alc import tools as alc_tools

    root = tmp_path / "wide"
    root.mkdir()
    target = root / "pace.md"
    target.write_text(
        "# Vintra\n\n"
        "## Pace limiter\n\n"
        "Vintra paces the clock with the VINTRA_PACE limiter, configured in vintra.toml.\n\n"
        "## Limiter defaults\n\n"
        "The VINTRA_PACE limiter defaults to 16, and the ceiling is 4000.\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    alc_docs.build_index([str(root)])
    hits = alc_docs.search("vintra pace limiter", roots=[str(root)], k=2)
    first = next(hit for hit in hits if "defaults to 16" not in hit["text"])
    candidate = {
        "path": first["path"],
        "chunk": first["chunk"],
        "text": first["text"],
        "heading": first["heading"],
    }

    widened = alc_tools.expand_doc_text(candidate, query="vintra pace limiter")

    assert widened, "the neighbouring section should have been fetched"
    assert "adjacent section" in widened
    assert "defaults to 16" in widened, "the value was one chunk away"


def test_an_unrelated_neighbour_is_not_glued_on(tmp_path, monkeypatch):
    from app.alc import docs as alc_docs
    from app.alc import tools as alc_tools

    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(
        alc_docs, "neighbours", lambda *_a, **_k: [{"path": "x.md", "chunk": 1, "heading": "", "text": "unrelated cooking notes"}]
    )
    candidate = {"path": "x.md", "chunk": 0, "text": "VINTRA_PACE limiter", "heading": "Vintra"}
    assert alc_tools.expand_doc_text(candidate, query="vintra pace limiter") == ""
    assert alc_tools.expand_doc_text({"chunk": None}, query="x") == ""


async def test_rejected_candidates_are_reported_not_kept(tmp_path, monkeypatch):
    configure_settings(tmp_path, monkeypatch)
    script_model(
        monkeypatch,
        judge='{"keep": [], "drop": [{"i": 1, "why": "off-topic for this question"}]}',
    )
    stub_acting(monkeypatch)
    events: list[dict] = []

    await run_turn(events)

    types = [event["type"] for event in events]
    assert "alc:finding" not in types
    reject = next(event for event in events if event["type"] == "alc:reject")
    assert reject["reason"] == "off-topic for this question"
    assert "alc:gap" in types, "an empty judgement must be recorded as a gap"


# ─── Termination ────────────────────────────────────────────────────────
async def test_cycle_budget_stops_a_model_that_never_stops(tmp_path, monkeypatch):
    configure_settings(tmp_path, monkeypatch, alcMaxCycles=2)
    counter = {"n": 0}

    def always_search(index):
        counter["n"] += 1
        return (
            '{"action": "tool", "tool": "docs_search", '
            f'"args": {{"query": "pygame question {counter["n"]}"}}, "reason": "keep looking"}}'
        )

    script_model(monkeypatch, action_for=always_search)
    stub_acting(monkeypatch)
    events: list[dict] = []

    answer = await run_turn(events)

    assert answer == "ALC ANSWER", "the acting phase must always be reached"
    searched = [event for event in events if event["type"] == "alc:search"]
    assert len(searched) <= 2
    forced = [event for event in events if event["type"] == "alc:decision" and event.get("forced")]
    assert forced and "budget" in forced[0]["reason"]


async def test_repeating_the_same_query_is_vetoed_instead_of_looping(tmp_path, monkeypatch):
    configure_settings(tmp_path, monkeypatch, alcMaxCycles=3)

    def same_query(index):
        return (
            '{"action": "tool", "tool": "docs_search", '
            '"args": {"query": "pygame key events"}, "reason": "again"}'
        )

    script_model(monkeypatch, action_for=same_query)
    stub_acting(monkeypatch)
    events: list[dict] = []

    await run_turn(events)

    searched = [event for event in events if event["type"] == "alc:search"]
    assert len(searched) == 1, "an identical lookup must never run twice in one turn"
    vetoes = [event for event in events if event["type"] == "alc:reject" and "already tried" in event.get("reason", "")]
    assert vetoes
    # With evidence already in hand, a repeated lookup ends the cycle instead of
    # quietly burning the remaining budget.
    decisions = [event for event in events if event["type"] == "alc:decision"]
    assert decisions[-1]["action"] == "act"
    assert "repeated a lookup" in decisions[-1]["reason"]
    assert not decisions[-1].get("forced")


async def test_no_sources_configured_answers_without_calling_the_model(tmp_path, monkeypatch):
    configure_settings(tmp_path, monkeypatch, docs=False, web=False)
    prompts = script_model(monkeypatch)
    stub_acting(monkeypatch)
    events: list[dict] = []

    answer = await run_turn(events)

    assert answer == "ALC ANSWER"
    assert prompts == [], "with nothing to search there is nothing to ask about"
    notice = next(event for event in events if event["type"] == "alc:notice")
    assert notice["kind"] == "no-sources"


async def test_small_talk_skips_the_cycle_entirely(tmp_path, monkeypatch):
    configure_settings(tmp_path, monkeypatch)
    prompts = script_model(monkeypatch)
    stub_acting(monkeypatch, answer="hey!")
    events: list[dict] = []

    answer = await run_alc_turn(
        {
            "model": "test-model",
            "messages": [{"role": "user", "content": "thanks!"}],
            "onChunk": lambda chunk: None,
            "onAlcEvent": events.append,
        }
    )

    assert answer == "hey!"
    assert prompts == [], "small talk must not pay for an intake call"
    assert "alc:goal" not in [event["type"] for event in events]


# ─── Failure handling ───────────────────────────────────────────────────
async def test_a_lookup_that_finds_nothing_is_retried_then_reported(tmp_path, monkeypatch):
    configure_settings(tmp_path, monkeypatch, alcMaxCycles=2)

    def no_such_topic(index):
        if index == 0:
            return (
                '{"action": "tool", "tool": "docs_search", '
                '"args": {"query": "how do I configure zzqqxx"}, "reason": "look it up"}'
            )
        return '{"action": "act", "reason": "nothing else to try"}'

    script_model(monkeypatch, action_for=no_such_topic)
    captured = stub_acting(monkeypatch)
    events: list[dict] = []

    await run_turn(events)

    searches = [event for event in events if event["type"] == "alc:search"]
    assert len(searches) == 2, "an empty lookup is retried once with a reformulated query"
    assert searches[0]["query"] != searches[1]["query"]
    gaps = [event for event in events if event["type"] == "alc:gap"]
    assert gaps, "the unresolved gap must be recorded"
    briefing = "\n".join(
        str(message["content"])
        for message in captured["messages"]
        if message.get("role") == "system"
    )
    assert "could not check" in briefing, "the answer must say the lookup failed"


async def test_a_crashing_model_decision_falls_back_and_still_answers(tmp_path, monkeypatch):
    configure_settings(tmp_path, monkeypatch)
    script_model(monkeypatch, action_for=lambda index: "I'm not sure, let me think about it.")
    stub_acting(monkeypatch)
    events: list[dict] = []

    answer = await run_turn(events)

    assert answer == "ALC ANSWER"
    decisions = [event for event in events if event["type"] == "alc:decision"]
    assert any(event.get("fallback") for event in decisions), "the heuristic fallback must be marked"


# ─── Weak-model guards ──────────────────────────────────────────────────
@pytest.mark.parametrize("args", ["{}", '{"query": "<search terms>"}', '{"query": ""}'])
async def test_a_tool_call_without_a_real_query_searches_the_open_question(tmp_path, monkeypatch, args):
    """A model that names the tool but forgets the query must not search the example text."""
    import json as _json

    configure_settings(tmp_path, monkeypatch)
    script_model(
        monkeypatch,
        intake=_json.dumps(
            {
                "goal": "find the zorbnik pace setter",
                "needs_info": True,
                "questions": ["zorbnik blitter pace"],
            }
        ),
        action_for=lambda index, args=args: (
            '{"action": "tool", "tool": "docs_search", "args": ' + args + "}"
            if index == 0
            else '{"action": "act", "reason": "done"}'
        ),
    )
    stub_acting(monkeypatch)
    events: list[dict] = []

    await run_turn(events)

    search = next(event for event in events if event["type"] == "alc:search")
    assert search["query"] == "zorbnik blitter pace"
    assert search["substituted"] is True
    assert search["query"] != "pygame key events", "the tool's example is not a real lookup"


async def test_a_gap_that_only_echoes_an_open_question_is_not_recorded(tmp_path, monkeypatch):
    configure_settings(tmp_path, monkeypatch)
    script_model(
        monkeypatch,
        action_for=lambda index: json.dumps(
            {"action": "act", "reason": "nothing else to try", "gaps": [DEFAULT_QUESTION]}
        ),
    )
    stub_acting(monkeypatch)
    events: list[dict] = []

    await run_turn(events)

    assert not [event for event in events if event["type"] == "alc:gap"], (
        "an unanswered question is not a gap — the briefing already lists it"
    )


async def test_a_real_gap_is_recorded(tmp_path, monkeypatch):
    configure_settings(tmp_path, monkeypatch)
    script_model(
        monkeypatch,
        action_for=lambda index: json.dumps(
            {"action": "act", "reason": "done", "gaps": ["the joystick API was never covered"]}
        ),
    )
    stub_acting(monkeypatch)
    events: list[dict] = []

    await run_turn(events)

    gaps = [event["gap"] for event in events if event["type"] == "alc:gap"]
    assert "the joystick API was never covered" in gaps


async def test_a_source_that_came_up_empty_is_replaced_by_an_untried_one(tmp_path, monkeypatch):
    """The model keeps asking an empty source; the controller moves to a source it has not tried."""
    workspace = koding_env(tmp_path, monkeypatch)
    from app.alc import knowledge

    knowledge.remember(
        workspace,
        "pacing",
        "The blitter pace is set with zorb_set_pace(frames); the default is 12 frames.",
        source="docs:zorbnik.md",
    )

    def action(index):
        # The model insists on the documentation, which has nothing about zorbnik.
        return (
            '{"action": "tool", "tool": "docs_search", '
            '"args": {"query": "zzqqxx zorbnik pace"}, "reason": "docs first"}'
        )

    script_model(monkeypatch, action_for=action, intake=json.dumps(
        {"goal": "set the zorbnik pace", "needs_info": True, "questions": ["zorbnik blitter pace"]}
    ))
    events: list[dict] = []

    briefing = await run_gather(events, workspace)

    tools_used = [event["tool"] for event in events if event["type"] == "alc:search"]
    assert tools_used[0] == "docs_search"
    assert "knowledge_search" in tools_used, "the fallback must reach the untried source"
    switched = [
        event
        for event in events
        if event["type"] == "alc:decision" and event.get("fallback") and event.get("tool")
    ]
    assert switched and "came up empty" in switched[0]["reason"]
    assert "zorb_set_pace" in briefing, "the fallback recovered the answer"


async def test_when_every_source_is_empty_the_cycle_acts(tmp_path, monkeypatch):
    workspace = koding_env(tmp_path, monkeypatch)

    def action(index):
        return (
            '{"action": "tool", "tool": "docs_search", '
            '"args": {"query": "zzqqxx nothing matches"}, "reason": "docs"}'
        )

    script_model(monkeypatch, action_for=action)
    events: list[dict] = []

    await run_gather(events, workspace)

    searches = [event for event in events if event["type"] == "alc:search"]
    tools = [event["tool"] for event in searches]
    # One attempt, its documented reformulated retry, then the untried source.
    assert tools == ["docs_search", "docs_search", "knowledge_search"]
    assert searches[1]["query"] != searches[0]["query"], "the retry reformulates"
    decisions = [event for event in events if event["type"] == "alc:decision"]
    assert any("every available source" in event.get("reason", "") for event in decisions)
    assert events[-1]["type"] == "alc:done"
    assert not [event for event in events if event["type"] == "alc:finding"]


# ─── Tool argument handling ─────────────────────────────────────────────
def test_make_args_never_fills_the_primary_argument_from_the_example():
    from app.alc.tools import DOCS_SEARCH, DOCS_OPEN, make_args, primary_arg

    assert make_args(DOCS_SEARCH, {}) == {"k": 4}, "no query means no query — not the example"
    assert make_args(DOCS_SEARCH, {"query": "pygame"}) == {"query": "pygame", "k": 4}
    assert make_args(DOCS_OPEN, {"path": "C:/docs/a.md"}) == {"path": "C:/docs/a.md", "line": 1}
    assert primary_arg(DOCS_SEARCH) == "query"
    assert primary_arg(DOCS_OPEN) == "path"


# ─── Tool availability ──────────────────────────────────────────────────
def test_web_tools_are_not_offered_when_web_is_disabled():
    ctx = ALCToolContext(roots=["C:/docs"], web_enabled=False)
    names = {tool["name"] for tool in available_tools(ctx)}
    assert names == {"docs_search", "docs_open"}


def test_docs_tools_are_not_offered_without_configured_folders():
    ctx = ALCToolContext(roots=[], web_enabled=True)
    assert {tool["name"] for tool in available_tools(ctx)} == {"web_search", "read_url"}


def test_project_knowledge_tools_need_a_workspace_not_a_mode():
    """Project knowledge is gated on having a project directory, not on Koding.

    It used to be Koding-only ("chat has no project directory"). A chat
    conversation with a workspace attached DOES have one, and excluding it meant
    chat could gather and then keep nothing — so a later turn re-searched the same
    facts forever (docs/ALC_DESIGN.md D8, amended in Phase 4).
    """
    names = lambda ctx: {tool["name"] for tool in available_tools(ctx)}  # noqa: E731
    chat = ALCToolContext(roots=[], web_enabled=False, mode="chat", workspace="C:/proj")
    assert names(chat) == {"knowledge_search", "knowledge_write"}

    # No directory: nothing to remember into, in either engine.
    no_workspace_chat = ALCToolContext(roots=[], web_enabled=False, mode="chat")
    assert "knowledge_search" not in names(no_workspace_chat)
    no_workspace = ALCToolContext(roots=[], web_enabled=False, mode="agent")
    assert "knowledge_search" not in names(no_workspace)

    koding = ALCToolContext(roots=[], web_enabled=False, mode="agent", workspace="C:/proj")
    assert names(koding) == {"knowledge_search", "knowledge_write"}


# ─── Pipeline routing ───────────────────────────────────────────────────
@pytest.fixture()
def routed_pipeline(tmp_path, monkeypatch):
    """run_pipeline with cloud/model resolution stubbed out."""
    import app.pipeline as pipeline

    monkeypatch.setenv("DATA_DIR", str(tmp_path / "route-data"))

    async def fake_cloud_settings():
        return {"cloudMode": "local", "cloudApiKey": "", "cloudEndpoint": ""}

    async def fake_resolved(category):
        return {"model": "test-model", "source": "local"}

    async def fake_assignment(category):
        return "test-model"

    async def fake_search_plan(*args, **kwargs):
        return {"query": None, "context": None, "source": "skip", "reason": "test", "found": False, "attempts": []}

    monkeypatch.setattr(pipeline, "get_cloud_settings", fake_cloud_settings)
    monkeypatch.setattr(pipeline, "get_resolved_model", fake_resolved)
    monkeypatch.setattr(pipeline, "get_model_assignment", fake_assignment)
    monkeypatch.setattr(pipeline, "plan_search", fake_search_plan)
    return pipeline


async def test_chat_turn_with_alc_reaches_the_cycle(routed_pipeline, monkeypatch):
    import app.alc as alc_pkg

    seen: dict = {}

    async def fake_alc(opts):
        seen["opts"] = opts
        return "ALC TURN"

    monkeypatch.setattr(alc_pkg, "run_alc_turn", fake_alc)
    out = await routed_pipeline.run_pipeline(
        {
            "model": "test-model",
            "messages": [{"role": "user", "content": "how do pygame key events work"}],
            "mode": "chat",
            "alc": True,
            "thinkingEnabled": False,
            "onChunk": lambda chunk: None,
        }
    )
    assert out == "ALC TURN"
    assert seen["opts"]["model"] == "test-model"
    assert seen["opts"]["think"] is False


async def test_chat_turn_without_alc_stays_on_the_normal_path(routed_pipeline, monkeypatch):
    import app.alc as alc_pkg

    async def explode(opts):  # pragma: no cover - must never run
        raise AssertionError("ALC must not run when the client did not ask for it")

    async def fake_loop(stage, model, messages, think, on_chunk, signal=None, extra_opts=None,
                        on_thinking=None, on_stage=None, tools_override=None, on_metrics=None):
        on_chunk("NORMAL ANSWER")
        return "NORMAL ANSWER"

    monkeypatch.setattr(alc_pkg, "run_alc_turn", explode)
    monkeypatch.setattr(routed_pipeline, "run_chat_tool_loop", fake_loop)

    out = await routed_pipeline.run_pipeline(
        {
            "model": "test-model",
            "messages": [{"role": "user", "content": "hello there"}],
            "mode": "chat",
            "thinkingEnabled": False,
            "onChunk": lambda chunk: None,
        }
    )
    assert out == "NORMAL ANSWER"


async def test_koding_turn_gathers_then_briefs_the_agent_loop(routed_pipeline, monkeypatch):
    """Phase 2: in Koding, ALC gathers first and the agent loop receives the briefing."""
    import app.agent as agent
    import app.alc as alc_pkg

    seen: dict = {}

    async def fake_gather(opts):
        seen["gather_opts"] = opts
        # The gather's events must still reach the client even though the
        # pipeline wraps the callback to collect them for the session log.
        opts["onAlcEvent"]({"type": "alc:goal", "goal": "add a jump button"})
        return "[ALC — INFORMATION GATHERED IN THIS CYCLE]\n[1]\nKEYDOWN carries event.key."

    async def fake_agent_loop(opts):
        seen["agent_opts"] = opts
        return "AGENT ANSWER"

    monkeypatch.setattr(alc_pkg, "run_alc_gather", fake_gather)
    monkeypatch.setattr(agent, "run_agent_loop", fake_agent_loop)

    events: list[dict] = []
    out = await routed_pipeline.run_pipeline(
        {
            "model": "test-model",
            "messages": [{"role": "user", "content": "add a jump button"}],
            "mode": "agent",
            "alc": True,
            "autoApply": True,
            "thinkingEnabled": False,
            "onChunk": lambda chunk: None,
            "onAlcEvent": events.append,
        }
    )

    assert out == "AGENT ANSWER"
    assert seen["gather_opts"]["alc"] is True
    assert seen["gather_opts"]["model"] == "test-model"
    assert "KEYDOWN" in str(seen["agent_opts"]["extraContext"]), (
        "the gathered evidence must reach the agent loop"
    )
    assert {"type": "alc:goal", "goal": "add a jump button"} in events
    assert [event["type"] for event in seen["agent_opts"]["alcEvents"]] == ["alc:goal"], (
        "ALC events are handed to the agent loop for the session log"
    )


async def test_koding_without_autoapply_notices_and_runs_normally(routed_pipeline, monkeypatch):
    """ALC in Koding means the coding agent: a conversational Koding turn falls through."""
    import app.alc as alc_pkg

    async def explode(opts):  # pragma: no cover - must never run
        raise AssertionError("ALC needs the coding agent (auto-apply)")

    async def fake_visible(stage, model, messages, think, on_chunk, signal=None, extra_opts=None,
                           on_thinking=None, on_metrics=None):
        on_chunk("AGENT ANSWER")
        return "AGENT ANSWER"

    monkeypatch.setattr(alc_pkg, "run_alc_gather", explode)
    monkeypatch.setattr(routed_pipeline, "run_visible_stage", fake_visible)

    events: list[dict] = []
    out = await routed_pipeline.run_pipeline(
        {
            "model": "test-model",
            "messages": [{"role": "user", "content": "what does this project do"}],
            "mode": "agent",
            "alc": True,
            "thinkingEnabled": False,
            "onChunk": lambda chunk: None,
            "onAlcEvent": events.append,
        }
    )

    assert out == "AGENT ANSWER"
    notice = next(event for event in events if event["type"] == "alc:notice")
    assert notice["kind"] == "unsupported-turn"
    assert "auto-apply" in notice["message"]


# ─── Phase 2: Koding ────────────────────────────────────────────────────
def koding_env(tmp_path, monkeypatch, *, docs=True, web=False, **overrides) -> str:
    """Settings plus a project directory; returns the workspace path."""
    configure_settings(tmp_path, monkeypatch, docs=docs, web=web, **overrides)
    project = tmp_path / "project"
    project.mkdir(exist_ok=True)
    return str(project)


async def run_gather(events: list[dict], workspace: str | None, **extra) -> str:
    from app.alc import run_alc_gather

    return await run_alc_gather(
        {
            "model": "test-model",
            "mode": "agent",
            "workspacePath": workspace,
            "messages": [{"role": "user", "content": "How do I handle pygame key events?"}],
            "onChunk": lambda chunk: None,
            "onAlcEvent": events.append,
            **extra,
        }
    )


async def test_koding_gather_briefs_the_agent_and_saves_knowledge(tmp_path, monkeypatch):
    workspace = koding_env(tmp_path, monkeypatch)
    script_model(monkeypatch)
    events: list[dict] = []

    briefing = await run_gather(events, workspace)

    assert "keydown" in briefing.lower(), "the agent must be briefed with the evidence"
    assert "alc:knowledge-written" in [event["type"] for event in events]
    # The knowledge listing only points at notes that existed when the cycle
    # started — this turn's own notes are already in the briefing as findings.

    from app.alc import knowledge

    entries = knowledge.read_index(workspace)
    assert len(entries) == 1
    assert entries[0]["source"], "provenance is kept"
    note = knowledge.knowledge_dir(workspace) / entries[0]["file"]
    assert "event.key" in note.read_text(encoding="utf-8")


async def test_the_acting_model_is_not_called_in_koding(tmp_path, monkeypatch):
    """The agent loop does the work — the gather must not also answer."""
    workspace = koding_env(tmp_path, monkeypatch)
    script_model(monkeypatch)

    async def explode(*args, **kwargs):  # pragma: no cover - must never run
        raise AssertionError("Koding acting is the agent loop, not ALC's chat answer")

    import app.pipeline as pipeline

    monkeypatch.setattr(pipeline, "run_chat_tool_loop", explode)
    assert await run_gather([], workspace)


async def test_a_later_cycle_finds_what_an_earlier_one_learned(tmp_path, monkeypatch):
    workspace = koding_env(tmp_path, monkeypatch, docs=False)
    from app.alc import knowledge

    knowledge.remember(
        workspace,
        "pygame input",
        "Pygame reads KEYDOWN through pygame.event.get(); event.key carries pygame.K_LEFT.",
        tags=["pygame"],
        source="docs:games.md#Pygame",
    )

    def action(index):
        if index == 0:
            return (
                '{"action": "tool", "tool": "knowledge_search", '
                '"args": {"query": "pygame key events"}, "reason": "we may have notes"}'
            )
        return '{"action": "act", "reason": "found the note"}'

    script_model(monkeypatch, action_for=action)
    events: list[dict] = []

    briefing = await run_gather(events, workspace)

    searches = [event for event in events if event["type"] == "alc:search"]
    assert searches and searches[0]["tool"] == "knowledge_search"
    assert "KEYDOWN" in briefing, "project knowledge reached the agent's briefing"
    assert "ALC/knowledge/pygame-input.md" in briefing, (
        "the agent is pointed at the notes it can read for more"
    )
    finding = next(event for event in events if event["type"] == "alc:finding")
    assert finding["source"].startswith("knowledge:")


async def test_the_model_can_remember_something_itself(tmp_path, monkeypatch):
    workspace = koding_env(tmp_path, monkeypatch, docs=False)
    from app.alc import knowledge

    def action(index):
        if index == 0:
            return (
                '{"action": "tool", "tool": "knowledge_write", "args": {"topic": "testing", '
                '"body": "Run the suite with python -m pytest tests/ -q.", "tags": ["testing"]}}'
            )
        return '{"action": "act", "reason": "saved"}'

    script_model(monkeypatch, action_for=action)
    events: list[dict] = []

    await run_gather(events, workspace)

    assert [entry["slug"] for entry in knowledge.read_index(workspace)] == ["testing"]
    written = next(event for event in events if event["type"] == "alc:knowledge-written")
    assert written["source"] == "model"


async def test_read_only_sessions_do_not_change_project_knowledge(tmp_path, monkeypatch):
    workspace = koding_env(tmp_path, monkeypatch)
    script_model(monkeypatch)
    events: list[dict] = []

    briefing = await run_gather(events, workspace, toolPermission="read-only")

    from app.alc import knowledge

    assert knowledge.read_index(workspace) == []
    notice = next(event for event in events if event["type"] == "alc:notice")
    assert notice["kind"] == "read-only"
    assert briefing, "read-only still gathers and briefs — it just does not write"


async def test_read_only_blocks_the_models_own_write(tmp_path, monkeypatch):
    workspace = koding_env(tmp_path, monkeypatch, docs=False)
    from app.alc import knowledge

    def action(index):
        if index == 0:
            return (
                '{"action": "tool", "tool": "knowledge_write", '
                '"args": {"topic": "secrets", "body": "api key = abc"}}'
            )
        return '{"action": "act", "reason": "never mind"}'

    script_model(monkeypatch, action_for=action)
    events: list[dict] = []

    await run_gather(events, workspace, toolPermission="read-only")

    rejects = [event for event in events if event["type"] == "alc:reject"]
    assert any("read-only" in event["reason"] for event in rejects)
    assert knowledge.read_index(workspace) == []
    assert not list((tmp_path / "project" / "ALC").rglob("*.md")) if (tmp_path / "project" / "ALC").exists() else True


async def test_write_back_is_skipped_when_the_setting_is_off(tmp_path, monkeypatch):
    workspace = koding_env(tmp_path, monkeypatch, alcWriteKnowledge=False)
    script_model(monkeypatch)
    events: list[dict] = []

    briefing = await run_gather(events, workspace)

    from app.alc import knowledge

    assert knowledge.read_index(workspace) == []
    assert "knowledge-written" not in "".join(event["type"] for event in events)
    assert "keydown" in briefing.lower(), "the briefing still happens"


async def test_koding_with_no_sources_at_all_returns_no_briefing(tmp_path, monkeypatch):
    """No docs, no web, no project directory: the agent runs exactly as in Normal mode."""
    koding_env(tmp_path, monkeypatch, docs=False, web=False)
    prompts = script_model(monkeypatch)
    events: list[dict] = []

    briefing = await run_gather(events, None)

    assert briefing == ""
    assert prompts == [], "with nothing to search there is nothing to ask"
    notice = next(event for event in events if event["type"] == "alc:notice")
    assert notice["kind"] == "no-sources"


async def test_an_empty_knowledge_store_still_runs_a_cycle(tmp_path, monkeypatch):
    """Project knowledge is a source on its own — an empty store is searched and reported."""
    workspace = koding_env(tmp_path, monkeypatch, docs=False, web=False)

    def action(index):
        if index == 0:
            return (
                '{"action": "tool", "tool": "knowledge_search", '
                '"args": {"query": "pygame key events"}, "reason": "check our notes"}'
            )
        return '{"action": "act", "reason": "no notes"}'

    script_model(monkeypatch, action_for=action)
    events: list[dict] = []

    briefing = await run_gather(events, workspace)

    assert briefing == "", "nothing was found, so the agent gets no briefing"
    types = [event["type"] for event in events]
    assert "alc:search" in types and "alc:gap" in types
    gap = next(event for event in events if event["type"] == "alc:gap")
    assert "nothing has been saved" in gap["gap"], "an empty store says so instead of looking broken"


# ─── Settings ───────────────────────────────────────────────────────────
async def test_budgets_are_clamped_not_trusted(tmp_path, monkeypatch):
    """A hand-edited settings.json must not be able to unbind the gather loop."""
    from app.settings_store import get_alc_settings

    configure_settings(tmp_path, monkeypatch, alcMaxCycles=99, alcMaxToolCalls=99, alcMaxTokens=999999)
    settings = await get_alc_settings()
    assert settings["alcMaxCycles"] == 6
    assert settings["alcMaxToolCalls"] == 20
    assert settings["alcMaxTokens"] == 6000


async def test_junk_settings_fall_back_to_defaults(tmp_path, monkeypatch):
    from app.settings_store import get_alc_settings

    configure_settings(
        tmp_path,
        monkeypatch,
        alcMaxCycles="lots",
        alcMaxToolCalls=None,
        alcMaxTokens=-5,
        alcDocsPaths=["C:/one", "C:/one", 7, "  "],
    )
    settings = await get_alc_settings()
    assert settings["alcMaxCycles"] == 3
    assert settings["alcMaxToolCalls"] == 12
    assert settings["alcMaxTokens"] == 500, "below the floor clamps up, it does not disable the budget"
    assert settings["alcDocsPaths"] == ["C:/one"]


async def test_web_is_enabled_unless_explicitly_switched_off(tmp_path, monkeypatch):
    from app.settings_store import get_alc_settings

    configure_settings(tmp_path, monkeypatch)
    assert (await get_alc_settings())["alcWebEnabled"] is False

    # A settings.json written before ALC existed has no key at all → web is on.
    settings_file = tmp_path / "data" / "settings.json"
    raw = json.loads(settings_file.read_text(encoding="utf-8"))
    raw.pop("alcWebEnabled")
    settings_file.write_text(json.dumps(raw), encoding="utf-8")
    invalidate_settings_cache()
    assert (await get_alc_settings())["alcWebEnabled"] is True
