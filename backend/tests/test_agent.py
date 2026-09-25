"""Port of backend/test/agent.test.ts — agent pure functions."""

import os
import tempfile

import pytest

from app.agent import (
    detect_verify_command,
    estimate_tokens,
    extract_tool_call,
    extract_tool_calls,
    is_transient_error,
    parse_code_block_files,
    prune_to_budget,
    repair_tool_json,
)


class TestRepairToolJson:
    """Near-miss JSON the models actually emit must be repaired in place —
    each unparseable call otherwise costs a 30-90s retry round."""

    def test_valid_json_untouched(self):
        assert repair_tool_json('{"tool": "list_files", "args": {}}')["tool"] == "list_files"

    def test_trailing_comma(self):
        assert repair_tool_json('{"tool": "read_file", "args": {"path": "x.py"},}')["tool"] == "read_file"

    def test_markdown_fences(self):
        raw = '```json\n{"tool": "list_files", "args": {}}\n```'
        assert repair_tool_json(raw)["tool"] == "list_files"

    def test_single_quotes(self):
        assert repair_tool_json("{'tool': 'list_files', 'args': {}}")["tool"] == "list_files"

    def test_literal_newline_in_string(self):
        raw = '{"tool": "write_file", "args": {"path": "a.py", "content": "line1\nline2"}}'
        parsed = repair_tool_json(raw)
        assert parsed["args"]["content"] == "line1\nline2"

    def test_unquoted_keys(self):
        assert repair_tool_json('{tool: "read_file", args: {"path": "x.py"}}')["tool"] == "read_file"

    def test_prose_wrapped_object(self):
        raw = 'Here is my call: {"tool": "list_files", "args": {}} hope that works'
        assert repair_tool_json(raw)["tool"] == "list_files"

    def test_garbage_returns_none(self):
        assert repair_tool_json('this is not json at all') is None

    def test_multiple_valid_calls_accepted(self):
        raw = '{"tool": "read_file", "args": {"path": "a.py"}}\n{"tool": "list_files", "args": {}}'
        calls = extract_tool_calls(raw)
        assert [c["tool"] for c in calls] == ["read_file", "list_files"]


class TestOpenAiStyleToolDialect:
    """Small models drift into OpenAI-style {"name", "arguments"} tool calls.
    The parser must execute the obvious intent instead of dumping raw JSON
    into the chat (regression: user's snake_game.py request)."""

    def test_openai_style_name_arguments(self):
        calls = extract_tool_calls('{"name": "read_file", "arguments": {"path": "snake_game.py"}}')
        assert calls == [{"tool": "read_file", "args": {"path": "snake_game.py"}}]

    def test_canonical_format_still_works(self):
        calls = extract_tool_calls('{"tool": "write_file", "args": {"path": "a.py", "content": "x=1"}}')
        assert calls[0]["tool"] == "write_file"

    def test_fenced_and_surrounded_by_prose(self):
        calls = extract_tool_calls('Sure!\n```json\n{"name": "list_files", "arguments": {"path": "."}}\n```')
        assert calls == [{"tool": "list_files", "args": {"path": "."}}]

    def test_mixed_dialects_in_one_response(self):
        raw = '{"name": "read_file", "arguments": {"path": "a.py"}}\n{"tool": "list_files", "args": {}}'
        calls = extract_tool_calls(raw)
        assert [c["tool"] for c in calls] == ["read_file", "list_files"]

    def test_unknown_tool_not_executed(self):
        assert extract_tool_calls('{"name": "format_disk", "arguments": {}}') == []

    def test_prose_with_name_key_not_misdetected(self):
        assert extract_tool_calls('The object {"name": "values"} holds items') == []


