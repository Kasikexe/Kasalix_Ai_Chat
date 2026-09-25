"""Port of backend/test/edits.test.ts — apply_search_replace + changed_line_count."""

from app.utils import apply_search_replace, changed_line_count


class TestApplySearchReplace:
    def test_replaces_a_unique_snippet(self):
        content = "const a = 1;\nconst b = 2;\n"
        res = apply_search_replace(content, "const b = 2;", "const b = 3;")
        assert res["ok"] is True
        assert res["newContent"] == "const a = 1;\nconst b = 3;\n"

    def test_rejects_ambiguous_matches(self):
        content = "x\ny\nx\n"
        res = apply_search_replace(content, "x", "z")
        assert res["ok"] is False
        assert res["matches"] > 1

    def test_rejects_an_empty_old_string(self):
        res = apply_search_replace("abc", "", "z")
        assert res["ok"] is False

    def test_returns_a_descriptive_error_when_snippet_not_found(self):
        res = apply_search_replace("hello world", "goodbye", "hi")
        assert res["ok"] is False
        assert "Could not find" in res["error"]

    def test_deleting_a_whole_line_removes_it_cleanly(self):
        content = "keep\nremove\nkeep2\n"
        res = apply_search_replace(content, "remove\n", "")
        assert res["ok"] is True
        assert res["newContent"] == "keep\nkeep2\n"


class TestChangedLineCount:
    def test_one_line_edit_reports_two_changed_lines(self):
        res = changed_line_count("line1\nline2\nline3\n", "line1\nCHANGED\nline3\n")
        assert res["count"] == 2

    def test_no_change_reports_zero(self):
        res = changed_line_count("a\nb\n", "a\nb\n")
        assert res["count"] == 0

    def test_full_rewrite_reports_many_changed_lines(self):
        res = changed_line_count("a\nb\nc\n", "x\ny\nz\n")
        assert res["count"] >= 3