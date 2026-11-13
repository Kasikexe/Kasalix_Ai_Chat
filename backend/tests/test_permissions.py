"""Permission decisions must filter calls before they reach the executor."""

import asyncio

from app import agent


class Log:
    async def log_tool_result(self, *args):
        pass


def call(name):
    return {"tool": name, "args": {}}


def test_read_only_blocks_every_mutation_and_code_execution():
    calls = [call(name) for name in sorted(agent.MUTATING_TOOLS | agent.EXECUTION_TOOLS)]
    calls.append(call("read_file"))
    allowed, feedback = asyncio.run(agent.authorize_tool_calls(calls, {"toolPermission": "read-only"}, None, Log()))
    assert allowed == [call("read_file")]
    assert len(feedback) == len(calls) - 1


def test_ask_each_executes_only_approved_calls(monkeypatch):
    answers = iter([False, True, False])

    async def approve(*args):
        return next(answers)

    monkeypatch.setattr(agent, "wait_for_approval", approve)
    calls = [call("write_file"), call("read_file"), call("run_command")]
    allowed, feedback = asyncio.run(agent.authorize_tool_calls(calls, {"toolPermission": "ask-each"}, None, Log()))
    assert allowed == [call("read_file")]
    assert len(feedback) == 2


def test_auto_edit_requires_approval_for_commands(monkeypatch):
    async def deny(*args):
        return False

    monkeypatch.setattr(agent, "wait_for_approval", deny)
    calls = [call("edit_file"), call("run_python"), call("preview_eval")]
    allowed, feedback = asyncio.run(agent.authorize_tool_calls(calls, {"toolPermission": "auto-edit"}, None, Log()))
    assert allowed == [call("edit_file")]
    assert len(feedback) == 2