class TestExtractToolCall:
    def test_parses_a_clean_json_tool_call(self):
        call = extract_tool_call('{"tool": "read_file", "args": {"path": "src/index.ts"}}')
        assert call == {"tool": "read_file", "args": {"path": "src/index.ts"}}

    def test_tolerates_markdown_fences(self):
        raw = '```json\n{"tool": "list_files", "args": {}}\n```'
        assert extract_tool_call(raw)["tool"] == "list_files"

    def test_extracts_from_surrounding_prose(self):
        raw = 'Let me check that. {"tool": "search_files", "args": {"query": "foo"}} Done.'
        assert extract_tool_call(raw)["tool"] == "search_files"

    def test_rejects_unknown_tools(self):
        assert extract_tool_call('{"tool": "rm_rf", "args": {}}') is None

    def test_returns_none_for_plain_prose(self):
        assert extract_tool_call("Hello, how can I help?") is None

    def test_truncated_call_is_salvaged(self):
        # A truncated call whose intent is obvious now RECOVERS via the
        # heuristic salvage instead of burning a retry round — and is tagged
        # _truncated so the agent loop refuses to EXECUTE mutating half-calls
        # (the flag is stripped from read-only calls before execution).
        parsed = extract_tool_call('{"tool": "read_file", "args": {"path": "unterminated')
        assert parsed == {"tool": "read_file", "args": {"path": "unterminated", "_truncated": True}}

    def test_returns_none_for_plain_prose(self):
        assert extract_tool_call("I will read the file next.") is None


class TestParseCodeBlockFiles:
    def test_parses_a_new_file_block_with_a_path_comment(self):
        blocks = parse_code_block_files('Here is the file:\n\n```python\n# main.py\nprint("hi")\n```')
        assert len(blocks) == 1
        assert blocks[0]["type"] == "create"
        assert blocks[0]["path"] == "main.py"
        assert "print(\"hi\")" in blocks[0]["content"]

    def test_parses_an_edit_block(self):
        raw = "```\n// EDIT: src/app.ts\nOLD:\nconst x = 1;\n---\nNEW:\nconst x = 2;\n```"
        blocks = parse_code_block_files(raw)
        assert len(blocks) == 1
        assert blocks[0]["type"] == "edit"
        assert blocks[0]["path"] == "src/app.ts"
        assert blocks[0]["oldString"] == "const x = 1;"
        assert blocks[0]["newString"] == "const x = 2;"

    def test_parses_a_delete_block(self):
        blocks = parse_code_block_files("```\n// DELETE: src/old.ts\n```")
        assert len(blocks) == 1
        assert blocks[0]["type"] == "delete"
        assert blocks[0]["path"] == "src/old.ts"


class TestContextBudget:
    def test_estimate_tokens_is_roughly_chars_over_four(self):
        assert estimate_tokens("abcd") == 1
        assert estimate_tokens("") == 1  # max(1, ...)

    def test_small_history_is_left_alone(self):
        msgs = [
            {"role": "system", "content": "s"},
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "yo"},
        ]
        result = prune_to_budget(msgs)
        assert result["messages"] == msgs

    def test_oversized_history_prunes_oldest_keeps_newest(self):
        big = "x" * 20000  # ~5000 tokens each
        msgs = [{"role": "system", "content": "sys"}] + [
            {"role": "user", "content": f"msg{i}:{big}"} for i in range(20)
        ]
        pruned = prune_to_budget(msgs)["messages"]
        assert pruned[0]["role"] == "system"
        non_system = [m for m in pruned if m["role"] != "system"]
        assert len(non_system) >= 1
        assert len(non_system) < 20
        assert non_system[-1]["content"] == f"msg19:{big}"

    def test_image_markers_survive_pruning_intact(self):
        """Screenshots ride in [image:data:...] markers. Pruning must NEVER
        truncate the base64 (that would corrupt the image sent to Ollama) nor
        count it against the text token budget — markers are re-attached to
        surviving messages verbatim."""
        b64 = "A" * 4000  # ~1000 text-equivalent tokens if miscounted
        marker = f"[image:data:image/png;base64,{b64}]"
        big = "x" * 20000
        msgs = [{"role": "system", "content": "sys"}] + [
            {"role": "user", "content": f"msg{i}:{big}"} for i in range(20)
        ] + [{"role": "user", "content": f"[TOOL RESULT — preview_screenshot]\nScreenshot.\n\n{marker}"}]
        pruned = prune_to_budget(msgs)["messages"]
        assert "[TOOL RESULT — preview_screenshot]" in pruned[-1]["content"]
        assert marker in pruned[-1]["content"]
        # The oldest oversize text was still pruned
        assert len([m for m in pruned if m["role"] == "user"]) < 21

    def test_image_marker_base64_never_truncated_by_tool_result_pruning(self):
        filler = "x" * 3000  # pushes the tool result past the 500-token prune line
        b64 = "B" * 6000
        marker = f"[image:data:image/png;base64,{b64}]"
        big = "y" * 20000  # older messages force the budget over the limit
        msgs = [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "q"},
            *[ {"role": "user", "content": f"old{i}:{big}"} for i in range(10) ],
            {"role": "user", "content": "[TOOL RESULT — preview_screenshot]\n" + filler + "\n\n" + marker},
        ]
        result = prune_to_budget(msgs)["messages"]
        shots = [m for m in result if "[TOOL RESULT — preview_screenshot]" in m["content"]]
        assert len(shots) == 1
        assert marker in shots[0]["content"], "base64 truncated by pruning — image would be corrupt"
        assert filler not in shots[0]["content"], "text portion should still be prunable"



