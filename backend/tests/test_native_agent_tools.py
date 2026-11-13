import asyncio

import pytest

from app import agent, capabilities
from app.agent_protocol import TOOL_ARGUMENTS, native_tool_schemas, normalize_native_calls


def test_all_registered_tools_have_schemas():
    assert {item["name"] for item in agent.AGENT_TOOL_DEFS} == set(TOOL_ARGUMENTS)


def test_rejects_invalid_or_unavailable_native_calls():
    schemas = native_tool_schemas(agent.AGENT_TOOL_DEFS)
    permitted = {s["function"]["name"] for s in schemas}
    with pytest.raises(ValueError):
        normalize_native_calls([{"function": {"name": "write_file", "arguments": {"path": "x"}}}], permitted)
    with pytest.raises(ValueError):
        normalize_native_calls([{"function": {"name": "unknown", "arguments": {}}}], permitted)
    assert normalize_native_calls([{"function": {"name": "read_file", "arguments": '{"path":"x"}'}}], permitted) == [{"tool": "read_file", "args": {"path": "x"}}]


def test_native_call_executes_and_tool_result_returns_to_model(tmp_path, monkeypatch):
    (tmp_path / "input.txt").write_text("hello", encoding="utf-8")
    history = []
    responses = iter([
        {"content": "", "toolCalls": [{"function": {"name": "read_file", "arguments": {"path": "input.txt"}}}]},
        {"content": "", "toolCalls": [{"function": {"name": "write_file", "arguments": {"path": "out.txt", "content": "done"}}}]},
        {"content": "Finished the requested work.", "toolCalls": []},
    ])

    async def caps(_model):
        return {"tools": True, "vision": False}

    async def model(_model, messages, tools, on_chunk, _options):
        history.append(messages)
        assert tools and tools[0]["function"]["parameters"]["type"] == "object"
        response = next(responses)
        if response["content"]:
            on_chunk(response["content"])
        return response

    monkeypatch.setattr(capabilities, "get_model_capabilities", caps)
    monkeypatch.setattr(agent, "stream_chat_with_tools", model)
    result = asyncio.run(agent.run_agent_loop({"model": "fake", "workspacePath": str(tmp_path), "autoApply": True,
        "messages": [{"role": "user", "content": "create the output"}], "callbacks": {}}))
    assert (tmp_path / "out.txt").read_text(encoding="utf-8") == "done"
    assert "Finished" in result
    assert any(m.get("role") == "tool" and m.get("tool_name") == "read_file" and "hello" in m.get("content", "") for m in history[1])


def test_native_denied_write_does_not_execute(tmp_path, monkeypatch):
    responses = iter([
        {"content": "", "toolCalls": [{"function": {"name": "write_file", "arguments": {"path": "out.txt", "content": "unsafe"}}}]},
        {"content": "I could not write in read-only mode.", "toolCalls": []},
    ])

    async def caps(_model):
        return {"tools": True, "vision": False}

    async def model(_model, _messages, _tools, on_chunk, _options):
        response = next(responses, {"content": "I could not write.", "toolCalls": []})
        on_chunk(response["content"])
        return response

    monkeypatch.setattr(capabilities, "get_model_capabilities", caps)
    monkeypatch.setattr(agent, "stream_chat_with_tools", model)
    asyncio.run(agent.run_agent_loop({"model": "fake", "workspacePath": str(tmp_path), "autoApply": True, "toolPermission": "read-only",
        "messages": [{"role": "user", "content": "create a file"}], "callbacks": {}}))
    assert not (tmp_path / "out.txt").exists()
