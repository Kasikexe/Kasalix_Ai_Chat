"""ALC decisions — JSON parsing and the heuristic fallbacks.

The fallbacks are the load-bearing part: a 1.7B model answers these prompts
imperfectly, and the cycle must degrade to software heuristics rather than stall
or crash (docs/ALC_DESIGN.md D3).
"""

from __future__ import annotations

import pytest

from app.alc import decide
from app.alc import tools as alc_tools
from app.alc.decide import LLMConn
from app.alc.scratchpad import Scratchpad

CONN = LLMConn(model="test-model")

TOOLS = [
    {"name": "docs_search", "description": "search docs", "args": '{"query": "x"}', "kind": "docs"},
    {"name": "web_search", "description": "search the web", "args": '{"query": "x"}', "kind": "web"},
]


def scripted(monkeypatch, replies):
    """Replace the model call with a script that returns replies in order."""
    calls: list[str] = []

    async def fake_generate(conn, system, user, *, max_tokens=256):
        calls.append(system)
        if isinstance(replies, str):
            return replies
        return replies.pop(0) if replies else ""

    monkeypatch.setattr(decide, "generate", fake_generate)
    return calls


# ─── JSON extraction ────────────────────────────────────────────────────
@pytest.mark.parametrize(
    "raw",
    [
        '{"action": "act"}',
        '```json\n{"action": "act"}\n```',
        'Sure, here you go:\n{"action": "act"}\nHope that helps!',
        '{"action": "act",}',
        '{"reason": "braces {inside} a string", "action": "act"}',
        '\n\n  {"nested": {"a": 1}, "action": "act"}  ',
    ],
)
def test_extract_json_object_tolerates_model_chatter(raw):
    assert decide.extract_json_object(raw) is not None


def test_extract_json_object_returns_none_for_prose():
    assert decide.extract_json_object("I think you should search the docs first.") is None
    assert decide.extract_json_object("") is None
    assert decide.extract_json_object("{not json at all}") is None


# ─── Intake ─────────────────────────────────────────────────────────────
def test_heuristic_intake_skips_small_talk():
    assert decide.heuristic_intake("hi")["needs_info"] is False
    assert decide.heuristic_intake("thanks!")["needs_info"] is False
    assert decide.heuristic_intake("")["needs_info"] is False


def test_heuristic_intake_asks_for_information_when_the_task_looks_lookupable():
    result = decide.heuristic_intake("How do I handle pygame key events?")
    assert result["needs_info"] is True
    assert result["questions"] == ["How do I handle pygame key events?"]
    assert result["fallback"] is True


async def test_analyze_task_uses_the_model_answer(monkeypatch):
    scripted(
        monkeypatch,
        '{"goal": "Handle pygame keyboard input", "needs_info": true, '
        '"questions": ["pygame key events", "pygame K_LEFT"]}',
    )
    result = await decide.analyze_task("how do I move the player?", CONN)
    assert result == {
        "goal": "Handle pygame keyboard input",
        "needs_info": True,
        "questions": ["pygame key events", "pygame K_LEFT"],
        "fallback": False,
    }


async def test_analyze_task_needs_info_without_questions_still_searches(monkeypatch):
    scripted(monkeypatch, '{"goal": "g", "needs_info": true, "questions": []}')
    result = await decide.analyze_task("what changed in pygame 2.6?", CONN)
    assert result["needs_info"] is True
    assert result["questions"], "a search needs a query — the task itself is the fallback"


async def test_analyze_task_falls_back_to_the_heuristic(monkeypatch):
    scripted(monkeypatch, "I would search the documentation for that.")
    result = await decide.analyze_task("How do I handle pygame key events?", CONN)
    assert result["fallback"] is True
    assert result["needs_info"] is True


async def test_analyze_task_caps_questions_at_three(monkeypatch):
    scripted(
        monkeypatch,
        '{"goal": "g", "needs_info": true, "questions": ["a", "b", "c", "d", "e"]}',
    )
    result = await decide.analyze_task("task", CONN)
    assert len(result["questions"]) == 3


async def test_analyze_task_reports_no_info_needed(monkeypatch):
    scripted(monkeypatch, '{"goal": "Say hello", "needs_info": false, "questions": []}')
    result = await decide.analyze_task("hi there", CONN)
    assert result["needs_info"] is False


# ─── Gather or act ──────────────────────────────────────────────────────
async def test_choose_action_returns_a_tool_call(monkeypatch):
    scripted(
        monkeypatch,
        '{"action": "tool", "tool": "docs_search", "args": {"query": "pygame key events"}, '
        '"reason": "the docs cover pygame"}',
    )
    pad = Scratchpad(goal="handle key events")
    decision = await decide.choose_action(pad, TOOLS, CONN, "spec")
    assert decision["action"] == "tool"
    assert decision["tool"] == "docs_search"
    assert decision["args"] == {"query": "pygame key events"}
    assert decision["fallback"] is False


