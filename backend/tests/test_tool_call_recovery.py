"""Regression tests for the write_file malformed-call failure chain.

Reproduces the field failure: small models emit write_file JSON containing
regex escapes (\\d+), Windows paths (C:\\Users), unescaped quotes
(print("hi")), or truncated content — none of which json.loads accepts.
Before the fix these burned 4 retry rounds (30-90s each on a slow model)
and then tripped the identical-call guard, ending the run with
"I stopped because my read_file attempt kept failing".
"""

from __future__ import annotations

import pytest

from app.agent import (
    extract_tool_call,
    extract_tool_calls,
    fix_invalid_json_escapes,
    repair_tool_json,
    salvage_tool_call_heuristic,
)


class TestInvalidJsonEscapes:
    """Backslash-escapes json.loads rejects, which code content is full of."""

    def test_fix_doubles_invalid_escapes(self):
        assert fix_invalid_json_escapes(r"\d+") == r"\\d+"

    def test_fix_leaves_valid_escapes(self):
        # \n \t \" \\ \/ are all valid JSON escapes — untouched.
        assert fix_invalid_json_escapes('"a\\nb\\tc\\"d\\\\e\\/f"') == '"a\\nb\\tc\\"d\\\\e\\/f"'

    def test_fix_leaves_unicode_escape(self):
        assert fix_invalid_json_escapes('"\\u0041"') == '"\\u0041"'

    def test_regex_in_write_content(self):
        raw = '{"tool": "write_file", "args": {"path": "a.py", "content": "import re\\nm = re.match(r\'\\d+\', s)\\n"}}'
        parsed = extract_tool_calls(raw)
        assert parsed and parsed[0]["tool"] == "write_file"
        assert parsed[0]["args"]["content"] == "import re\nm = re.match(r'\\d+', s)\n"

    def test_windows_path_in_content(self):
        # C:\Games\X — \G and \X are invalid JSON escapes (note: \t in
        # \test would be a VALID tab escape, so it's excluded here).
        raw = '{"tool": "write_file", "args": {"path": "a.py", "content": "p = \\"C:\\Games\\Xx\\"\\n"}}'
        parsed = extract_tool_calls(raw)
        assert parsed and parsed[0]["args"]["content"] == 'p = "C:\\Games\\Xx"\n'