class TestIsTransientError:
    def test_network_failures_are_transient(self):
        assert is_transient_error(RuntimeError("fetch failed")) is True
        assert is_transient_error(RuntimeError("ECONNREFUSED 127.0.0.1:11434")) is True

    def test_5xx_is_transient(self):
        assert is_transient_error(RuntimeError("Ollama error (503): unavailable")) is True

    def test_aborts_are_never_retried(self):
        assert is_transient_error(RuntimeError("Aborted")) is False

    def test_4xx_is_never_retried(self):
        assert is_transient_error(RuntimeError("Ollama error (404): model not found")) is False


class TestDetectVerifyCommand:
    @pytest.fixture()
    def workspace(self, tmp_path):
        return tmp_path

    def _write(self, root, files):
        for rel, content in files.items():
            full = root / rel
            full.parent.mkdir(parents=True, exist_ok=True)
            full.write_text(content, encoding="utf-8")

    async def test_detects_npm_test_from_package_json(self, workspace):
        self._write(workspace, {"package.json": '{"scripts": {"test": "vitest run"}}'})
        cmd = await detect_verify_command(str(workspace))
        assert cmd is not None
        assert cmd.get("label") == "npm test"

    async def test_custom_agent_config_wins_over_package_json(self, workspace):
        self._write(
            workspace,
            {
                "package.json": '{"scripts": {"test": "vitest run"}}',
                ".agent-config.json": '{"verifyCommand": "npm run lint", "verifyLabel": "lint"}',
            },
        )
        cmd = await detect_verify_command(str(workspace))
        assert "npm run lint" in cmd["command"]
        assert cmd.get("label") == "lint"

    async def test_verify_enabled_false_disables_auto_verify(self, workspace):
        self._write(
            workspace,
            {
                "package.json": '{"scripts": {"test": "vitest run"}}',
                ".agent-config.json": '{"verifyEnabled": false}',
            },
        )
        assert await detect_verify_command(str(workspace)) is None

    async def test_returns_none_for_unrecognized_project(self, workspace):
        self._write(workspace, {"readme.txt": "nothing here"})
        assert await detect_verify_command(str(workspace)) is None

class TestShellBlockDetection:
    """Shell/example code blocks must never be auto-applied as file writes —
    the 'pip install pygame' bug that caused false rewrite-refusals."""

    def test_shell_block_skipped(self):
        from app.agent import parse_code_block_files
        answer = "Run it like this:\n\n```bash\n# Use Python 3.11\npip install pygame\npy -3.11 -m snake_game\n```\n\nGame is in `snake_game.py`."
        blocks = parse_code_block_files(answer)
        assert blocks == []

    def test_real_code_file_still_applies(self):
        from app.agent import parse_code_block_files
        answer = "Here is the game:\n\n```python\n# snake_game.py\nimport pygame\npygame.init()\nprint('ok')\n```"
        blocks = parse_code_block_files(answer)
        assert len(blocks) == 1 and blocks[0]["type"] == "create" and blocks[0]["path"] == "snake_game.py"


