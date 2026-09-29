"""ALC scratchpad — the controller's bounded working memory.

These tests pin the context-management promises: findings are clipped, deduped
and evicted under budget; discarded information survives only as metadata (so it
is never fetched and re-judged); and the acting phase gets the findings without
the bookkeeping.
"""

from __future__ import annotations

from app.alc.scratchpad import (
    MAX_FINDING_CHARS,
    Finding,
    Scratchpad,
    estimate_tokens,
    family_of,
    looks_like_greeting,
    normalize_query,
)


def test_estimate_tokens_matches_the_pipeline_heuristic():
    assert estimate_tokens("") == 1
    assert estimate_tokens("abcd") == 1
    assert estimate_tokens("a" * 400) == 100


def test_normalize_query_ignores_case_spacing_and_punctuation():
    assert normalize_query("  Pygame Key Events? ") == normalize_query("pygame  key events")


def test_has_query_detects_a_repeat_against_the_same_source():
    pad = Scratchpad(goal="handle key events")
    pad.note_query("pygame key events", "docs_search")
    assert pad.has_query("Pygame Key Events!", "docs_search")
    assert not pad.has_query("pygame mouse events", "docs_search")


def test_the_same_question_may_be_asked_of_a_different_source():
    pad = Scratchpad(goal="handle key events")
    pad.note_query("pygame key events", "docs_search")
    assert not pad.has_query("pygame key events", "knowledge_search")


def test_findings_are_clipped_and_deduped():
    pad = Scratchpad(goal="g")
    first = pad.add_finding(source="docs:a.md", text="x " * 900)
    assert first is not None
    assert len(first.text) <= MAX_FINDING_CHARS
    assert pad.add_finding(source="docs:a.md", text="x " * 900) is None, "duplicate text must be dropped"
    assert len(pad.findings) == 1


def test_empty_findings_are_not_stored():
    pad = Scratchpad(goal="g")
    assert pad.add_finding(source="docs:a.md", text="   ") is None
    assert pad.findings == []


def test_findings_are_capped():
    pad = Scratchpad(goal="g")
    for i in range(40):
        pad.add_finding(source=f"docs:{i}.md", text=f"unique text {i}")
    assert len(pad.findings) <= 24
    assert pad.dropped, "overflow must be recorded as dropped, not silently lost"


def test_rejects_and_gaps_do_not_duplicate():
    pad = Scratchpad(goal="g")
    pad.add_reject("docs:a.md", "off-topic")
    pad.add_reject("docs:a.md", "off-topic")
    pad.add_gap("no docs for pygame")
    pad.add_gap("no docs for pygame")
    assert len(pad.rejected) == 1
    assert len(pad.gaps) == 1


def test_prune_drops_the_lowest_ranked_finding_and_explains_why():
    pad = Scratchpad(goal="g")
    pad.add_finding(source="docs:best.md", text="a" * 800, score=9.0)
    pad.add_finding(source="docs:middle.md", text="b" * 800, score=5.0)
    pad.add_finding(source="docs:worst.md", text="c" * 800, score=1.0)

    before = pad.tokens()
    after = pad.prune(max_tokens=200)

    assert after < before
    assert [finding.source for finding in pad.findings] == ["docs:best.md"]
    assert [finding.source for finding in pad.dropped] == ["docs:worst.md", "docs:middle.md"]
    assert any("budget" in entry["reason"] for entry in pad.rejected)


def test_prune_always_keeps_at_least_one_finding():
    pad = Scratchpad(goal="g")
    pad.add_finding(source="docs:a.md", text="a" * 900, score=1.0)
    pad.add_finding(source="docs:b.md", text="b" * 900, score=0.5)
    pad.prune(max_tokens=1)
    assert len(pad.findings) == 1, "an answer with no evidence is worse than an over-budget one"


