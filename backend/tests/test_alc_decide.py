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


# ─── Judging: quotes that software can verify ───────────────────────────
CANDIDATE = {
    "source": "docs:pace.md",
    "text": "VINTRA_PACE is the pace limiter. It defaults to 16 in the reference config.",
}


def test_quote_supported_requires_the_words_to_be_in_the_candidate():
    assert decide.quote_supported("defaults to 16", CANDIDATE["text"])
    assert decide.quote_supported("It   defaults\nto 16", CANDIDATE["text"])  # whitespace-insensitive
    assert not decide.quote_supported("defaults to 99", CANDIDATE["text"])
    # Too short to be evidence of anything.
    assert not decide.quote_supported("16", CANDIDATE["text"])
    assert not decide.quote_supported("", CANDIDATE["text"])


async def test_a_verified_quote_is_kept_and_recorded(monkeypatch):
    scripted(
        monkeypatch,
        '{"keep": [{"i": 1, "quote": "It defaults to 16", "why": "states the default"}], "drop": []}',
    )
    decisions, used_fallback = await decide.judge_results("what is the default pace", [CANDIDATE], CONN)
    assert used_fallback is False
    assert decisions[0]["keep"] is True
    assert decisions[0]["quoteVerified"] is True


async def test_an_invented_citation_is_dropped(monkeypatch):
    """A quote that is not in the passage it cites is worse than no quote at all."""
    scripted(
        monkeypatch,
        '{"keep": [{"i": 1, "quote": "it defaults to 99", "why": "states the default"}], "drop": []}',
    )
    decisions, _used = await decide.judge_results("what is the default pace", [CANDIDATE], CONN)
    assert decisions[0]["keep"] is False
    assert "not in that candidate" in decisions[0]["reason"]
    assert decisions[0]["quoteVerified"] is False


async def test_a_keep_without_a_quote_is_still_kept(monkeypatch):
    """Small models often omit the quote; that must not throw away a good hit."""
    scripted(monkeypatch, '{"keep": [{"i": 1, "why": "answers it"}], "drop": []}')
    decisions, _used = await decide.judge_results("q", [CANDIDATE], CONN)
    assert decisions[0]["keep"] is True
    assert decisions[0]["quoteVerified"] is False


# ─── Judging: a passage about another named thing is not evidence ──────
def test_named_subjects_ignores_the_word_that_starts_the_sentence():
    # The capital is grammar here, not a name.
    assert decide.named_subjects("Halyard does things") == []
    assert decide.named_subjects("Which ceiling value does Brimwall use by default?") == [
        "Brimwall"
    ]
    assert decide.named_subjects("In Halvard vs Brimwall, and Halyard too") == [
        "Halvard",
        "Brimwall",
        "Halyard",
    ]
    assert decide.named_subjects("") == []


def test_off_subject_names_the_other_thing_a_passage_is_about():
    halyard = {
        "source": "docs:halyard-config.md",
        "heading": "Halyard config > Limits",
        "text": "HALYARD_MAX_FRAMES is 240; above it the Halyard clock clamps.",
    }
    brimwall = {
        "source": "docs:brimwall-limits.md",
        "heading": "Brimwall limits",
        "text": "Brimwall ceilings are set in brimwall.toml.",
    }
    assert decide.off_subject("Which ceiling value does Brimwall use by default?", halyard) == (
        "Halyard"
    )
    # The reason names the thing, not a symbol out of it.
    symbolic = {
        "source": "docs:x.md",
        "heading": "Halyard configuration > Limits",
        "text": "HALYARD_MAX_FRAMES is 240.",
    }
    assert decide.off_subject("Which ceiling does Brimwall use?", symbolic) == "Halyard"
    assert decide.off_subject("Which ceiling value does Brimwall use by default?", brimwall) == ""


