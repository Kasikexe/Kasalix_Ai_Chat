"""ALC studies — the model writes the note, software refuses what it cannot source.

Two halves:

* the pure checks (:mod:`app.alc.study`) — grounding, conflicts, section
  assembly. These are where a 1.7B model's invented value has to be caught, so
  they are tested directly rather than through a model;
* the wiring — a chat turn with a workspace must leave project knowledge behind,
  an ungrounded generation must fall back to the excerpt note, and the per-turn
  study budget must hold.
"""

from __future__ import annotations

import json
import os
import tempfile

import pytest

_TMP = tempfile.mkdtemp(prefix="kasalix-alc-study-test-")
os.environ["DATA_DIR"] = _TMP
os.environ["OLLAMA_URL"] = "http://127.0.0.1:9"

from app.alc import decide, knowledge, study  # noqa: E402
from app.alc.controller import run_alc_turn  # noqa: E402
from app.alc.study import TopicEvidence, detect_conflicts, finalise, ground_sections  # noqa: E402
from app.settings_store import invalidate_settings_cache  # noqa: E402

# ─── Fixtures ───────────────────────────────────────────────────────────
DOC = (
    "# Game libraries\n"
    "\n"
    "## Pygame\n"
    "\n"
    "The event loop reads pygame.event.get() and KEYDOWN events carry event.key, "
    "for example pygame.K_LEFT. Use pygame.key.get_pressed() for held keys.\n"
    "\n"
    "## Requests\n"
    "\n"
    "Install requests with pip install requests.\n"
)

DOC2 = (
    "# Input handling\n"
    "\n"
    "## Keyboard\n"
    "\n"
    "Keyboard input arrives as pygame key events; handle them with pygame.event.get() "
    "in the frame loop.\n"
)

GROUNDED = """\
## What it is
Pygame delivers keyboard input through its own event queue.

## Key facts
- Read the queue with pygame.event.get().
- KEYDOWN events carry event.key, for example pygame.K_LEFT.
- pygame.key.get_pressed() reports keys that are held down.

## APIs and signatures
pygame.event.get()
pygame.key.get_pressed()

## Pitfalls
None documented.

## Open questions
none
"""

UNGROUNDED = """\
## What it is
The frame clock is configured with pygame_set_pace().

## Key facts
- The default frame count is 12.
- The hard ceiling is pygame_max_frames = 240.

## APIs and signatures
pygame_set_pace(frames=12)

## Open questions
none
"""

PYGAME_EVIDENCE = TopicEvidence(
    topic="Pygame",
    sources=[{"source": "docs:pacing.md", "date": "2026-08-01"}],
    passages=[
        {
            "source": "docs:pacing.md",
            "date": "2026-08-01",
            "text": (
                "## Pygame\n\nThe event loop reads pygame.event.get() and KEYDOWN events "
                "carry event.key, for example pygame.K_LEFT. Use pygame.key.get_pressed() "
                "for held keys."
            ),
        }
    ],
)


# ─── Grounding ──────────────────────────────────────────────────────────
def test_specificity_tokens_finds_every_shape_of_claim():
    tokens = study.specificity_tokens(
        "Halyard uses halyard_set_pace and HALYARD_MAX=240 in pkg/halyard/tide.py (QUORVEX-4513)."
    )
    assert "halyard_set_pace" in tokens
    assert "HALYARD_MAX" in tokens
    assert "240" in tokens
    assert "pkg/halyard/tide.py" in tokens
    assert "QUORVEX-4513" in tokens


def test_list_markers_and_years_are_not_claims():
    assert study.specificity_tokens("1. Read the docs in 2026.") == []


def test_grounded_study_keeps_its_facts():
    markdown, kept, dropped = ground_sections(GROUNDED, PYGAME_EVIDENCE.evidence_text())
    assert "pygame.event.get()" in markdown
    assert "event.key" in markdown
    assert kept >= 4
    assert dropped == []