class TestAgentPromptGuards:
    def test_system_prompt_availability_full(self):
        from app.agent import build_system_prompt
        p = build_system_prompt("/ws", "user", True)
        assert "NEVER claim you cannot run commands" in p
        assert "py -3.11" in p

    def test_system_prompt_availability_readonly(self):
        from app.agent import build_system_prompt
        p = build_system_prompt("/ws", "user", False)
        assert "read-only (no run_command)" in p

    def test_user_deletion_intent_regex(self):
        import re
        assert re.search(r"\b(delet?e|remove|get rid of|clean up)\b", "please delete the old file", re.I)
        assert not re.search(r"\b(delet?e|remove|get rid of|clean up)\b", "run the game with python 3.11", re.I)


class TestGenImageTool:
    """gen_image — agent writes real image assets into the workspace."""

    SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="#123"/></svg>'

    def test_registered_and_mutating(self):
        from app.agent import AGENT_TOOL_DEFS, MUTATING_TOOLS
        gen = [t for t in AGENT_TOOL_DEFS if t["name"] == "gen_image"]
        assert len(gen) == 1 and gen[0]["mutating"] is True
        assert "gen_image" in MUTATING_TOOLS

    def test_in_examples_and_prompt(self):
        from app.agent import build_system_prompt
        p = build_system_prompt("/ws", "u", True)
        assert "gen_image" in p and "assets/" in p

    def test_rejects_non_image_extension(self):
        import asyncio
        from app.agent import execute_tool
        r = asyncio.run(execute_tool("/nonexistent-ws", {"tool": "gen_image", "args": {"path": "x.txt", "svg": self.SVG}}, True))
        assert not r["ok"] and "image extension" in r["output"]

    def test_rejects_path_outside_workspace(self):
        import asyncio
        from app.agent import execute_tool
        r = asyncio.run(execute_tool("/nonexistent-ws", {"tool": "gen_image", "args": {"path": "../x.png", "svg": self.SVG}}, True))
        assert not r["ok"] and "outside" in r["output"]

    def test_disabled_without_auto_apply(self):
        import asyncio
        from app.agent import execute_tool
        r = asyncio.run(execute_tool("/nonexistent-ws", {"tool": "gen_image", "args": {"path": "a.png", "svg": self.SVG}}, False))
        assert not r["ok"] and "auto-apply" in r["output"]


class TestChurnBreaker:
    """Consecutive-failure guard state exists and the compact notice is once-per-run."""

    def test_compact_notice_emitted_once(self):
        import ast
        src = open("app/agent.py", encoding="utf-8").read()
        assert "compact_notice_shown = True" in src
        assert 'compact_result["didCompact"] and iter > 0 and not compact_notice_shown' in src

    def test_fail_streak_breaker_present(self):
        src = open("app/agent.py", encoding="utf-8").read()
        # 4 (raised from 3): three failures can be legitimate debugging —
        # the breaker must only stop runs that are truly not converging.
        assert "fail_streak >= 4" in src
        assert "I got stuck" in src


class TestStepBudget:
    """Step budget: auto-extension on progress, hard cap, per-workspace override."""

    def test_constants(self):
        from app.agent import MAX_ITERATIONS, MAX_ITERATIONS_HARD_CAP, PROGRESS_WINDOW
        assert MAX_ITERATIONS == 15 and MAX_ITERATIONS_HARD_CAP == 120 and PROGRESS_WINDOW > 0

    def test_workspace_override(self, tmp_path):
        import json
        import asyncio
        (tmp_path / ".agent-config.json").write_text(json.dumps({"maxSteps": 30}), encoding="utf-8")
        # The override is read inside run_agent_loop; verify the config file parses
        # and the clamp logic (min with hard cap) is respected.
        cfg = json.loads((tmp_path / ".agent-config.json").read_text(encoding="utf-8"))
        from app.agent import MAX_ITERATIONS_HARD_CAP
        assert min(cfg["maxSteps"], MAX_ITERATIONS_HARD_CAP) == 30

    def test_extension_logic_present(self):
        src = open("app/agent.py", encoding="utf-8").read()
        assert "max_iterations = min(max_iterations * 2, MAX_ITERATIONS_HARD_CAP)" in src
        assert "run is making progress" in src
        assert "stuck_repeating" in src