async def test_choose_action_keeps_the_models_intent_when_it_asks_for_an_unavailable_tool(monkeypatch):
    scripted(monkeypatch, '{"action": "tool", "tool": "web_search", "args": {"query": "x"}}')
    pad = Scratchpad(goal="g")
    pad.add_question("pygame key events")
    decision = await decide.choose_action(pad, [{"name": "docs_search"}], CONN, "spec")
    assert decision["fallback"] is True
    assert decision["tool"] == "docs_search"
    assert decision["requested"]["tool"] == "web_search"


async def test_choose_action_reads_an_act_decision(monkeypatch):
    scripted(monkeypatch, '{"action": "act", "reason": "enough", "gaps": ["joysticks"]}')
    decision = await decide.choose_action(Scratchpad(goal="g"), TOOLS, CONN, "spec")
    assert decision["action"] == "act"
    assert decision["gaps"] == ["joysticks"]


async def test_choose_action_rejects_a_tool_that_does_not_exist(monkeypatch):
    scripted(monkeypatch, '{"action": "tool", "tool": "database_query", "args": {}}')
    pad = Scratchpad(goal="g")
    decision = await decide.choose_action(pad, TOOLS, CONN, "spec")
    assert decision["fallback"] is True
    assert decision["tool"] in {"docs_search", ""}


async def test_choose_action_falls_back_when_the_reply_is_not_json(monkeypatch):
    scripted(monkeypatch, "Let me think about that for a moment.")
    pad = Scratchpad(goal="g")
    pad.add_question("pygame key events")
    decision = await decide.choose_action(pad, TOOLS, CONN, "spec")
    assert decision["action"] == "tool"
    assert decision["args"]["query"] == "pygame key events"


def test_prompts_use_placeholders_instead_of_sample_queries():
    """A small model echoes an example out of its own prompt, so examples must not look real.

    This is a regression guard: with a realistic example query in the action prompt,
    qwen3:1.7b searched that literal text on every task and reported it as a lookup.
    """
    assert "<your search terms>" in decide.ACTION_SYSTEM
    assert "pygame" not in decide.ACTION_SYSTEM.lower()
    assert "<what must be looked up>" in decide.INTAKE_SYSTEM
    for tool in alc_tools.ALC_TOOLS:
        assert "<" in tool["args"], f"{tool['name']} needs a placeholder example"
        assert "<" in str((tool.get("example") or {}).get(alc_tools.primary_arg(tool)))


def test_placeholder_detection_catches_missing_and_echoed_arguments():
    assert alc_tools.is_placeholder("")
    assert alc_tools.is_placeholder(None)
    assert alc_tools.is_placeholder("<search terms>")
    assert alc_tools.is_placeholder("<search terms>", alc_tools.DOCS_SEARCH)
    assert not alc_tools.is_placeholder("pygame key events", alc_tools.DOCS_SEARCH)


def test_heuristic_action_acts_when_there_is_nothing_to_fetch():
    assert decide.heuristic_action(Scratchpad(goal="g"), TOOLS)["action"] == "act"


def test_heuristic_action_uses_the_first_question():
    pad = Scratchpad(goal="g")
    pad.add_question("pygame key events")
    decision = decide.heuristic_action(pad, TOOLS)
    assert decision["action"] == "tool"
    assert decision["args"]["query"] == "pygame key events"


def test_heuristic_action_searches_the_goal_when_there_are_no_questions():
    pad = Scratchpad(goal="how to handle pygame key events")
    decision = decide.heuristic_action(pad, TOOLS)
    assert decision["action"] == "tool"
    assert decision["args"]["query"] == "how to handle pygame key events"


def test_heuristic_action_moves_to_another_source_for_the_same_question():
    """The same question may be asked of a different source — only repeats are banned."""
    pad = Scratchpad(goal="g")
    pad.add_question("pygame key events")
    pad.note_query("pygame key events", "docs_search")
    decision = decide.heuristic_action(pad, TOOLS)
    assert decision["action"] == "tool"
    assert decision["tool"] == "web_search"


def test_heuristic_action_acts_when_every_source_has_been_asked():
    pad = Scratchpad(goal="g")
    pad.add_question("pygame key events")
    pad.note_query("pygame key events", "docs_search")
    pad.note_query("pygame key events", "web_search")
    assert decide.heuristic_action(pad, TOOLS)["action"] == "act"