def test_an_invented_value_is_dropped_from_a_study():
    markdown, kept, dropped = ground_sections(UNGROUNDED, PYGAME_EVIDENCE.evidence_text())
    assert "12" not in markdown, "an unsourced value must not survive"
    assert "pygame_set_pace" not in markdown
    # "none" under Open questions is the only line left: it claims nothing.
    assert kept <= 1, markdown
    assert len(dropped) >= 3
    assert any("pygame_set_pace" in str(entry["tokens"]) for entry in dropped)


def test_a_heading_that_invents_a_number_drops_its_whole_section():
    raw = "## Frame count 240\n\n- Something that is documented.\n"
    markdown, kept, dropped = ground_sections(raw, PYGAME_EVIDENCE.evidence_text())
    assert markdown.strip() == ""
    assert kept == 0
    assert any(entry["why"] == "unsourced detail in a heading" for entry in dropped)


def test_a_reformatted_signature_is_dropped_from_the_apis_section():
    """Found in a live snapshot: sourced tokens, invented FORM.

    The source says `peltarn_write_quota()` returns a number. A model that turns
    that sentence into a `def ... -> int:` block has invented API surface that
    every token check passes. A signature must be copied, not composed.
    """
    evidence = (
        "## Quota\n\n`peltarn_write_quota()` returns the number of concurrent writes a key "
        "may make. The documented value is 7."
    )
    raw = (
        "## What it is\n"
        "A function that returns the number of concurrent writes a key may make.\n\n"
        "## APIs and signatures\n"
        "```python\n"
        "def peltarn_write_quota() -> int:\n"
        '    """Returns the number of concurrent writes a key may make."""\n'
        "```\n\n"
        "## Open questions\nnone\n"
    )
    markdown, _kept, dropped = ground_sections(raw, evidence)
    assert "def peltarn_write_quota" not in markdown
    assert "-> int" not in markdown
    assert any("verbatim" in str(entry["why"]) for entry in dropped)


def test_a_code_fence_is_never_stored_on_its_own():
    """A bare ``` normalises to "" and would pass any substring check."""
    evidence = "Use pygame.key.get_pressed() for held keys."
    raw = "## APIs and signatures\n```python\ndef invented() -> int:\n```\n"
    markdown, kept, dropped = ground_sections(raw, evidence)
    assert "```" not in markdown
    assert kept == 0
    assert len(dropped) == 3


def test_a_copied_signature_survives_the_apis_section():
    evidence = "Use pygame.key.get_pressed() for held keys."
    raw = "## APIs and signatures\npygame.key.get_pressed()\n"
    markdown, _kept, dropped = ground_sections(raw, evidence)
    assert "pygame.key.get_pressed()" in markdown
    assert dropped == []


def test_a_fenced_reply_is_unwrapped():
    markdown, kept, _dropped = ground_sections(f"```markdown\n{GROUNDED}\n```", PYGAME_EVIDENCE.evidence_text())
    assert "```" not in markdown
    assert "pygame.event.get()" in markdown


def test_finalise_refuses_a_study_with_nothing_grounded():
    result = finalise(PYGAME_EVIDENCE, UNGROUNDED, updated="2026-09-29")
    assert not result.ok
    assert "support" in result.reason or "grounded" in result.reason
    assert result.dropped_count >= 3


def test_finalise_assembles_the_canonical_sections():
    result = finalise(PYGAME_EVIDENCE, GROUNDED, updated="2026-09-29")
    assert result.ok
    assert "## Key facts" in result.body
    assert "## Open questions" in result.body
    assert "_Updated 2026-09-29" in result.body
    assert "docs:pacing.md" in result.body, "the study must say where it came from"
    assert result.bullets >= 3


# ─── Conflicts ──────────────────────────────────────────────────────────
def test_conflicting_values_are_resolved_by_source_date():
    passages = [
        {"source": "docs:changelog.md", "date": "2026-01-01", "text": "vintra_pace_default() returns 12."},
        {"source": "docs:pacing.md", "date": "2026-08-01", "text": "vintra_pace_default() returns 16 since 1.7.0."},
    ]
    conflicts = detect_conflicts(passages)
    assert len(conflicts) == 1
    conflict = conflicts[0]
    assert conflict["current"]["value"] == "16"
    assert conflict["current"]["source"] == "docs:pacing.md"
    assert conflict["staleValues"] == ["12"]