def test_render_shows_the_goal_questions_findings_and_tried_queries():
    pad = Scratchpad(goal="write a snake game")
    pad.add_question("how do pygame key events work")
    pad.add_finding(source="docs:pygame.md#Pygame", text="KEYDOWN carries event.key", score=2.0)
    pad.add_reject("docs:other.md", "off-topic")
    pad.add_gap("no docs for tkinter")
    pad.note_query("pygame key events")

    rendered = pad.render()
    assert "write a snake game" in rendered
    assert "how do pygame key events work" in rendered
    assert "docs:pygame.md#Pygame" in rendered
    assert "KEYDOWN" in rendered
    assert "docs:other.md" in rendered
    assert "no docs for tkinter" in rendered
    assert "pygame key events" in rendered


def test_failed_sources_are_remembered_and_shown():
    pad = Scratchpad(goal="g")
    pad.mark_failed("docs_search")
    pad.mark_failed("docs_search")
    assert pad.failed_sources == ["docs_search"]
    rendered = pad.render()
    assert "SOURCES THAT CAME UP EMPTY" in rendered
    assert "docs_search" in rendered


def test_render_lists_the_project_knowledge_that_exists():
    pad = Scratchpad(goal="add a jump button")
    pad.set_knowledge_topics([{"topic": "pygame-input", "notes": 3}, {"topic": "build", "notes": 1}])

    rendered = pad.render()
    assert "PROJECT KNOWLEDGE" in rendered
    assert "pygame-input (3 notes)" in rendered
    assert "build (1 note)" in rendered, "singular is not plural"


def test_render_omits_project_knowledge_when_there_is_none():
    rendered = Scratchpad(goal="g").render()
    assert "PROJECT KNOWLEDGE" not in rendered


def test_summary_counts_the_knowledge_topics():
    pad = Scratchpad(goal="g")
    assert pad.summary()["knowledgeTopics"] == 0
    pad.set_knowledge_topics([{"topic": "a", "notes": 1}])
    assert pad.summary()["knowledgeTopics"] == 1


def test_briefing_carries_findings_and_unresolved_gaps_only():
    pad = Scratchpad(goal="g")
    assert pad.to_briefing() == "", "a turn with no findings gets no briefing at all"

    pad.add_finding(source="docs:pygame.md", text="Use pygame.key.get_pressed() for held keys.")
    pad.add_gap("nothing found about joysticks")
    pad.add_reject("docs:other.md", "off-topic")

    briefing = pad.to_briefing()
    assert "pygame.key.get_pressed()" in briefing
    assert "docs:pygame.md" in briefing
    assert "nothing found about joysticks" in briefing
    assert "docs:other.md" not in briefing, "rejections are bookkeeping, not evidence"


def test_summary_reports_the_budget_counters():
    pad = Scratchpad(goal="g")
    pad.cycles, pad.tool_calls = 2, 3
    pad.add_finding(source="docs:a.md", text="hello")
    summary = pad.summary()
    assert summary["cycles"] == 2
    assert summary["toolCalls"] == 3
    assert summary["findings"] == 1
    assert summary["tokens"] > 0


def test_looks_like_greeting_matches_only_small_talk():
    assert looks_like_greeting("hi")
    assert looks_like_greeting("Thanks!")
    assert not looks_like_greeting("hi, how do pygame key events work")
    assert not looks_like_greeting("write me a snake game")


def test_finding_key_is_stable_for_identical_text():
    a = Finding(source="docs:a.md", text="same text")
    b = Finding(source="docs:a.md", text="same  text")
    assert a.key() == b.key()


# ─── Families: what kind of source a finding came from ──────────────────
def test_family_of_reads_the_source_prefix():
    assert family_of("docs:library.md#Pace") == "docs"
    assert family_of("web:https://example.com/x") == "web"
    assert family_of("knowledge:theme") == "note"


def test_the_web_label_says_fetched_and_never_updated():
    # A page fetched now has not CHANGED now. Labelling it "updated today" is what
    # made every web result look newer than every local document.
    pad = Scratchpad()
    pad.add_finding(
        source="web:https://example.com/x",
        text="Vintra pace is 16.",
        data={"date": "", "fetchedOn": "2026-09-29"},
    )
    briefing = pad.to_briefing()
    assert "fetched 2026-09-29" in briefing
    assert "updated 2026-09-29" not in briefing