def test_off_subject_keeps_what_it_cannot_judge():
    """No named subject in the question, or none in the passage: leave it alone."""
    note = {"source": "ALC/knowledge/pace.md", "text": "the pace default is 16 in this project"}
    halyard = {"source": "docs:halyard-config.md", "text": "HALYARD_MAX_FRAMES is 240."}
    assert decide.off_subject("what is the default pace?", halyard) == ""
    assert decide.off_subject("Which ceiling does Brimwall use?", note) == ""


# ─── Judging: an identifier the question names is not a judgement call ───
VINTRA_NEW = {
    "source": "docs:vintra-pacing.md",
    "text": "vintra_pace_default returns 16 in the reference configuration.",
}


def test_question_anchors_reads_identifiers_and_nothing_else():
    assert decide.question_anchors("What does vintra_pace_default() return?") == [
        "vintra_pace_default"
    ]
    assert decide.question_anchors("What does the Quorvex error code QUORVEX-4513 mean?") == [
        "QUORVEX-4513"
    ]
    # Question words and bare numbers must not become anchors, or almost any
    # passage would count as "relevant" and the judge would be pointless.
    assert decide.question_anchors("What is the default frame count?") == []
    assert decide.question_anchors("What is 12 in the config?") == []
    assert decide.question_anchors("") == []


def test_anchor_in_names_what_it_matched():
    assert decide.anchor_in("vintra_pace_default default?", VINTRA_NEW["text"]) == (
        "vintra_pace_default"
    )
    assert decide.anchor_in("halyard_set_pace default?", VINTRA_NEW["text"]) == ""


async def test_the_judge_cannot_discard_the_passage_naming_the_question_identifier(monkeypatch):
    """Measured live: the judge called this passage "off-topic" and kept an older file."""
    scripted(monkeypatch, '{"keep": [], "drop": [{"i": 1, "why": "off-topic"}]}')
    decisions, used_fallback = await decide.judge_results(
        "What is the purpose of vintra_pace_default()?",
        [VINTRA_NEW],
        CONN,
        goal="What does vintra_pace_default() return?",
    )
    assert used_fallback is False
    assert decisions[0]["keep"] is True
    assert "vintra_pace_default" in decisions[0]["reason"]
    assert decisions[0]["quoteVerified"] is False


async def test_an_unverifiable_quote_loses_the_citation_not_the_evidence(monkeypatch):
    """The quote was invented; the passage is the one the question names."""
    scripted(
        monkeypatch,
        '{"keep": [{"i": 1, "quote": "returns 99 by default", "why": "answers it"}], "drop": []}',
    )
    decisions, _ = await decide.judge_results("vintra_pace_default", [VINTRA_NEW], CONN)
    assert decisions[0]["keep"] is True
    assert decisions[0]["quote"] == ""
    assert decisions[0]["quoteVerified"] is False
    assert "could not be verified" in decisions[0]["reason"]


async def test_the_judge_is_told_the_goal_as_well_as_the_lookup(monkeypatch):
    seen: list[str] = []

    async def fake_generate(conn, system, user, *, max_tokens=256):
        seen.append(user)
        return '{"keep": [], "drop": []}'

    monkeypatch.setattr(decide, "generate", fake_generate)
    await decide.judge_results(
        "What is the purpose of vintra_pace_default()?",
        [VINTRA_NEW],
        CONN,
        goal="What does vintra_pace_default() return?",
    )
    assert "USER'S QUESTION: What does vintra_pace_default() return?" in seen[0]
    assert "THE LOOKUP THIS TEXT CAME FROM: What is the purpose of" in seen[0]


def test_dedupe_candidates_drops_the_same_wording_twice():
    same = "VINTRA_PACE defaults to 16 in the reference configuration file for the limiter."
    candidates = [
        {"source": "docs:a.md", "text": same},
        {"source": "docs:b.md", "text": same},
        {"source": "docs:c.md", "text": "A different passage about something else entirely."},
    ]
    kept = decide.dedupe_candidates(candidates)
    assert [item["source"] for item in kept] == ["docs:a.md", "docs:c.md"]
    assert decide.dedupe_candidates([]) == []