def test_the_same_value_from_two_sources_is_not_a_conflict():
    passages = [
        {"source": "a.md", "date": "2026-01-01", "text": "quorvex_lease_floor() returns 9."},
        {"source": "b.md", "date": "2026-08-01", "text": "quorvex_lease_floor() returns 9."},
    ]
    assert detect_conflicts(passages) == []


def test_a_superseded_value_stated_as_current_is_removed():
    markdown = (
        "## Key facts\n"
        "- vintra_pace_default() returns 12.\n"
        "- vintra_pace_default() returns 16.\n"
    )
    passages = [
        {"source": "docs:changelog.md", "date": "2026-01-01", "text": "vintra_pace_default() returns 12."},
        {"source": "docs:pacing.md", "date": "2026-08-01", "text": "vintra_pace_default() returns 16."},
    ]
    conflicts = detect_conflicts(passages)
    filtered, dropped = study.drop_superseded_lines(markdown, conflicts)
    assert " 12" not in filtered
    assert "16" in filtered
    assert dropped and "superseded" in dropped[0]["why"]


def test_a_stale_mention_alongside_the_current_value_is_kept():
    """Recording that the documentation CHANGED is honest and must survive."""
    markdown = "## Key facts\n- vintra_pace_default() returns 16, superseding 12.\n"
    passages = [
        {"source": "docs:changelog.md", "date": "2026-01-01", "text": "vintra_pace_default() returns 12."},
        {"source": "docs:pacing.md", "date": "2026-08-01", "text": "vintra_pace_default() returns 16."},
    ]
    filtered, dropped = study.drop_superseded_lines(markdown, detect_conflicts(passages))
    assert "16" in filtered and "12" in filtered
    assert dropped == []


def test_finalise_reports_conflicts_in_the_study():
    ev = TopicEvidence(
        topic="Vintra",
        sources=[{"source": "docs:pacing.md", "date": "2026-08-01"}],
        passages=[
            {"source": "docs:changelog.md", "date": "2026-01-01", "text": "vintra_pace_default() returns 12."},
            {"source": "docs:pacing.md", "date": "2026-08-01", "text": "vintra_pace_default() returns 16."},
        ],
    )
    raw = "## Key facts\n- vintra_pace_default() returns 16.\n"
    result = finalise(ev, raw, updated="2026-09-29")
    assert result.ok
    assert "## Conflicting sources" in result.body
    assert "supersedes 12" in result.body


# ─── The store keeps both layers ────────────────────────────────────────
def test_writing_a_study_keeps_the_appended_notes(tmp_path):
    workspace = str(tmp_path / "project")
    knowledge.remember(workspace, "Pygame", "An excerpt that must survive.", source="docs:pacing.md")
    knowledge.write_study(workspace, "Pygame", "## Key facts\n- pygame.event.get()", sources=[{"source": "docs:pacing.md", "date": "2026-08-01"}])

    path = tmp_path / "project" / "ALC" / "knowledge" / "pygame.md"
    text = path.read_text(encoding="utf-8")
    assert knowledge.STUDY_START in text and knowledge.STUDY_END in text
    assert "An excerpt that must survive." in text, "notes are append-only, never rewritten"
    assert text.index(knowledge.STUDY_START) < text.index("An excerpt that must survive.")
    assert knowledge.read_study(workspace, "Pygame").startswith("## Key facts")


def test_rewriting_an_unchanged_study_is_a_no_op(tmp_path):
    workspace = str(tmp_path / "project")
    first = knowledge.write_study(workspace, "Pygame", "## Key facts\n- pygame.event.get()")
    second = knowledge.write_study(workspace, "Pygame", "## Key facts\n- pygame.event.get()")
    assert first["written"] is True
    assert second["written"] is False
    assert second["reason"] == "the study is unchanged"