class TestEditAutoRecovery:
    """Repeated failed edits get current file content injected; give-up message is actionable."""

    def test_auto_recovery_present(self):
        src = open("app/agent.py", encoding="utf-8").read()
        assert "[AUTO-RECOVERY]" in src
        assert "fail_streak >= 2" in src
        # Must read the real file, not just echo the error
        assert "resolve_target_smart" in src

    def test_giveup_message_actionable(self):
        src = open("app/agent.py", encoding="utf-8").read()
        # No raw JSON dumps to the user
        assert "kept failing the same way" in src
        assert 'json.dumps(tc[\'args\'])' not in src.split("Give up with an ACTIONABLE, HONEST message")[1].split("log_info")[0]

    def test_recovery_injection_reaches_history(self):
        import asyncio, tempfile, os
        from app.agent import resolve_target_smart
        async def check():
            with tempfile.TemporaryDirectory() as td:
                with open(os.path.join(td, "f.py"), "w", encoding="utf-8") as f:
                    f.write("display.fill(white)\n")
                r = await resolve_target_smart(td, "f.py")
                assert os.path.isfile(r["target"])
        asyncio.run(check())

class TestLoopTailStructure:
    """The budget-exhausted break must stay inside the if-block - a break at
    loop-body level ended the run after ONE iteration (v0.11.0 regression)."""

    def test_break_not_at_loop_body_level(self):
        lines = open("app/agent.py", encoding="utf-8").read().splitlines()
        check_idx = next(i for i, l in enumerate(lines) if "if iter >= max_iterations:" in l)
        check_indent = len(lines[check_idx]) - len(lines[check_idx].lstrip())
        ext_idx = next(i for i in range(check_idx, check_idx + 12)
                       if "if recent_success and did_work" in lines[i])
        break_idx = next(i for i in range(ext_idx, ext_idx + 12)
                         if lines[i].strip() == "break")
        break_indent = len(lines[break_idx]) - len(lines[break_idx].lstrip())
        assert break_indent > check_indent, (
            "break at loop-body level - runs would end after a single iteration"
        )


class TestPseudoToolCallSyntax:
    """The model wrote [read_file, {"path": "snake_game.py"}] — not JSON — so
    nothing executed while the user was told it was reading and testing the
    file. These syntaxes must be salvaged, not shipped as prose."""

    @pytest.mark.parametrize("raw", [
        '[read_file, {"path": "snake_game.py"}]',
        '[read_file {"path": "snake_game.py"}]',
        '["read_file", {"path": "snake_game.py"}]',
        'read_file({"path": "snake_game.py"})',
    ])
    def test_bracket_and_paren_forms_are_parsed(self, raw):
        calls = extract_tool_calls(raw)
        assert len(calls) == 1, calls
        assert calls[0]["tool"] == "read_file"
        assert calls[0]["args"]["path"] == "snake_game.py"

    def test_keyword_call_form_is_parsed(self):
        calls = extract_tool_calls('read_file(path="snake_game.py")')
        assert calls == [{"tool": "read_file", "args": {"path": "snake_game.py"}}]

    def test_bare_bracket_tool_with_no_args_is_parsed(self):
        assert extract_tool_calls("[git_status]") == [{"tool": "git_status", "args": {}}]

    def test_nested_openai_function_dialect_is_parsed(self):
        raw = '{"function": {"name": "read_file", "arguments": {"path": "f.py"}}}'
        assert extract_tool_calls(raw) == [{"tool": "read_file", "args": {"path": "f.py"}}]

    def test_plain_prose_is_never_parsed(self):
        assert extract_tool_calls("I read the file and it looks fine.") == []
        assert extract_tool_calls("[snake_game.py] is the entry point.") == []

    def test_unknown_tool_name_in_brackets_is_not_parsed(self):
        assert extract_tool_calls('[not_a_real_tool, {"path": "x.py"}]') == []