def test_heuristic_action_skips_a_source_that_came_up_empty():
    pad = Scratchpad(goal="g")
    pad.add_question("pygame key events")
    pad.mark_failed("docs_search")
    decision = decide.heuristic_action(pad, TOOLS)
    assert decision["tool"] == "web_search"


def test_heuristic_action_prefers_project_knowledge_over_the_documentation():
    pad = Scratchpad(goal="g")
    pad.add_question("pygame key events")
    knowledge_tools = [{"name": "knowledge_search"}, {"name": "docs_search"}, {"name": "web_search"}]
    assert decide.heuristic_action(pad, knowledge_tools)["tool"] == "knowledge_search"


def test_heuristic_action_acts_without_any_search_tool():
    pad = Scratchpad(goal="g")
    pad.add_question("pygame key events")
    assert decide.heuristic_action(pad, [{"name": "docs_open"}])["action"] == "act"


def test_heuristic_action_picks_web_when_it_is_the_only_source():
    pad = Scratchpad(goal="g")
    pad.add_question("something specific")
    web_only = [tool for tool in TOOLS if tool["name"] != "docs_search"]
    decision = decide.heuristic_action(pad, web_only)
    assert decision["action"] == "tool" and decision["tool"] == "web_search"


# ─── Relevance judging ──────────────────────────────────────────────────
CANDIDATES = [
    {"source": "docs:pygame.md", "text": "KEYDOWN events carry event.key, e.g. pygame.K_LEFT."},
    {"source": "docs:requests.md", "text": "Install requests with pip install requests."},
]


async def test_judge_results_keeps_what_the_model_keeps(monkeypatch):
    scripted(monkeypatch, '{"keep": [{"i": 1, "why": "answers the question"}], "drop": [{"i": 2, "why": "off-topic"}]}')
    decisions, used_fallback = await decide.judge_results("how do key events work", CANDIDATES, CONN)
    assert used_fallback is False
    assert [d["keep"] for d in decisions] == [True, False]
    assert decisions[0]["reason"] == "answers the question"
    assert decisions[1]["reason"] == "off-topic"


async def test_judge_results_ignores_out_of_range_indexes(monkeypatch):
    scripted(monkeypatch, '{"keep": [{"i": 7, "why": "?"}], "drop": []}')
    decisions, _ = await decide.judge_results("q", CANDIDATES, CONN)
    assert [d["keep"] for d in decisions] == [False, False]


async def test_judge_results_respects_the_keep_limit(monkeypatch):
    many = [{"source": f"docs:{i}.md", "text": f"candidate {i}"} for i in range(5)]
    scripted(
        monkeypatch,
        '{"keep": [{"i": 1}, {"i": 2}, {"i": 3}, {"i": 4}, {"i": 5}], "drop": []}',
    )
    decisions, _ = await decide.judge_results("q", many, CONN, max_keep=2)
    assert sum(1 for d in decisions if d["keep"]) == 2
    assert any("keep limit" in d["reason"] for d in decisions if not d["keep"])


async def test_judge_results_falls_back_to_term_overlap(monkeypatch):
    scripted(monkeypatch, "The first one looks relevant to me.")
    decisions, used_fallback = await decide.judge_results("pygame key events", CANDIDATES, CONN)
    assert used_fallback is True
    assert decisions[0]["keep"] is True, "the pygame passage shares terms with the question"
    assert decisions[1]["keep"] is False


def test_heuristic_judge_drops_candidates_with_no_overlap():
    decisions = decide.heuristic_judge("pygame key events", CANDIDATES)
    assert [d["keep"] for d in decisions] == [True, False]


def test_heuristic_judge_prefers_the_documented_match_count():
    candidates = [
        {"source": "docs:a.md", "text": "totally unrelated words", "matched": ["pygame"]},
        {"source": "docs:b.md", "text": "pygame key events are read from the event queue"},
    ]
    decisions = decide.heuristic_judge("pygame key events", candidates)
    assert decisions[0]["keep"] is True
    assert decisions[1]["keep"] is True
    assert decisions[0]["reason"]


async def test_judge_results_with_no_candidates_is_a_no_op(monkeypatch):
    scripted(monkeypatch, '{"keep": []}')
    assert await decide.judge_results("q", [], CONN) == ([], False)


# ─── Retry reformulation ────────────────────────────────────────────────
def test_reformulate_query_drops_question_phrasing():
    reformulated = decide.reformulate_query("How do I handle pygame key events?")
    assert reformulated is not None
    assert reformulated.lower() not in {"how", "do"}
    assert "pygame" in reformulated


def test_reformulate_query_gives_up_on_a_single_term():
    assert decide.reformulate_query("pygame") is None
    assert decide.reformulate_query("!!!") is None
