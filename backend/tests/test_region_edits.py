"""edit_lines (line-range) and edit_section (anchor-based) editing.

Why these exist: apply_search_replace makes the model reproduce the OLD text
byte-exactly, which is the hard half of editing for a small local model — so it
dodges the wall by rewriting the whole file. These two engines locate the region
by line number or by anchor, so a surgical change costs no more than a rewrite.
"""

import asyncio

from app.agent import AGENT_TOOL_DEFS, MUTATING_TOOLS, build_system_prompt, execute_tool
from app.utils import apply_line_range, apply_section_replace

SOURCE = (
    "def update(self):\n"
    "    self.x += 1\n"
    "    self.y += 1\n"
    "\n"
    "def draw(self):\n"
    "    print(self.x)\n"
)


def _run(root, call, auto_apply=True):
    return asyncio.run(execute_tool(str(root), call, auto_apply))


class TestApplyLineRange:
    def test_replaces_one_line_without_the_old_text(self):
        res = apply_line_range(SOURCE, 2, 2, "    self.x += 5")
        assert res["ok"] is True
        assert res["newContent"] == (
            "def update(self):\n"
            "    self.x += 5\n"
            "    self.y += 1\n"
            "\n"
            "def draw(self):\n"
            "    print(self.x)\n"
        )
        assert res["replaced"] == 1 and res["added"] == 1

    def test_omitted_end_changes_only_that_line(self):
        res = apply_line_range("a\nb\nc\n", 2, None, "B")
        assert res["ok"] is True
        assert res["newContent"] == "a\nB\nc\n"

    def test_line_numbers_are_one_based(self):
        assert apply_line_range("a\nb\n", 0, 1, "z")["ok"] is False
        res = apply_line_range("a\nb\n", 1, 1, "z")
        assert res["newContent"] == "z\nb\n"

    def test_negative_numbers_count_from_the_end(self):
        res = apply_line_range("a\nb\nc\n", -1, -1, "C")
        assert res["ok"] is True
        assert res["newContent"] == "a\nb\nC\n"

    def test_end_before_start_inserts_without_removing(self):
        res = apply_line_range("a\nb\n", 2, 1, "inserted")
        assert res["ok"] is True
        assert res["newContent"] == "a\ninserted\nb\n"
        assert res["replaced"] == 0 and res["added"] == 1

    def test_empty_content_deletes_the_lines(self):
        res = apply_line_range("keep\nremove\nkeep2\n", 2, 2, "")
        assert res["ok"] is True
        assert res["newContent"] == "keep\nkeep2\n"

    def test_crlf_input_is_returned_normalized(self):
        res = apply_line_range("a\r\nb\r\nc\r\n", 2, 2, "B")
        assert res["ok"] is True
        assert res["newContent"] == "a\nB\nc\n"

    def test_out_of_range_end_is_refused_with_the_real_line_count(self):
        res = apply_line_range("a\nb\n", 1, 99, "z")
        assert res["ok"] is False
        assert "2 line(s)" in res["error"]

    def test_stale_expect_is_refused_and_shows_the_real_line(self):
        res = apply_line_range(SOURCE, 2, 2, "    self.x += 5", expect="    self.x -= 1")
        assert res["ok"] is False
        assert "self.x += 1" in res["error"]
        assert "nothing was written" in res["error"]

    def test_matching_expect_allows_the_edit(self):
        res = apply_line_range(SOURCE, 3, 3, "    self.y += 2", expect="    self.y += 1")
        assert res["ok"] is True
        assert "self.y += 2" in res["newContent"]

    def test_matching_expect_ignores_whitespace_differences(self):
        res = apply_line_range(SOURCE, 2, 2, "x", expect="self.x += 1")
        assert res["ok"] is True

    def test_refuses_to_delete_most_of_a_file(self):
        content = "".join(f"line{i}\n" for i in range(60))
        res = apply_line_range(content, 1, 59, "")
        assert res["ok"] is False
        assert "rewrite" in res["error"]
        assert "force" in res["error"]

    def test_small_file_whole_line_edit_is_allowed(self):
        res = apply_line_range("a\nb\nc\n", 1, 3, "x\ny\nz")
        assert res["ok"] is True
        assert res["newContent"] == "x\ny\nz\n"