def test_a_dated_document_still_says_updated():
    pad = Scratchpad()
    pad.add_finding(source="docs:a.md", text="Vintra pace is 16.", data={"date": "2026-01-02"})
    assert "updated 2026-01-02" in pad.to_briefing()


# ─── Contradictions inside one turn ─────────────────────────────────────
def _conflicting_pad() -> Scratchpad:
    pad = Scratchpad(goal="what is the Vintra pace?")
    pad.add_finding(
        source="docs:changelog.md",
        text="VINTRA_PACE defaults to 12 in the older changelog.",
        data={"date": "2025-01-01"},
    )
    pad.add_finding(
        source="docs:pace.md",
        text="VINTRA_PACE defaults to 16 in the current configuration file.",
        data={"date": "2026-01-01"},
    )
    return pad


def test_the_briefing_tells_the_model_which_value_is_current():
    pad = _conflicting_pad()
    briefing = pad.to_briefing()
    assert "SOURCES DISAGREE" in briefing
    assert "VINTRA_PACE" in briefing
    assert "12" in briefing and "16" in briefing  # both reported, none hidden
    assert "Use the current value" in briefing
    assert pad.conflicts() and pad.conflicts()[0]["current"]["value"] == "16"


def test_conflicts_can_be_switched_off_for_measurement():
    pad = _conflicting_pad()  # the eval harness ablation: alcConflict=False
    pad.conflict_guard = False
    assert "SOURCES DISAGREE" not in pad.to_briefing()
    assert pad.conflicts()  # still detectable, just not injected


def test_no_conflict_block_when_sources_agree():
    pad = Scratchpad(goal="pace")
    pad.add_finding(source="docs:a.md", text="VINTRA_PACE defaults to 16.", data={"date": "2026-01-01"})
    pad.add_finding(source="docs:b.md", text="VINTRA_PACE defaults to 16.", data={"date": "2026-02-01"})
    assert "SOURCES DISAGREE" not in pad.to_briefing()


# ─── Coverage: when may the cycle stop early? ───────────────────────────
def test_coverage_needs_a_value_when_the_question_asks_for_one():
    pad = Scratchpad(goal="What is the default pace for Vintra?")
    pad.add_question("What is the default pace for Vintra?")
    pad.add_finding(
        source="docs:intro.md",
        text="Vintra has a configurable default pace, described in the next section.",
    )
    # Names the subject, states no value: one more lookup is required.
    assert not pad.covered()


def test_coverage_is_reached_once_the_value_is_in_hand():
    pad = Scratchpad(goal="What is the default pace for Vintra?")
    pad.add_question("What is the default pace for Vintra?")
    pad.add_finding(source="docs:pace.md", text="The Vintra default pace is 16 frames.")
    assert pad.covered()


def test_a_procedure_question_needs_no_number():
    pad = Scratchpad(goal="How do I handle pygame key events?")
    pad.add_question("How do I handle pygame key events?")
    pad.add_finding(source="docs:games.md", text="Read pygame key events with pygame.event.get().")
    assert pad.covered()


def test_an_unresolved_gap_blocks_coverage():
    pad = Scratchpad(goal="What is the default pace for Vintra?")
    pad.add_question("What is the default pace for Vintra?")
    pad.add_finding(source="docs:pace.md", text="The Vintra default pace is 16 frames.")
    pad.add_gap("no usable information from web_search")
    assert not pad.covered()
    assert not Scratchpad().covered()  # nothing gathered at all


def test_a_question_with_no_distinctive_terms_is_never_covered():
    pad = Scratchpad(goal="what is it")
    pad.add_question("what is it")
    pad.add_finding(source="docs:a.md", text="It is 12.")
    assert not pad.covered()


# ─── Widened findings ───────────────────────────────────────────────────
def test_a_widened_finding_may_exceed_the_default_clip():
    pad = Scratchpad()
    long_text = "x" * 1500
    kept = pad.add_finding(source="docs:a.md", text=long_text, limit=1400)
    assert kept is not None and len(kept.text) == 1400
    clipped = pad.add_finding(source="docs:b.md", text=long_text)
    assert clipped is not None and len(clipped.text) == MAX_FINDING_CHARS
