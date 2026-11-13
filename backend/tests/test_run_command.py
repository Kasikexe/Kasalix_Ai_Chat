import asyncio
import json
import os
import shlex
import subprocess
import sys

import pytest

from app import agent
from app.agent_protocol import native_tool_schemas, normalize_native_calls, normalize_structured_action


def python_command(code):
    args = [sys.executable, "-c", code]
    return subprocess.list2cmdline(args) if os.name == "nt" else shlex.join(args)


def run(root, args, extra=None):
    return asyncio.run(agent.execute_tool(str(root), {"tool": "run_command", "args": args}, True, extra))


def test_command_is_available_in_each_calling_protocol():
    definitions = agent.available_tools(True)
    names = {item["name"] for item in definitions}
    assert "run_command" in names
    assert "run_command" in {item["function"]["name"] for item in native_tool_schemas(definitions)}
    args = {"command": "python -m pytest", "cwd": "backend", "timeout": 300}
    native = normalize_native_calls([{"function": {"name": "run_command", "arguments": args}}], names)
    assert native == [{"tool": "run_command", "args": args}]
    action = normalize_structured_action(
        '{"action":"tool","tool":"run_command","args":{"command":"python -m pytest"}}', names,
    )
    assert action["call"]["tool"] == "run_command"
    assert agent.extract_tool_calls('{"tool":"run_command","args":{"command":"python -m pytest"}}')[0]["tool"] == "run_command"


def test_truncated_command_is_not_salvaged():
    raw = '{"tool":"run_command","args":{"command":"python -m pytest'
    assert agent.extract_tool_calls(raw) == []


@pytest.mark.parametrize("code", [0, 7])
def test_reports_stdout_stderr_and_exit_code(tmp_path, code):
    subdir = tmp_path / "project"
    subdir.mkdir()
    command = python_command(f"import os,sys; print(os.path.basename(os.getcwd())); print('problem', file=sys.stderr); sys.exit({code})")
    result = run(tmp_path, {"command": command, "cwd": "project"})
    assert result["ok"] is (code == 0)
    assert f"Exit code: {code}" in result["output"]
    assert "project" in result["output"] and "problem" in result["output"]


def test_reports_bounded_output(tmp_path):
    command = python_command("import sys; print('x'*10000); print('y'*3000, file=sys.stderr)")
    result = run(tmp_path, {"command": command})
    assert result["ok"]
    assert result["output"].count("truncated; showing last") == 2
    assert len(result["output"]) < 8300


def test_timeout_stops_the_process(tmp_path):
    command = python_command("import time; print('started', flush=True); time.sleep(30)")
    result = run(tmp_path, {"command": command, "timeout": 1})
    assert not result["ok"]
    assert "timed out" in result["output"] and "started" in result["output"]


def test_cancel_stops_the_process(tmp_path, monkeypatch):
    killed = []
    original = agent.kill_process_tree

    async def record_kill(proc):
        killed.append(proc)
        await original(proc)

    async def scenario():
        stop = asyncio.Event()
        command = python_command("import time; time.sleep(30)")
        task = asyncio.create_task(agent.execute_tool(
            str(tmp_path), {"tool": "run_command", "args": {"command": command}}, True, {"signal": stop},
        ))
        await asyncio.sleep(0.5)
        stop.set()
        with pytest.raises(asyncio.CancelledError):
            await task

    monkeypatch.setattr(agent, "kill_process_tree", record_kill)
    asyncio.run(scenario())
    assert len(killed) == 1 and killed[0].returncode is not None


@pytest.mark.parametrize("args", [
    {"command": ""}, {"command": "anything", "cwd": ".."},
    {"command": "anything", "timeout": 0}, {"command": "anything", "timeout": 601},
    {"command": "anything", "timeout": True},
])
def test_rejects_invalid_requests_without_starting_a_process(tmp_path, monkeypatch, args):
    calls = []

    async def fail(*_args, **_kwargs):
        calls.append(True)
        raise RuntimeError("process should not start")

    monkeypatch.setattr(asyncio, "create_subprocess_shell", fail)
    assert not run(tmp_path, args)["ok"]
    assert not calls


def test_agent_receives_command_output_before_answering(tmp_path, monkeypatch):
    command = python_command("print('verification evidence')")
    replies = iter([json.dumps({"tool": "run_command", "args": {"command": command}}), "Check complete."])
    observed = []

    async def stream(_opts, messages, on_chunk, _thinking, **_kwargs):
        observed.append([dict(message) for message in messages])
        reply = next(replies, "Check complete.")
        on_chunk(reply)
        return reply

    monkeypatch.setattr(agent, "stream_chat_with_retry", stream)
    asyncio.run(agent.run_agent_loop({
        "model": "fake", "workspacePath": str(tmp_path), "autoApply": True,
        "messages": [{"role": "user", "content": "Verify the project"}], "callbacks": {},
    }))
    assert len(observed) >= 2
    assert any("verification evidence" in str(message.get("content", "")) and "Exit code: 0" in str(message.get("content", "")) for message in observed[1])