class TestApplySectionReplace:
    def test_replaces_only_between_the_anchors_and_keeps_them(self):
        res = apply_section_replace(SOURCE, "def update(self):", "def draw(self):", "    self.x += 42\n")
        assert res["ok"] is True
        assert res["newContent"] == (
            "def update(self):\n"
            "    self.x += 42\n"
            "def draw(self):\n"
            "    print(self.x)\n"
        )
        assert res["replaced"] == 3 and res["added"] == 1

    def test_missing_start_anchor_suggests_the_closest_line(self):
        res = apply_section_replace(SOURCE, "def update(self)", "def draw(self):", "x")
        assert res["ok"] is False
        assert "Could not find the start anchor" in res["error"]
        assert "def update(self):" in res["error"]

    def test_ambiguous_anchor_is_refused(self):
        content = "def a():\n    pass\ndef a():\n    pass\n"
        res = apply_section_replace(content, "def a():", None, "    x")
        assert res["ok"] is False
        assert "matches 2 places" in res["error"]

    def test_swapped_anchors_are_refused(self):
        res = apply_section_replace(SOURCE, "def draw(self):", "def update(self):", "x")
        assert res["ok"] is False
        assert "BELOW the start anchor" in res["error"]

    def test_content_that_repeats_the_start_anchor_is_refused(self):
        res = apply_section_replace(SOURCE, "def update(self):", "def draw(self):", "def update(self):\n    pass\n")
        assert res["ok"] is False
        assert "KEPT as-is" in res["error"]

    def test_omitted_start_anchor_replaces_from_the_top(self):
        res = apply_section_replace(SOURCE, None, "def draw(self):", "# header\n")
        assert res["ok"] is True
        assert res["newContent"] == "# header\ndef draw(self):\n    print(self.x)\n"

    def test_omitted_end_anchor_replaces_to_the_end(self):
        res = apply_section_replace(SOURCE, "def draw(self):", None, "    print('x')\n")
        assert res["ok"] is True
        assert res["newContent"].endswith("def draw(self):\n    print('x')\n")

    def test_requires_at_least_one_anchor(self):
        res = apply_section_replace(SOURCE, None, None, "x")
        assert res["ok"] is False
        assert "at least one" in res["error"]


class TestRegionEditTools:
    def test_registered_and_mutating(self):
        names = {t["name"] for t in AGENT_TOOL_DEFS}
        assert "edit_lines" in names and "edit_section" in names
        assert "edit_lines" in MUTATING_TOOLS and "edit_section" in MUTATING_TOOLS

    def test_in_system_prompt(self):
        prompt = build_system_prompt("/ws", "u", True)
        assert "edit_lines" in prompt and "edit_section" in prompt
        assert "EDITING AN EXISTING FILE" in prompt

    def test_hidden_without_auto_apply(self):
        from app.agent import available_tools

        names = {t["name"] for t in available_tools(False)}
        assert "edit_lines" not in names and "edit_section" not in names
        assert "edit_lines" in {t["name"] for t in available_tools(True)}

    def test_edit_lines_tool_edits_by_number(self, tmp_path):
        (tmp_path / "snake.py").write_text(SOURCE, encoding="utf-8")
        res = _run(tmp_path, {"tool": "edit_lines", "args": {"path": "snake.py", "start": 2, "end": 2, "content": "    self.x = 99", "expect": "    self.x += 1"}})
        assert res["ok"] is True, res["output"]
        assert "snake.py" in res["output"]
        assert (tmp_path / "snake.py").read_text(encoding="utf-8").startswith("def update(self):\n    self.x = 99\n")
        assert res["fileWrite"]["changeType"] == "edited"

    def test_edit_lines_refusal_does_not_touch_the_file(self, tmp_path):
        (tmp_path / "snake.py").write_text(SOURCE, encoding="utf-8")
        res = _run(tmp_path, {"tool": "edit_lines", "args": {"path": "snake.py", "start": 2, "end": 2, "content": "x", "expect": "    self.y += 1"}})
        assert res["ok"] is False
        assert "refused" in res["output"]
        assert (tmp_path / "snake.py").read_text(encoding="utf-8") == SOURCE

    def test_edit_lines_requires_start(self, tmp_path):
        (tmp_path / "snake.py").write_text(SOURCE, encoding="utf-8")
        res = _run(tmp_path, {"tool": "edit_lines", "args": {"path": "snake.py", "content": "x"}})
        assert res["ok"] is False and "start" in res["output"]

    def test_edit_section_tool_rewrites_a_region(self, tmp_path):
        (tmp_path / "snake.py").write_text(SOURCE, encoding="utf-8")
        res = _run(tmp_path, {"tool": "edit_section", "args": {"path": "snake.py", "start_anchor": "def update(self):", "end_anchor": "def draw(self):", "content": "    self.x += 7\n"}})
        assert res["ok"] is True, res["output"]
        body = (tmp_path / "snake.py").read_text(encoding="utf-8")
        assert body == "def update(self):\n    self.x += 7\ndef draw(self):\n    print(self.x)\n"
        assert "def draw(self):" in body

    def test_edit_section_requires_anchors(self, tmp_path):
        (tmp_path / "snake.py").write_text(SOURCE, encoding="utf-8")
        res = _run(tmp_path, {"tool": "edit_section", "args": {"path": "snake.py", "content": "x"}})
        assert res["ok"] is False and "anchor" in res["output"]

    def test_both_tools_disabled_without_auto_apply(self, tmp_path):
        (tmp_path / "snake.py").write_text(SOURCE, encoding="utf-8")
        res = _run(tmp_path, {"tool": "edit_lines", "args": {"path": "snake.py", "start": 1, "end": 1, "content": "x"}}, auto_apply=False)
        assert res["ok"] is False and "auto-apply" in res["output"]

    def test_accepts_camelcase_and_alias_argument_names(self, tmp_path):
        (tmp_path / "snake.py").write_text(SOURCE, encoding="utf-8")
        res = _run(tmp_path, {"tool": "edit_lines", "args": {"file": "snake.py", "startLine": 2, "endLine": 3, "newContent": "    pass"}})
        assert res["ok"] is True, res["output"]
        assert (tmp_path / "snake.py").read_text(encoding="utf-8") == "def update(self):\n    pass\n\ndef draw(self):\n    print(self.x)\n"

    def test_large_region_removal_reports_how_much_went(self, tmp_path):
        body = "\n".join(f"line{i} = {i}" for i in range(40))
        (tmp_path / "big.py").write_text("def a():\n" + body + "\ndef z():\n    pass\n", encoding="utf-8")
        res = _run(tmp_path, {"tool": "edit_lines", "args": {"path": "big.py", "start": 2, "end": 30, "content": "    x = 1"}})
        assert res["ok"] is True, res["output"]
        assert "removed 29 lines" in res["output"]


