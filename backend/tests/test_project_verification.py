import asyncio
import json

from app import agent


def test_selects_nearest_project_for_each_changed_file(tmp_path):
    ui = tmp_path / "ui"
    api = tmp_path / "service"
    ui.mkdir()
    api.mkdir()
    (ui / "package.json").write_text(json.dumps({"scripts": {"test": "vitest"}}))
    (api / "go.mod").write_text("module example")
    checks = asyncio.run(agent.detect_verify_for_paths(str(tmp_path), {"ui/app.ts", "service/main.go"}))
    assert {(check["cwd"], check["label"]) for check in checks} == {(str(ui), "npm test"), (str(api), "go test")}


def test_workspace_override_is_used_for_nested_changes(tmp_path):
    (tmp_path / ".agent-config.json").write_text(json.dumps({"verifyCommand": "custom-check"}))
    checks = asyncio.run(agent.detect_verify_for_paths(str(tmp_path), {"ui/app.ts"}))
    assert len(checks) == 1
    assert checks[0]["command"] == "custom-check"
    assert checks[0]["cwd"] == str(tmp_path)


def test_verification_runs_once_after_multiple_edits(tmp_path, monkeypatch):
    (tmp_path / ".agent-config.json").write_text(json.dumps({"verifyCommand": "custom-check"}))
    replies = iter([
        '{"tool":"write_file","args":{"path":"a.txt","content":"one"}}',
        '{"tool":"write_file","args":{"path":"b.txt","content":"two"}}',
        "Changes complete.",
        "Changes complete and verified.",
    ])
    commands = []

    async def stream(_opts, _messages, on_chunk, _thinking, **_kwargs):
        reply = next(replies, "Changes complete and verified.")
        on_chunk(reply)
        return reply

    async def verify(command, cwd, cap, signal=None):
        commands.append((command, cwd))
        return "passed"

    monkeypatch.setattr(agent, "stream_chat_with_retry", stream)
    monkeypatch.setattr(agent, "_run_verify", verify)
    asyncio.run(agent.run_agent_loop({"model": "fake", "workspacePath": str(tmp_path), "autoApply": True,
                                     "messages": [{"role": "user", "content": "create files"}], "callbacks": {}}))
    assert commands == [("custom-check", str(tmp_path))]
