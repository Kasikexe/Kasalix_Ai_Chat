"""ALC project knowledge — the notes a cycle leaves for the next one.

These tests pin the two promises the store makes: a fact written once is found
later (with its provenance), and writing the same fact again is a no-op rather
than a duplicate.
"""

from __future__ import annotations

import json

import pytest

from app.alc import knowledge


@pytest.fixture()
def workspace(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    return str(project)


def test_remember_creates_a_readable_note_and_an_index(workspace):
    saved = knowledge.remember(
        workspace,
        "Pygame input",
        "Pygame reads KEYDOWN through pygame.event.get(); event.key carries pygame.K_LEFT.",
        tags=["pygame"],
        source="docs:games.md#Pygame",
    )

    assert saved["ok"] and saved["written"]
    assert saved["topic"] == "pygame-input"
    note = knowledge.knowledge_dir(workspace) / "pygame-input.md"
    body = note.read_text(encoding="utf-8")
    assert body.startswith("# Pygame input")
    assert "pygame.event.get()" in body
    assert "docs:games.md#Pygame" in body, "a note without its source cannot be re-checked"

    index = json.loads((knowledge.knowledge_dir(workspace) / "index.json").read_text(encoding="utf-8"))
    assert index["version"] == 1
    assert len(index["entries"]) == 1
    entry = index["entries"][0]
    assert entry["slug"] == "pygame-input"
    assert entry["tags"] == ["pygame"]
    assert entry["source"] == "docs:games.md#Pygame"


def test_remembering_the_same_thing_twice_is_a_no_op(workspace):
    body = "The test command is python -m pytest tests/ -q."
    first = knowledge.remember(workspace, "testing", body)
    second = knowledge.remember(workspace, "testing", body)

    assert first["written"] is True
    assert second["ok"] is True and second["written"] is False
    assert second["reason"] == "already stored"
    assert len(knowledge.read_index(workspace)) == 1


def test_a_rediscovered_fact_is_not_appended_again(workspace):
    """The same fact comes back as a search snippet with headings around it."""
    knowledge.remember(
        workspace,
        "pacing",
        "The blitter pace is set with zorb_set_pace(frames); the default is 12 frames.",
        source="docs:zorbnik.md",
    )
    again = knowledge.remember(
        workspace,
        "Pacing",
        "# Pacing\n\n## 2026-09-27 — docs:zorbnik.md\n\nThe blitter pace is set with "
        "zorb_set_pace(frames); the default is 12 frames. Read the constant for it.",
        source="knowledge:pacing",
    )
    assert again["written"] is False
    assert "already" in again["reason"]
    assert len(knowledge.read_index(workspace)) == 1


def test_a_genuinely_new_fact_under_the_same_topic_is_still_stored(workspace):
    knowledge.remember(workspace, "pacing", "The blitter pace is set with zorb_set_pace(frames).")
    added = knowledge.remember(
        workspace,
        "pacing",
        "Joystick polling needs zorb_poll_joysticks() called once per frame, or input lags.",
    )
    assert added["written"] is True
    assert len(knowledge.read_index(workspace)) == 2


def test_a_second_fact_under_the_same_topic_appends_to_the_same_file(workspace):
    knowledge.remember(workspace, "testing", "The test command is pytest tests/ -q.")
    knowledge.remember(workspace, "testing", "Tests need DATA_DIR set to a temp folder.")

    entries = knowledge.read_index(workspace)
    assert len(entries) == 2
    assert {entry["file"] for entry in entries} == {"testing.md"}
    body = (knowledge.knowledge_dir(workspace) / "testing.md").read_text(encoding="utf-8")
    assert body.count("## ") == 2


def test_topic_slugs_are_safe_and_readable(workspace):
    saved = knowledge.remember(workspace, "  Pygame: event.key / K_LEFT!  ", "note")
    assert saved["topic"] == "pygame-event-key-k-left"
    assert (knowledge.knowledge_dir(workspace) / "pygame-event-key-k-left.md").exists()


def test_search_finds_a_stored_note(workspace):
    knowledge.remember(workspace, "pygame key handling", "KEYDOWN carries event.key such as pygame.K_LEFT.")
    knowledge.remember(workspace, "packaging", "Build the installer with npm run build.")

    hits = knowledge.search(workspace, "pygame key events")
    assert hits, "the stored note must be searchable"
    assert hits[0]["source"] == "knowledge:pygame-key-handling"
    assert "KEYDOWN" in hits[0]["text"]
    assert all("packaging" not in hit["source"] for hit in hits)


def test_search_without_a_store_returns_nothing(workspace):
    assert knowledge.search(workspace, "anything") == []
    assert knowledge.search(None, "anything") == []
    assert knowledge.search(workspace, "") == []


def test_topics_summarize_what_the_project_knows(workspace):
    knowledge.remember(workspace, "pygame input", "a")
    knowledge.remember(workspace, "pygame input", "b")
    knowledge.remember(workspace, "build", "c")

    topics = knowledge.topics(workspace)
    assert topics[0]["topic"] == "pygame-input"
    assert topics[0]["notes"] == 2
    assert {topic["topic"] for topic in topics} == {"pygame-input", "build"}


def test_stats_report_an_empty_store_honestly(workspace):
    assert knowledge.stats(workspace) == {
        "topics": 0,
        "notes": 0,
        "studies": 0,
        "bytes": 0,
        "known": False,
        "updatedAt": 0.0,
    }
    knowledge.remember(workspace, "build", "npm run build")
    stats = knowledge.stats(workspace)
    assert stats["known"] is True
    assert stats["notes"] == 1
    assert stats["bytes"] > 0


def test_a_huge_body_is_clipped(workspace):
    saved = knowledge.remember(workspace, "big", "x" * 20_000)
    assert saved["written"] is True
    entry = knowledge.read_index(workspace)[0]
    assert entry["bytes"] <= knowledge.MAX_BODY_CHARS


def test_an_empty_body_is_refused(workspace):
    assert knowledge.remember(workspace, "topic", "   ")["written"] is False


def test_no_project_directory_means_no_store(tmp_path):
    result = knowledge.remember(None, "topic", "body")
    assert result["ok"] is False
    assert "project directory" in result["reason"]
    assert knowledge.topics(None) == []
    assert knowledge.knowledge_dir(None) is None


def test_the_store_lives_inside_the_workspace(workspace):
    directory = knowledge.knowledge_dir(workspace)
    assert directory is not None
    assert directory.name == "knowledge"
    assert directory.parent.name == "ALC"
    assert str(directory).startswith(workspace)


def test_a_corrupt_index_is_ignored_rather_than_crashing(workspace):
    directory = knowledge.knowledge_dir(workspace)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "index.json").write_text("{ not json", encoding="utf-8")
    assert knowledge.read_index(workspace) == []
    assert knowledge.remember(workspace, "topic", "body")["written"] is True


@pytest.mark.parametrize(
    "source,heading,expected",
    [
        ("docs:games.md#Zorbnik engine > Pacing", "Zorbnik engine > Pacing", "Pacing"),
        ("docs:games.md", "", "games"),
        ("web:https://docs.python.org/3/library/json.html", "", "docs.python.org"),
        ("knowledge:testing", "", "testing"),
    ],
)
def test_finding_topics_are_named_after_what_the_fact_is_about(source, heading, expected):
    assert knowledge.for_finding(source, heading) == expected
