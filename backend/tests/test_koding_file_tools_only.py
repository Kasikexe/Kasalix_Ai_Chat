import asyncio
import json

import pytest

from app import agent, ai_rules
from app.agent_protocol import TOOL_ARGUMENTS, native_tool_schemas, normalize_native_calls, normalize_structured_action


KEPT = {
    "list_files", "glob", "read_file", "search_files", "edit_file", "edit_lines", "write_file",
    "rename_file", "delete_file",
}
REMOVED = {
    "find_references", "refactor_rename", "create_directory", "file_exists", "diff_files",
    "replace_in_file", "count_lines", "edit_section", "multi_edit",
    "run_command", "play_game", "run_python", "web_search", "draw_image", "gen_image", "read_image",
    "read_rules", "update_memory", "ask_user", "git_status", "git_diff", "git_commit", "delegate_to_subagent",
    "read_url", "read_url_image", "preview_start", "preview_stop", "preview_screenshot", "preview_eval", "preview_console",
}


def test_only_selected_tools_are_exposed_in_every_catalog():
    assert {t["name"] for t in agent.AGENT_TOOL_DEFS} == KEPT
    assert set(TOOL_ARGUMENTS) == KEPT
    assert {t["function"]["name"] for t in native_tool_schemas(agent.available_tools(True))} == KEPT
    assert all(not t["mutating"] for t in agent.available_tools(False))


@pytest.mark.parametrize("name", sorted(REMOVED))
def test_removed_tool_cannot_be_parsed_or_executed(tmp_path, name):
    raw = json.dumps({"tool": name, "args": {}})
    assert agent.extract_tool_calls(raw) == []
    result = asyncio.run(agent.execute_tool(str(tmp_path), {"tool": name, "args": {}}, True))
    assert result["ok"] is False
    assert "unavailable" in result["output"]
    with pytest.raises(ValueError):
        normalize_native_calls([{"function": {"name": name, "arguments": {}}}], KEPT)


def test_question_is_a_final_response_not_a_tool():
    result = normalize_structured_action('{"action":"question","question":"Which file?"}', KEPT)
    assert result == {"action": "final", "message": "Which file?"}


def test_file_tool_prompt_does_not_offer_removed_tools():
    prompts = [agent.build_system_prompt("/workspace", "user", True),
               agent.build_structured_system_prompt("/workspace", "user", native_tool_schemas(agent.AGENT_TOOL_DEFS))]
    for prompt in prompts:
        for name in REMOVED:
            assert name not in prompt


def test_old_custom_rules_are_filtered_without_editing_the_source(monkeypatch):
    original = "Keep changes focused.\n- Call git_commit when finished.\n- Use run_command to test.\n- Use edit_section to edit."
    monkeypatch.setattr(ai_rules, "_load_rules", lambda: {"core": "Core rule", "agent": original, "chat": ""})
    result = ai_rules.get_ai_rules("agent")
    assert "Keep changes focused" in result
    assert "git_commit" not in result and "run_command" not in result
    assert "edit_section" not in result
    assert "git_commit" in original


def _tool(root, name, args):
    return asyncio.run(agent.execute_tool(str(root), {"tool": name, "args": args}, True))


def test_search_covers_deeper_and_large_files_and_can_match_case(tmp_path):
    folder = tmp_path.joinpath(*[f"d{i}" for i in range(6)])
    folder.mkdir(parents=True)
    (folder / "large.py").write_text("padding\n" * 30000 + "TargetName\ntargetname\n", encoding="utf-8")
    result = _tool(tmp_path, "search_files", {"query": "TargetName", "case_sensitive": True})
    assert result["ok"]
    assert "large.py:30001: TargetName" in result["output"]
    assert "large.py:30002" not in result["output"]


def test_search_reports_match_and_depth_limits(tmp_path):
    (tmp_path / "many.txt").write_text("match\n" * 51, encoding="utf-8")
    assert "may be incomplete" in _tool(tmp_path, "search_files", {"query": "match"})["output"]
    folder = tmp_path.joinpath(*[f"d{i}" for i in range(10)])
    folder.mkdir(parents=True)
    (folder / "deep.py").write_text("needle", encoding="utf-8")
    assert "may be incomplete" in _tool(tmp_path, "search_files", {"query": "needle"})["output"]


def test_glob_finds_root_and_nested_files_and_honors_directory_prefix(tmp_path):
    (tmp_path / "root.py").write_text("", encoding="utf-8")
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "nested.py").write_text("", encoding="utf-8")
    all_files = _tool(tmp_path, "glob", {"pattern": "**/*.py"})["output"]
    assert "root.py" in all_files and "src/nested.py" in all_files
    nested = _tool(tmp_path, "glob", {"pattern": "src/**/*.py"})["output"]
    assert "src/nested.py" in nested and "root.py" not in nested


def test_glob_and_listing_report_limits(tmp_path):
    for index in range(401):
        (tmp_path / f"file{index:03}.txt").touch()
    assert "may be incomplete" in _tool(tmp_path, "glob", {"pattern": "*.txt"})["output"]
    assert "may be incomplete" in _tool(tmp_path, "list_files", {})["output"]