class TestUnescapedQuotesAndTruncation:
    """Calls no JSON parser can ever accept — heuristic salvage territory."""

    def test_unescaped_quote_in_content(self):
        raw = '{"tool": "write_file", "args": {"path": "a.py", "content": "print("hello")"}}'
        parsed = extract_tool_calls(raw)
        assert parsed and parsed[0]["args"]["content"] == 'print("hello")'

    def test_unescaped_quotes_and_newlines(self):
        nl = chr(10)
        raw = '{"tool": "write_file", "args": {"path": "a.py", "content": "def f():' + nl + '    print("hi")' + nl + '"}}'
        parsed = extract_tool_calls(raw)
        assert parsed and parsed[0]["args"]["content"] == "def f():\n    print(\"hi\")\n"

    def test_truncated_call_recovers_path(self):
        raw = '{"tool": "write_file", "args": {"path": "a.py", "content": "import pygame\\n'
        parsed = extract_tool_calls(raw)
        assert parsed and parsed[0]["tool"] == "write_file"
        assert parsed[0]["args"]["path"] == "a.py"
        # Content survives (partial) rather than the whole call being lost,
        # AND the call is tagged _truncated so the agent loop refuses to
        # execute it (a half-written file is worse than no file).
        assert "import pygame" in parsed[0]["args"]["content"]
        assert parsed[0]["args"].get("_truncated") is True

    def test_unknown_tool_never_salvaged(self):
        raw = '{"tool": "format_disk", "args": {"path": "a.py", "content": "x"}}'
        assert salvage_tool_call_heuristic(raw) is None

    def test_plain_prose_not_salvaged(self):
        assert salvage_tool_call_heuristic("I will write the snake game now.") is None

    def test_escaped_quotes_decode_to_real_quotes(self):
        """The tetris bug: salvage dropped the backslash of \\\" escapes, so
        every docstring landed on disk as backslash-quote and the file could
        never run. Escaped quotes must decode to real quotes."""
        raw = '{"tool": "write_file", "args": {"path": "t.py", "content": "def f():\\n    \\"""Docstring\\"""\\n    return 1\\n"}}'
        parsed = extract_tool_calls(raw)
        assert parsed and parsed[0]["args"]["content"] == 'def f():\n    """Docstring"""\n    return 1\n'

    def test_escaped_backslash_before_n_not_double_decoded(self):
        # "\\n" (backslash-backslash-n) must decode to literal backslash + n,
        # NOT newline — sequential .replace() passes got this wrong.
        raw = '{"tool": "write_file", "args": {"path": "t.py", "content": "x = \\\\nprint(x)"}}'
        parsed = extract_tool_calls(raw)
        assert parsed and parsed[0]["args"]["content"] == "x = \\nprint(x)"

    def test_unescaped_quotes_still_kept_in_value(self):
        # print("hi") — the quote is not followed by a key/brace, so it is
        # part of the value (behavior preserved from the old scanner).
        raw = '{"tool": "write_file", "args": {"path": "a.py", "content": "print("hello")"}}'
        parsed = extract_tool_calls(raw)
        assert parsed and parsed[0]["args"]["content"] == 'print("hello")'

    def test_complete_sloppy_call_not_tagged(self):
        # Unescaped quotes / raw newlines make json fail, but the braces are
        # balanced — the call is COMPLETE, just sloppy. No _truncated tag:
        # the agent loop must execute it as-is.
        raw = '{"tool": "write_file", "args": {"path": "a.py", "content": "print("x")"}}'
        parsed = extract_tool_calls(raw)
        assert parsed and parsed[0]["args"].get("_truncated") is None

    def test_truncated_read_file_tagged(self):
        # Truncation tag applies to ANY salvaged call (the loop strips it
        # from read-only ones and executes them; mutating ones are refused).
        raw = '{"tool": "read_file", "args": {"path": "big.py", "offset": 0'
        parsed = extract_tool_calls(raw)
        assert parsed and parsed[0]["args"].get("_truncated") is True


class TestBothExtractorsCovered:
    """The sub-agent extractor must share the same recovery paths."""

    def test_singular_extractor_repairs_escapes(self):
        raw = '{"tool": "write_file", "args": {"path": "a.py", "content": "r\'\\d+\'"}}'
        parsed = extract_tool_call(raw)
        assert parsed and parsed["tool"] == "write_file"
        assert parsed["args"]["content"] == "r'\\d+'"

    def test_singular_extractor_salvages_unescaped_quotes(self):
        raw = '{"tool": "write_file", "args": {"path": "a.py", "content": "print("hi")"}}'
        parsed = extract_tool_call(raw)
        assert parsed and parsed["args"]["content"] == 'print("hi")'

    def test_repair_tool_json_direct_escape_fix(self):
        raw = '{"tool": "write_file", "args": {"path": "a.py", "content": "\\d\\w\\s"}}'
        parsed = repair_tool_json(raw)
        assert parsed and parsed["args"]["content"] == "\\d\\w\\s"


class TestValidCallsUnaffected:
    """Clean calls must parse byte-identical through the new layers."""

    @pytest.mark.parametrize(
        "raw,expected_content",
        [
            ('{"tool": "write_file", "args": {"path": "a.py", "content": "print(1)\\n"}}', "print(1)\n"),
            ('{"name": "write_file", "arguments": {"path": "a.py", "content": "x = {1: {2: 3}}\\n"}}', "x = {1: {2: 3}}\n"),
            ('{"tool": "write_file", "args": {"path": "a.py", "content": "d = {1: {2: 3}}\\n"}}', "d = {1: {2: 3}}\n"),
        ],
    )
    def test_valid_forms_unchanged(self, raw, expected_content):
        parsed = extract_tool_calls(raw)
        assert parsed and parsed[0]["args"]["content"] == expected_content
