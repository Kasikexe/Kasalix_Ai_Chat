import asyncio
import json

from app import agent, capabilities, ollama_client


def test_workspace_action_settings_are_bounded(tmp_path):
    assert agent.action_limits(str(tmp_path)) == (180.0, 2)
    (tmp_path / ".agent-config.json").write_text(json.dumps({"actionTimeoutSeconds": 20, "actionRetryLimit": 3}))
    assert agent.action_limits(str(tmp_path)) == (20, 3)
    (tmp_path / ".agent-config.json").write_text(json.dumps({"actionTimeoutSeconds": 99999, "actionRetryLimit": 99}))
    assert agent.action_limits(str(tmp_path)) == (1800, 4)


def test_stalled_action_is_cancelled_without_executing(tmp_path, monkeypatch):
    cancelled = []
    stages = []

    async def caps(_model):
        return {"tools": False, "vision": False}

    async def stalled(*args, **kwargs):
        try:
            await asyncio.sleep(30)
        finally:
            cancelled.append(True)

    monkeypatch.setattr(capabilities, "get_model_capabilities", caps)
    monkeypatch.setattr(agent, "action_limits", lambda _: (0.01, 2))
    monkeypatch.setattr(agent, "stream_chat_with_retry", stalled)
    result = asyncio.run(agent.run_agent_loop({"model": "fake", "workspacePath": str(tmp_path), "autoApply": True,
        "messages": [{"role": "user", "content": "create a file"}], "callbacks": {"onStage": stages.append}}))
    assert "stopped waiting" in result
    assert cancelled == [True]
    assert "agent:done" in stages
    assert list(tmp_path.iterdir()) == []


def test_invalid_actions_stop_after_configured_retries(tmp_path, monkeypatch):
    stages = []
    calls = []

    async def caps(_model):
        return {"tools": False, "vision": False}

    async def invalid(_opts, _messages, on_chunk, _thinking):
        calls.append(1)
        on_chunk("[INVALID STRUCTURED ACTION] missing action")

    monkeypatch.setattr(capabilities, "get_model_capabilities", caps)
    monkeypatch.setattr(agent, "action_limits", lambda _: (30, 1))
    monkeypatch.setattr(agent, "stream_chat_with_retry", invalid)
    result = asyncio.run(agent.run_agent_loop({"model": "fake", "workspacePath": str(tmp_path), "autoApply": True,
        "messages": [{"role": "user", "content": "create a file"}], "callbacks": {"onStage": stages.append}}))
    assert "repeatedly failed" in result
    assert len(calls) == 2
    assert "agent:retry" in stages


def test_thinking_and_tool_call_in_same_chunk_are_both_delivered(monkeypatch):
    class Response:
        status_code = 200

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def aiter_text(self):
            yield json.dumps({"message": {"thinking": "Checking", "tool_calls": [{"function": {"name": "read_file", "arguments": {"path": "a"}}}]}, "done": True}) + "\n"

    class Client:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        def stream(self, *args, **kwargs):
            return Response()

    monkeypatch.setattr(ollama_client.httpx, "AsyncClient", Client)
    thinking = []
    _, calls, _ = asyncio.run(ollama_client._stream_response("http://example", {}, ollama_client.StreamOptions(on_thinking=thinking.append), "test", None, True))
    assert thinking == ["Checking"]
    assert calls[0]["function"]["name"] == "read_file"