def test_a_study_is_searchable_and_counted(tmp_path):
    workspace = str(tmp_path / "project")
    knowledge.write_study(
        workspace,
        "Pygame",
        "## Key facts\n- pygame.key.get_pressed() reports held keys.",
        sources=[{"source": "docs:pacing.md", "date": "2026-08-01"}],
    )
    stats = knowledge.stats(workspace)
    assert stats["studies"] == 1 and stats["known"] is True
    assert knowledge.topics(workspace)[0]["studies"] == 1

    hits = knowledge.search(workspace, "get_pressed held keys")
    assert hits and "get_pressed" in hits[0]["text"]
    assert hits[0]["date"], "a note must carry the date it was written"


def test_a_study_does_not_make_later_excerpts_look_redundant(tmp_path):
    """A study's broad vocabulary must not swallow every new excerpt note."""
    workspace = str(tmp_path / "project")
    knowledge.write_study(
        workspace,
        "Pygame",
        "## Key facts\n" + "\n".join(
            f"- pygame tick {index} detail about the event loop and the frame clock"
            for index in range(12)
        ),
    )
    saved = knowledge.remember(workspace, "Pygame", "The QUORVEX-4513 code means the lease was lost.", source="docs:x.md")
    assert saved["written"] is True, "the study's vocabulary must not mark this as already stored"


def test_a_study_never_leaks_between_projects(tmp_path):
    one = str(tmp_path / "one")
    two = str(tmp_path / "two")
    knowledge.write_study(one, "Pygame", "## Key facts\n- pygame.event.get()")
    assert knowledge.read_study(two, "Pygame") == ""
    assert knowledge.stats(two)["known"] is False


# ─── Wiring: a chat turn must leave knowledge behind ────────────────────
def configure(tmp_path, monkeypatch, **overrides):
    data_dir = tmp_path / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    docs_root = tmp_path / "documentation"
    docs_root.mkdir(exist_ok=True)
    (docs_root / "pacing.md").write_text(DOC, encoding="utf-8")
    (docs_root / "input.md").write_text(DOC2, encoding="utf-8")

    settings = {
        "alcDocsPaths": [str(docs_root)],
        "alcMaxCycles": 3,
        "alcMaxToolCalls": 12,
        "alcMaxTokens": 4000,
        "alcWebEnabled": False,
        "alcWriteKnowledge": True,
        "alcStudyMaxTopics": 2,
    }
    settings.update(overrides)
    (data_dir / "settings.json").write_text(json.dumps(settings), encoding="utf-8")
    monkeypatch.setenv("DATA_DIR", str(data_dir))
    invalidate_settings_cache()

    workspace = tmp_path / "project"
    workspace.mkdir(exist_ok=True)
    return docs_root, workspace


def script_model(monkeypatch, *, synthesis=GROUNDED, judge=None, action=None):
    """Script intake, the gather decision, the judge and the study call."""
    state = {"actions": 0}

    async def fake_generate(conn, system, user, *, max_tokens=256):
        if "planning step of an information-gathering cycle" in system:
            return json.dumps(
                {"goal": "handle pygame key events", "needs_info": True, "questions": ["pygame key events"]}
            )
        if "You control an information-gathering cycle" in system:
            index = state["actions"]
            state["actions"] += 1
            if action is not None:
                return action(index)
            if index == 0:
                return json.dumps(
                    {
                        "action": "tool",
                        "tool": "docs_search",
                        "args": {"query": "pygame key events"},
                        "reason": "the docs cover it",
                    }
                )
            return json.dumps({"action": "act", "reason": "enough"})
        if "judge retrieved text" in system:
            return judge or '{"keep": [{"i": 1, "why": "relevant"}], "drop": []}'
        if "You keep durable notes" in system:
            return synthesis
        return ""

    monkeypatch.setattr(decide, "generate", fake_generate)
    return state


def stub_acting(monkeypatch, answer="ALC ANSWER"):
    import app.pipeline as pipeline

    async def fake_loop(stage, model, messages, think, on_chunk, signal=None, extra_opts=None,
                        on_thinking=None, on_stage=None, tools_override=None, on_metrics=None):
        if on_chunk:
            on_chunk(answer)
        return answer

    monkeypatch.setattr(pipeline, "run_chat_tool_loop", fake_loop)
    return answer


