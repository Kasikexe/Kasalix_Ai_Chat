import asyncio
import json

from app import agent, capabilities


def test_rejected_structured_format_falls_back_to_text(monkeypatch):
    schemas = agent.native_tool_schemas(agent.AGENT_TOOL_DEFS)
    formats = []

    async def stream(_model, _messages, on_chunk, options):
        formats.append(options.output_format)
        if options.output_format:
            raise agent.OllamaError("Ollama error (400): unsupported JSON schema format")
        on_chunk('{"tool":"read_file","args":{"path":"a.txt"}}')

    monkeypatch.setattr(agent, "stream_chat", stream)
    state = {"mode": "structured"}
    chunks = []
    asyncio.run(agent.stream_chat_with_retry({"model": "fake", "autoApply": True, "toolSchemas": schemas, "protocolState": state}, [], chunks.append, lambda _: None))
    assert state["mode"] == "text"
    assert formats[0] and formats[1] is None
    assert agent.extract_tool_calls("".join(chunks))[0]["tool"] == "read_file"


def test_native_narration_switches_to_structured_and_then_acts(tmp_path, monkeypatch):
    async def caps(_model):
        return {"tools": True, "vision": False}

    async def native(_model, _messages, _tools, on_chunk, _options):
        on_chunk("I will create the file now.")
        return {"content": "I will create the file now.", "toolCalls": []}

    actions = iter([
        {"action": "tool", "tool": "write_file", "args": {"path": "a.txt", "content": "done"}},
        {"action": "final", "message": "Created the file."},
    ])

    async def structured(_model, _messages, on_chunk, options):
        assert options.output_format
        on_chunk(json.dumps(next(actions)))

    monkeypatch.setattr(capabilities, "get_model_capabilities", caps)
    monkeypatch.setattr(agent, "stream_chat_with_tools", native)
    monkeypatch.setattr(agent, "stream_chat", structured)
    asyncio.run(agent.run_agent_loop({"model": "fake", "workspacePath": str(tmp_path), "autoApply": True,
        "messages": [{"role": "user", "content": "create file"}], "callbacks": {}}))
    assert (tmp_path / "a.txt").read_text(encoding="utf-8") == "done"


def test_invalid_structured_output_is_bounded_then_uses_text(tmp_path, monkeypatch):
    async def caps(_model):
        return {"tools": False, "vision": False}

    outputs = iter(["not json", "still invalid", '{"tool":"write_file","args":{"path":"a.txt","content":"done"}}', "Created the file."])
    seen = []

    async def stream(_model, _messages, on_chunk, options):
        seen.append(bool(options.output_format))
        on_chunk(next(outputs))

    monkeypatch.setattr(capabilities, "get_model_capabilities", caps)
    monkeypatch.setattr(agent, "stream_chat", stream)
    asyncio.run(agent.run_agent_loop({"model": "fake", "workspacePath": str(tmp_path), "autoApply": True,
        "messages": [{"role": "user", "content": "create file"}], "callbacks": {}}))
    assert seen == [True, True, False, False]
    assert (tmp_path / "a.txt").read_text(encoding="utf-8") == "done"
