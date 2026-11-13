import asyncio
import json
import os
import re
import shlex
import subprocess
import sys
import urllib.error
import urllib.request

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
    for args in ({"command": "npm run dev", "background": True},
                 {"operation": "status", "process_id": "bg-123", "wait": 2},
                 {"operation": "stop", "process_id": "bg-123"}):
        assert normalize_native_calls([{"function": {"name": "run_command", "arguments": args}}], names)[0]["args"] == args
        action = normalize_structured_action(json.dumps({"action": "tool", "tool": "run_command", "args": args}), names)
        assert action["call"]["args"] == args


@pytest.mark.parametrize("args", [
    {}, {"operation": "status"}, {"operation": "stop", "process_id": "x", "command": "anything"},
    {"operation": "status", "process_id": "x", "wait": 11}, {"command": "test", "timeout": None},
    {"command": "test", "background": "true"}, {"operation": "unknown", "process_id": "x"},
])
def test_invalid_background_arguments_are_rejected(tmp_path, args):
    names = {item["name"] for item in agent.available_tools(True)}
    with pytest.raises(ValueError):
        normalize_native_calls([{"function": {"name": "run_command", "arguments": args}}], names)
    assert not run(tmp_path, args)["ok"]


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


def test_background_start_status_stop_and_run_isolation(tmp_path):
    async def scenario():
        manager = agent.BackgroundCommandManager()
        other = agent.BackgroundCommandManager()
        extra = {"command_manager": manager}

        async def call(args, scope=extra):
            return await agent.execute_tool(str(tmp_path), {"tool": "run_command", "args": args}, True, scope)

        try:
            command = python_command("import time; print('server ready', flush=True); time.sleep(30)")
            started = await call({"command": command, "background": True})
            assert started["ok"]
            process_id = started["process_id"]
            status = await call({"operation": "status", "process_id": process_id, "wait": 5})
            assert status["ok"] and "running" in status["output"] and "server ready" in status["output"]
            assert not (await call({"operation": "status", "process_id": process_id}, {"command_manager": other}))["ok"]
            stopped = await call({"operation": "stop", "process_id": process_id})
            assert stopped["ok"] and "stopped" in stopped["output"]
            assert manager.processes[process_id]["proc"].returncode is not None
        finally:
            await manager.close()
            await other.close()

    asyncio.run(scenario())


def test_background_exit_output_and_timeout(tmp_path):
    async def scenario():
        manager = agent.BackgroundCommandManager()
        try:
            command = python_command("import sys; print('x'*10000); print('error', file=sys.stderr); sys.exit(7)")
            started = await manager.start(command, str(tmp_path), None)
            process_id = started["process_id"]
            await asyncio.wait_for(manager.processes[process_id]["task"], 10)
            result = await manager.status(process_id)
            assert not result["ok"] and "exited with code 7" in result["output"]
            assert "truncated" in result["output"] and "error" in result["output"]
            command = python_command("import time; time.sleep(30)")
            started = await manager.start(command, str(tmp_path), 1)
            process_id = started["process_id"]
            await asyncio.wait_for(manager.processes[process_id]["watchdog"], 10)
            result = await manager.status(process_id)
            assert not result["ok"] and "timed out" in result["output"]
            assert manager.processes[process_id]["proc"].returncode is not None
        finally:
            await manager.close()

    asyncio.run(scenario())


def test_background_server_stays_available_until_stopped(tmp_path):
    async def scenario():
        manager = agent.BackgroundCommandManager()
        try:
            code = (
                "import http.server,socketserver; "
                "s=socketserver.TCPServer(('127.0.0.1',0),http.server.SimpleHTTPRequestHandler); "
                "print('PORT='+str(s.server_address[1]),flush=True); s.serve_forever()"
            )
            started = await manager.start(python_command(code), str(tmp_path), None)
            process_id = started["process_id"]
            status = await manager.status(process_id, 5)
            match = re.search(r"PORT=(\d+)", status["output"])
            assert match and status["ok"]
            with urllib.request.urlopen(f"http://127.0.0.1:{match.group(1)}/", timeout=5) as response:
                assert response.status == 200
            stopped = await manager.stop(process_id)
            assert stopped["ok"] and "stopped" in stopped["output"]
            with pytest.raises(urllib.error.URLError):
                urllib.request.urlopen(f"http://127.0.0.1:{match.group(1)}/", timeout=2)
        finally:
            await manager.close()

    asyncio.run(scenario())


def test_agent_can_start_inspect_and_stop_background_command(tmp_path, monkeypatch):
    command = python_command("import time; print('server ready', flush=True); time.sleep(30)")
    observed = []
    step = 0

    async def stream(_opts, messages, on_chunk, _thinking, **_kwargs):
        nonlocal step
        step += 1
        observed.append([dict(message) for message in messages])
        if step == 1:
            args = {"command": command, "background": True}
        elif step in (2, 3):
            content = "\n".join(str(message.get("content", "")) for message in messages)
            process_id = re.search(r"bg-[0-9a-f]{16}", content).group(0)
            args = {"operation": "status" if step == 2 else "stop", "process_id": process_id}
            if step == 2:
                args["wait"] = 5
        else:
            on_chunk("The process has been inspected.")
            return "The process has been inspected."
        reply = json.dumps({"tool": "run_command", "args": args})
        on_chunk(reply)
        return reply

    monkeypatch.setattr(agent, "stream_chat_with_retry", stream)
    asyncio.run(agent.run_agent_loop({
        "model": "fake", "workspacePath": str(tmp_path), "autoApply": True,
        "messages": [{"role": "user", "content": "Inspect the server"}], "callbacks": {},
    }))
    assert len(observed) >= 4
    assert "server ready" in str(observed[2])
    assert "stopped" in str(observed[3])


@pytest.mark.parametrize("cancel", [False, True])
def test_agent_run_cleans_up_background_processes(tmp_path, monkeypatch, cancel):
    managers = []
    manager_type = agent.BackgroundCommandManager

    class TrackingManager(manager_type):
        def __init__(self):
            super().__init__()
            managers.append(self)

    command = python_command("import time; time.sleep(30)")
    calls = 0

    async def stream(_opts, _messages, on_chunk, _thinking, **_kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            reply = json.dumps({"tool": "run_command", "args": {"command": command, "background": True}})
        elif cancel:
            raise asyncio.CancelledError()
        else:
            reply = "The server status is available."
        on_chunk(reply)
        return reply

    monkeypatch.setattr(agent, "BackgroundCommandManager", TrackingManager)
    monkeypatch.setattr(agent, "stream_chat_with_retry", stream)
    opts = {"model": "fake", "workspacePath": str(tmp_path), "autoApply": True,
            "messages": [{"role": "user", "content": "Start the server"}], "callbacks": {}}
    if cancel:
        with pytest.raises(asyncio.CancelledError):
            asyncio.run(agent.run_agent_loop(opts))
    else:
        asyncio.run(agent.run_agent_loop(opts))
    assert len(managers) == 1 and len(managers[0].processes) == 1
    assert next(iter(managers[0].processes.values()))["proc"].returncode is not None