async def chat_turn(events, workspace, **extra):
    return await run_alc_turn(
        {
            "model": "test-model",
            "messages": [{"role": "user", "content": "How do I handle pygame key events?"}],
            "mode": "chat",
            "workspacePath": str(workspace) if workspace else None,
            "onChunk": lambda chunk: None,
            "onAlcEvent": events.append,
            **extra,
        }
    )


async def test_a_chat_turn_with_a_workspace_leaves_a_study_behind(tmp_path, monkeypatch):
    """The Phase 4 fix: chat used to gather, answer, and keep nothing."""
    _docs, workspace = configure(tmp_path, monkeypatch)
    script_model(monkeypatch)
    stub_acting(monkeypatch)
    events: list[dict] = []

    await chat_turn(events, workspace)

    events_of = [event for event in events if event["type"] == "alc:study"]
    assert events_of, [event["type"] for event in events]
    assert events_of[0]["mode"] == "synthesised"
    assert events_of[0]["bullets"] >= 1

    stats = knowledge.stats(str(workspace))
    assert stats["studies"] >= 1, "the turn must leave durable knowledge behind"
    assert knowledge.topics(str(workspace)), "and the next turn must be able to find it"


async def test_a_chat_turn_without_a_workspace_writes_nothing(tmp_path, monkeypatch):
    _docs, _workspace = configure(tmp_path, monkeypatch)
    script_model(monkeypatch)
    stub_acting(monkeypatch)
    events: list[dict] = []

    await chat_turn(events, None)

    assert not [event for event in events if event["type"] in ("alc:study", "alc:knowledge-written")]


async def test_an_ungrounded_study_falls_back_to_the_excerpt_note(tmp_path, monkeypatch):
    """A bad generation must not lose the fact — that was the point of Phase 2."""
    _docs, workspace = configure(tmp_path, monkeypatch)
    script_model(monkeypatch, synthesis=UNGROUNDED)
    stub_acting(monkeypatch)
    events: list[dict] = []

    await chat_turn(events, workspace)

    reported = [event for event in events if event["type"] == "alc:study"]
    assert reported and reported[0]["mode"] == "excerpt"
    assert reported[0]["dropped"] >= 1
    assert "alc:knowledge-written" in [event["type"] for event in events], "the excerpt is the safety net"
    stats = knowledge.stats(str(workspace))
    assert stats["notes"] >= 1 and stats["studies"] == 0


async def test_excerpts_are_kept_when_the_study_step_is_switched_off(tmp_path, monkeypatch):
    """`alcStudy: False` is the alc-raw arm: Phase 2 behaviour, unchanged."""
    _docs, workspace = configure(tmp_path, monkeypatch)
    script_model(monkeypatch)
    stub_acting(monkeypatch)
    events: list[dict] = []

    await chat_turn(events, workspace, alcStudy=False)

    assert not [event for event in events if event["type"] == "alc:study"]
    assert "alc:knowledge-written" in [event["type"] for event in events]
    assert knowledge.stats(str(workspace))["studies"] == 0


async def test_the_study_budget_limits_topics_per_turn(tmp_path, monkeypatch):
    """Each study is a model call, so the per-turn spend is capped."""
    _docs, workspace = configure(tmp_path, monkeypatch, alcStudyMaxTopics=1)
    script_model(monkeypatch, judge='{"keep": [{"i": 1, "why": "a"}, {"i": 2, "why": "b"}], "drop": []}')
    stub_acting(monkeypatch)
    events: list[dict] = []

    await chat_turn(events, workspace)

    synthesised = [
        event for event in events if event["type"] == "alc:study" and event["mode"] == "synthesised"
    ]
    assert len(synthesised) == 1, f"budget is 1 per turn, got {len(synthesised)}"
    assert knowledge.stats(str(workspace))["studies"] == 1