class TestReadFileNumbers:
    def test_numbers_flag_prefixes_each_line(self, tmp_path):
        (tmp_path / "snake.py").write_text(SOURCE, encoding="utf-8")
        res = _run(tmp_path, {"tool": "read_file", "args": {"path": "snake.py", "numbers": True}})
        assert res["ok"] is True
        assert "1| def update(self):" in res["output"]
        assert "5| def draw(self):" in res["output"]
        assert "line numbers" in res["output"]

    def test_no_numbers_by_default(self, tmp_path):
        (tmp_path / "snake.py").write_text(SOURCE, encoding="utf-8")
        res = _run(tmp_path, {"tool": "read_file", "args": {"path": "snake.py"}})
        assert "1| " not in res["output"]

    def test_numbering_works_with_an_offset(self, tmp_path):
        (tmp_path / "big.py").write_text("a\nb\nc\n", encoding="utf-8")
        res = _run(tmp_path, {"tool": "read_file", "args": {"path": "big.py", "offset": 2, "numbers": True}})
        assert res["ok"] is True
        # offset 2 is the start of line 2 ("b")
        assert "2| b" in res["output"]


class TestNumberedPasteIsTolerated:
    """A model that read a file with "numbers": true will sometimes paste the
    numbered lines straight into an edit. That is recoverable, not a failure."""

    def test_old_string_with_pasted_numbers_still_matches(self, tmp_path):
        (tmp_path / "snake.py").write_text(SOURCE, encoding="utf-8")
        numbered = "     5| def draw(self):\n     6|     print(self.x)"
        res = _run(tmp_path, {"tool": "edit_file", "args": {"path": "snake.py", "old_string": numbered, "new_string": "def draw(self):\n    print('x')"}})
        assert res["ok"] is True, res["output"]
        assert (tmp_path / "snake.py").read_text(encoding="utf-8").endswith("def draw(self):\n    print('x')\n")

    def test_plain_text_is_left_alone(self, tmp_path):
        (tmp_path / "notes.txt").write_text("12| keep this\n", encoding="utf-8")
        res = _run(tmp_path, {"tool": "edit_file", "args": {"path": "notes.txt", "old_string": "12| keep", "new_string": "12| kept"}})
        assert res["ok"] is True
        assert (tmp_path / "notes.txt").read_text(encoding="utf-8") == "12| kept this\n"


class TestRewriteRefusalPointsAtEasierTools:
    def test_write_file_refusal_mentions_edit_lines(self, tmp_path):
        (tmp_path / "app.py").write_text("".join(f"line{i} = {i}\n" for i in range(60)), encoding="utf-8")
        rewrite = "".join(f"other{i} = {i}\n" for i in range(60))
        res = _run(tmp_path, {"tool": "write_file", "args": {"path": "app.py", "content": rewrite}})
        assert res["ok"] is False
        assert "edit_lines" in res["output"] and "edit_section" in res["output"]
