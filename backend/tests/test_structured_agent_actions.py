import asyncio
import json

import pytest

from app import agent, capabilities
from app.agent_protocol import normalize_structured_action, structured_action_schema


def test_structured_actions_are_validated():
    permitted = {"read_file", "ask_user"}
    assert normalize_structured_action('{"action":"tool","tool":"read_file","args":{"path":"x"}}', permitted)["call"]["tool"] == "read_file"
    assert normalize_structured_action('{"action":"question","question":"Which file?"}', permitted)["call"]["tool"] == "ask_user"
    assert normalize_structured_action('{"action":"final","message":"Hello"}', permitted)["message"] == "Hello"
    assert len(structured_action_schema(permitted)["oneOf"]) == 3
    assert "path" in structured_action_schema(permitted)["oneOf"][0]["properties"]["args"]["properties"]
    for invalid in ('{"action":"tool","tool":"read_file","args":{}}', '{"action":"tool","tool":"write_file","args":{}}', '{"action":"final","message":""}', 'not json'):
        with pytest.raises(ValueError):
            normalize_structured_action(invalid, permitted)


def test_non_native_model_uses_schema_and_final_prose_is_not_executed(tmp_path, monkeypatch):
    (tmp_path / "input.txt").write_text("data", encoding="utf-8")
    responses = iter([
        {"action": "tool", "tool": "read_file", "args": {"path": "input.txt"}},
        {"action": "final", "message": 'The file contains data. Example: {"tool":"write_file","args":{"path":"bad.txt","content":"bad"}}'},
    ])
    formats = []

    async def caps(_model):
        return {"tools": False, "vision": False}

    async def stream(_model, _messages, on_chunk, options):
        formats.append(options.output_format)
        on_chunk(json.dumps(next(responses)))

    monkeypatch.setattr(capabilities, "get_model_capabilities", caps)
    monkeypatch.setattr(agent, "stream_chat", stream)
    result = asyncio.run(agent.run_agent_loop({"model": "fake", "workspacePath": str(tmp_path), "autoApply": True,
        "messages": [{"role": "user", "content": "inspect input"}], "callbacks": {}}))
    assert "contains data" in result
    assert all(fmt and "oneOf" in fmt for fmt in formats)
    assert not (tmp_path / "bad.txt").exists()