async def test_read_only_sessions_never_learn(tmp_path, monkeypatch):
    _docs, workspace = configure(tmp_path, monkeypatch)
    script_model(monkeypatch)
    stub_acting(monkeypatch)
    events: list[dict] = []

    await chat_turn(events, workspace, toolPermission="read-only")

    assert knowledge.stats(str(workspace))["known"] is False
    assert not [event for event in events if event["type"] in ("alc:study", "alc:knowledge-written")]
    assert any(event["type"] == "alc:notice" and event["kind"] == "read-only" for event in events)


async def test_the_study_step_is_skipped_without_a_model(tmp_path, monkeypatch):
    """The heuristic-only arm has no model call to spend: excerpt notes still land."""
    _docs, workspace = configure(tmp_path, monkeypatch)
    script_model(monkeypatch)
    stub_acting(monkeypatch)
    events: list[dict] = []

    await chat_turn(events, workspace, alcDecideModel="")

    assert not [event for event in events if event["type"] == "alc:study"]
    assert knowledge.stats(str(workspace))["notes"] >= 1


# ─── Which source wins (family → then recency) ──────────────────────────
def test_a_project_note_never_overrules_the_documentation():
    """A note is ALC's own summary; it cannot be "newer news" than its source."""
    conflicts = detect_conflicts(
        [
            {
                "source": "knowledge:vintra",
                "date": "2026-09-29",
                "family": "note",
                "text": "VINTRA_PACE defaults to 99 according to an earlier note.",
            },
            {
                "source": "docs:pace.md",
                "date": "2025-01-01",
                "family": "docs",
                "text": "VINTRA_PACE defaults to 16 in the reference.",
            },
        ]
    )
    assert conflicts
    assert conflicts[0]["current"]["value"] == "16"
    assert conflicts[0]["current"]["family"] == "docs"
    assert conflicts[0]["staleValues"] == ["99"]


def test_within_one_kind_the_newer_date_still_wins():
    conflicts = detect_conflicts(
        [
            {"source": "docs:old.md", "date": "2024-05-05", "family": "docs", "text": "VINTRA_PACE defaults to 12."},
            {"source": "docs:new.md", "date": "2026-05-05", "family": "docs", "text": "VINTRA_PACE defaults to 16."},
        ]
    )
    assert conflicts[0]["current"]["value"] == "16"


def test_an_undated_web_page_does_not_beat_a_dated_document():
    conflicts = detect_conflicts(
        [
            {"source": "web:https://x.example", "date": "", "family": "web", "text": "VINTRA_PACE defaults to 99."},
            {"source": "docs:pace.md", "date": "2025-01-01", "family": "docs", "text": "VINTRA_PACE defaults to 16."},
        ]
    )
    assert conflicts[0]["current"]["value"] == "16"


def test_two_web_sources_are_settled_by_their_dates():
    conflicts = detect_conflicts(
        [
            {"source": "web:a", "date": "2026-01-01", "family": "web", "text": "VINTRA_PACE defaults to 16."},
            {"source": "web:b", "date": "2025-01-01", "family": "web", "text": "VINTRA_PACE defaults to 12."},
        ]
    )
    assert conflicts[0]["current"]["value"] == "16"


def test_sources_without_a_family_still_behave_as_before():
    """Existing callers pass no family; all passages are documentation."""
    conflicts = detect_conflicts(
        [
            {"source": "docs:old.md", "date": "2024-01-01", "text": "VINTRA_PACE defaults to 12."},
            {"source": "docs:new.md", "date": "2026-01-01", "text": "VINTRA_PACE defaults to 16."},
        ]
    )
    assert conflicts[0]["current"]["value"] == "16"


def test_conflict_block_states_the_rule_and_both_values():
    conflicts = detect_conflicts(
        [
            {"source": "docs:old.md", "date": "2024-01-01", "family": "docs", "text": "VINTRA_PACE defaults to 12."},
            {"source": "docs:new.md", "date": "2026-01-01", "family": "docs", "text": "VINTRA_PACE defaults to 16."},
        ]
    )
    block = study.conflict_block(conflicts)
    assert "SOURCES DISAGREE" in block
    assert "supersedes 12" in block
    assert "Never present a superseded value as the answer" in block
    assert study.conflict_block([]) == ""
