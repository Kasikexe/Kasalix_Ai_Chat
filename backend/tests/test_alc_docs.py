"""ALC documentation search — FTS5 index, ranking, chunking and path safety.

The scenario these tests encode is the one ALC exists for: a documentation file
covering many libraries, where only the pygame part is relevant. Searching must
return that passage, not the file.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest

# Point the app at a temp data dir BEFORE importing app modules.
_TMP = tempfile.mkdtemp(prefix="kasalix-alc-docs-test-")
os.environ["DATA_DIR"] = _TMP
os.environ["OLLAMA_URL"] = "http://127.0.0.1:9"  # unreachable — no accidental Ollama use

from app.alc import docs  # noqa: E402

FILLER = "Pygame draws surfaces and blits them onto the screen every frame. " * 40


def big_doc() -> str:
    return "\n".join(
        [
            "# Python libraries",
            "",
            "A short overview of the libraries covered in this file.",
            "",
            "## Requests",
            "",
            "Use requests.get(url) to fetch a page. Install it with pip install requests.",
            "",
            "## Pygame",
            "",
            "The event loop reads pygame.event.get(), and keyboard input arrives as KEYDOWN "
            "events with event.key values such as pygame.K_LEFT. Use pygame.key.get_pressed() "
            "for keys that are held down.",
            "",
            FILLER,
            "",
            "## Other libraries",
            "",
            "Nothing important here.",
            "",
        ]
    )


@pytest.fixture()
def docs_root(tmp_path, monkeypatch):
    """An isolated DATA_DIR plus a documentation folder with a big markdown file."""
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    root = tmp_path / "documentation"
    root.mkdir()
    (root / "libraries.md").write_text(big_doc(), encoding="utf-8")
    (root / "shopping.txt").write_text("milk, eggs, bread\n", encoding="utf-8")
    return str(root)


# ─── Chunking ───────────────────────────────────────────────────────────
def test_chunk_text_is_heading_aware():
    chunks = docs.chunk_text(big_doc())
    headings = {heading for heading, _ in chunks}
    assert "Python libraries > Pygame" in headings
    assert headings == {heading for heading, _ in chunks if heading}


def test_chunk_text_windows_a_long_section():
    chunks = docs.chunk_text(big_doc())
    pygame_chunks = [text for heading, text in chunks if heading.endswith("Pygame")]
    assert len(pygame_chunks) > 1, "the Pygame section should be split into windows"
    assert max(len(text) for text in pygame_chunks) <= docs.CHUNK_CHARS + 1


def test_chunk_text_never_loops_on_tiny_overlap():
    long_text = "x" * 5000
    chunks = docs.chunk_text(long_text)
    assert chunks and sum(len(text) for _, text in chunks) >= 5000


# ─── Indexing ───────────────────────────────────────────────────────────
def test_build_index_reports_what_it_indexed(docs_root):
    stats = docs.build_index([docs_root])
    assert stats["files"] == 2
    assert stats["chunks"] > 0
    assert stats["errors"] == 0
    status = docs.index_status()
    assert status["built"] is True
    assert status["files"] == 2


def test_incremental_rebuild_skips_unchanged_files(docs_root):
    docs.build_index([docs_root])
    again = docs.build_index([docs_root])
    assert again["updated"] == 0
    assert again["skipped"] == 2
    assert again["files"] == 2


def test_changed_file_is_reindexed(docs_root):
    docs.build_index([docs_root])
    target = Path(docs_root) / "libraries.md"
    target.write_text(big_doc() + "\n## Godot\n\nGDScript is used here.\n", encoding="utf-8")
    stats = docs.build_index([docs_root])
    assert stats["updated"] == 1
    assert docs.search("gdscript", roots=[docs_root]), "the new content must be searchable"


def test_deleted_file_disappears_from_the_index(docs_root):
    docs.build_index([docs_root])
    (Path(docs_root) / "shopping.txt").unlink()
    docs.build_index([docs_root])
    assert docs.index_status()["files"] == 1
    assert docs.search("milk eggs bread", roots=[docs_root]) == []


# ─── Search ─────────────────────────────────────────────────────────────
def test_search_finds_the_relevant_section_of_a_big_file(docs_root):
    docs.build_index([docs_root])
    results = docs.search("pygame key events", roots=[docs_root])
    assert results, "the pygame passage must be found"
    top = results[0]
    assert top["path"].endswith("libraries.md")
    assert "Pygame" in top["heading"]
    joined = " ".join(result["text"] for result in results).lower()
    assert "keydown" in joined
    assert all(not result["path"].endswith("shopping.txt") for result in results)


def test_search_does_not_return_unrelated_files(docs_root):
    docs.build_index([docs_root])
    for result in docs.search("pygame event loop", roots=[docs_root]):
        assert result["path"].endswith("libraries.md")


def test_search_reports_the_source_label_and_score(docs_root):
    docs.build_index([docs_root])
    top = docs.search("pygame key events", roots=[docs_root])[0]
    assert top["source"].startswith("docs:libraries.md")
    assert top["heading"] in top["source"]
    assert top["score"] > 0


def test_query_punctuation_cannot_break_the_fts_expression(docs_root):
    docs.build_index([docs_root])
    for query in ["C++ (it's) a *test*", "AND OR NOT", '"quoted" NEAR', "   ", "!!!" ]:
        results = docs.search(query, roots=[docs_root])
        assert isinstance(results, list)


def test_empty_query_returns_nothing(docs_root):
    docs.build_index([docs_root])
    assert docs.search("", roots=[docs_root]) == []


def test_a_deleted_document_stops_answering_from_the_index(docs_root):
    """The index is refreshed on a TTL — a deleted file must not keep answering."""
    docs.build_index([docs_root])
    assert docs.search("pygame key events", roots=[docs_root])

    (Path(docs_root) / "libraries.md").unlink()

    # the index still holds the chunks (no rebuild happened yet) …
    assert docs.search("pygame key events", roots=[docs_root]) == [], "missing files are dropped"
    # … and search_docs heals the index rather than serving dead rows.
    assert docs.search_docs("pygame key events", roots=[docs_root]) == []
    assert docs.index_status()["files"] == 1


def test_search_docs_still_answers_when_a_sibling_file_was_deleted(docs_root):
    other = Path(docs_root) / "events.md"
    other.write_text("# Events\n\npygame event queues and key events are polled each frame.\n", encoding="utf-8")
    docs.build_index([docs_root])
    other.unlink()

    results = docs.search_docs("pygame key events", roots=[docs_root])
    assert results, "a live file must still answer"
    assert all(result["path"].endswith("libraries.md") for result in results)


def test_scan_fallback_works_without_an_index(docs_root):
    # No build_index call: the FTS table is empty, so the scan must answer.
    results = docs.search_docs("pygame key events", roots=[docs_root], k=3)
    assert results, "the scan fallback must still find the passage"
    assert "keydown" in results[0]["text"].lower()


def test_limit_is_respected(docs_root):
    docs.build_index([docs_root])
    assert len(docs.search("python pygame requests install", roots=[docs_root], k=1)) <= 1


# ─── Path safety and reading ────────────────────────────────────────────
def test_resolve_roots_keeps_only_existing_directories(docs_root, tmp_path):
    roots = docs.resolve_roots([docs_root, str(tmp_path / "missing"), "", docs_root])
    assert roots == [os.path.realpath(docs_root)]


def test_open_doc_returns_a_window(docs_root):
    path = str(Path(docs_root) / "libraries.md")
    opened = docs.open_doc(path, line=1, max_chars=200, roots=[docs_root])
    assert opened["ok"] is True
    assert opened["text"].startswith("# Python libraries")
    assert opened["truncated"] is True


def test_open_doc_refuses_files_outside_the_configured_roots(docs_root, tmp_path):
    outside = tmp_path / "secrets.md"
    outside.write_text("not documentation\n", encoding="utf-8")
    refused = docs.open_doc(str(outside), roots=[docs_root])
    assert refused["ok"] is False
    assert "outside" in refused["error"]


def test_open_doc_accepts_a_file_inside_the_roots(docs_root):
    inside = str(Path(docs_root) / "shopping.txt")
    assert docs.open_doc(inside, roots=[docs_root])["ok"] is True


def test_open_doc_reports_a_missing_file(docs_root):
    missing = str(Path(docs_root) / "nope.md")
    result = docs.open_doc(missing, roots=[docs_root])
    assert result["ok"] is False
    assert "could not read" in result["error"]


# ─── Word-shape robustness (D12) ────────────────────────────────────────
SPELLINGS_DOC = "\n".join(
    [
        "# Limiter",
        "",
        "## Cadence limiter",
        "",
        "The cadence limiter throttles the clock. Configuration lives in limiter.conf, "
        "and the configured ceiling is 4000 frames per second.",
        "",
        "## Notes",
        "",
        "Nothing else here.",
        "",
    ]
)


@pytest.fixture()
def spelling_root(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    root = tmp_path / "spellings"
    root.mkdir()
    (root / "limiter.md").write_text(SPELLINGS_DOC, encoding="utf-8")
    docs.build_index([str(root)])
    docs._vocabulary_cache = None  # the index changed; the words changed with it
    return str(root)


def test_a_prefix_of_a_documented_word_still_finds_it(spelling_root):
    # "configure" must reach "configuration"/"configured": a question asked in the
    # model's own words is the normal case, not the exception.
    hits = docs.search("how do I configure the limiter", roots=[spelling_root])
    assert hits
    assert any("cadence limiter" in hit["heading"].lower() or "limiter" in hit["text"].lower() for hit in hits)


def test_expand_terms_maps_an_undocumented_shape_to_a_documented_one():
    # The machinery is lexish on purpose: a word with no counterpart in the index
    # is replaced by a documented word sharing its stem or its prefix.
    words = ["cadence", "limiter", "ceiling", "throttles"]
    assert docs.expand_terms(["limiters"], words) == ["limiter"]
    assert docs.expand_terms(["cadencing"], words) == ["cadence"]
    assert docs.expand_terms(["cadence"], words) == []  # already documented
    assert docs.expand_terms(["zzz"], words) == []


def test_a_thin_result_set_is_asked_again_with_the_documented_words(spelling_root, monkeypatch):
    """The widening pass itself: the first attempt as written, then a second one.

    This pins the PLUMBING, not any claim that lexical search can bridge a
    synonym: the Porter tokenizer already covers inflections and the prefix query
    covers truncations, so what matters is that a thin result really does trigger
    a second attempt and that its hits are merged in.
    """
    issued: list[str] = []
    real = docs._search_rows

    def spy(query, *, k=docs.DEFAULT_RESULTS, roots=None):
        issued.append(query)
        return real(query, k=k, roots=roots)

    monkeypatch.setattr(docs, "_search_rows", spy)
    monkeypatch.setattr(docs, "vocabulary", lambda **_: ["cadence"])

    hits = docs.search_docs("cade", roots=[spelling_root], k=3)

    assert len(issued) == 2, f"expected a second attempt, saw {issued}"
    assert issued[0] == "cade"
    assert "cadence" in issued[1]
    assert hits and any("cadence" in (hit.get("text") or "").lower() for hit in hits)


def test_a_query_that_already_matched_is_never_widened(spelling_root, monkeypatch):
    monkeypatch.setattr(docs, "vocabulary", lambda **_: ["something_else"])
    hits = docs.search_docs("cadence limiter", roots=[spelling_root], k=1)
    assert hits
    assert all("something_else" not in (hit.get("text") or "") for hit in hits)


def test_the_heading_counts_for_more_than_the_body(spelling_root):
    # The words appear in one chunk's heading; ranking must prefer that chunk.
    hits = docs.search("cadence limiter", roots=[spelling_root], k=4)
    assert hits
    assert "cadence limiter" in (hits[0]["heading"] or "").lower()


def test_neighbours_are_the_other_chunks_of_the_same_file(spelling_root):
    hits = docs.search("cadence limiter", roots=[spelling_root], k=1)
    target = hits[0]
    around = docs.neighbours(target["path"], int(target["chunk"]), span=1)
    assert all(item["path"] == target["path"] for item in around)
    assert all(int(item["chunk"]) != int(target["chunk"]) for item in around)
    assert docs.neighbours(str(Path(spelling_root) / "absent.md"), 0) == []


def test_merge_keeps_the_better_copy_of_a_chunk():
    merged = docs._merge(
        [{"path": "a.md", "chunk": 0, "score": 1.0, "text": "first"}],
        [
            {"path": "a.md", "chunk": 0, "score": 9.0, "text": "better"},
            {"path": "b.md", "chunk": 1, "score": 2.0, "text": "other"},
        ],
    )
    assert [item["text"] for item in merged] == ["better", "other"]
