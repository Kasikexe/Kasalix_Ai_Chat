from app.agent import build_working_summary, prune_to_budget


def test_summary_retains_goal_progress_and_failure_evidence():
    history = [{"role": "user", "content": "[TOOL RESULT — run_command]\nFAILED: 2 tests failed"}]
    summary = build_working_summary(history, [{"role": "user", "content": "Fix login without changing the API"}], ["edit_file: login.py"], "Inspect login\nRun tests")
    assert "Fix login without changing the API" in summary
    assert "edit_file: login.py" in summary
    assert "FAILED: 2 tests failed" in summary
    assert "Inspect login" in summary


def test_pruned_tool_result_retains_failure_at_end():
    messages = [{"role": "system", "content": "system"}]
    messages += [{"role": "user", "content": "[TOOL RESULT — run_command]\n" + "x" * 12000 + "\nFAILED exit code 7"} for _ in range(8)]
    result = prune_to_budget(messages)
    assert result["didCompact"]
    assert any("FAILED exit code 7" in m["content"] for m in result["messages"])
    assert all("Output received and processed" not in m["content"] for m in result["messages"])
