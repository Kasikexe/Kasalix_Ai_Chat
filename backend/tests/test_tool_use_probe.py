import asyncio
import json
from datetime import datetime, timedelta, timezone

import pytest

from app import agent, capabilities
from app.routes import models


@pytest.mark.parametrize("calls,expected", [
    ([{"function": {"name": "inspect_file", "arguments": {"path": "src/example.py"}}}], "passed"),
    ([{"function": {"name": "inspect_file", "arguments": '{"path":"src/example.py"}'}}], "passed"),
    ([{"function": {"name": "inspect_file", "arguments": {"path": "wrong"}}}], "failed"),
    ([], "failed"),
])
def test_probe_checks_actual_call_and_persists_it(tmp_path, monkeypatch, calls, expected):
    requests = []

    class Response:
        status_code = 200

        def json(self):
            return {"message": {"tool_calls": calls}}

    class Client:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def post(self, url, **kwargs):
            requests.append((url, kwargs))
            return Response()

    monkeypatch.setattr(capabilities.httpx, "AsyncClient", Client)
    monkeypatch.setattr(capabilities, "_cache_file", lambda: str(tmp_path / "caps.json"))
    monkeypatch.setattr(capabilities, "_tool_use_cache", {})
    monkeypatch.setattr(capabilities, "_caps_cache", {})
    monkeypatch.setattr(capabilities, "_cache_loaded", True)
    result = asyncio.run(capabilities.test_model_tool_use("test-model", "http://local"))
    assert result["status"] == expected
    assert requests[0][1]["json"]["tools"][0]["function"]["name"] == "inspect_file"
    assert asyncio.run(capabilities.get_tool_use_test("test-model", "http://local")) == result
    assert json.loads((tmp_path / "caps.json").read_text())["toolUseChecks"]


def test_failed_result_expires_after_a_week(monkeypatch):
    monkeypatch.setattr(capabilities, "_cache_loaded", True)
    key = capabilities._tool_use_key("m", "http://local")
    monkeypatch.setattr(capabilities, "_tool_use_cache", {key: {"status": "failed", "testedAt": datetime.now(timezone.utc).isoformat()}})
    assert asyncio.run(capabilities.recently_failed_tool_use("m", "http://local"))
    capabilities._tool_use_cache[key]["testedAt"] = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat()
    assert not asyncio.run(capabilities.recently_failed_tool_use("m", "http://local"))


def test_test_endpoint_requires_session(monkeypatch):
    monkeypatch.setattr(models, "session_authenticated", lambda _: False)
    assert asyncio.run(models.tool_test(None)).status_code == 401


def test_failed_probe_prefers_structured_format(tmp_path, monkeypatch):
    async def caps(_model):
        return {"tools": True, "vision": False}

    async def failed(_model, _endpoint=None):
        return True

    formats = []

    async def stream(_model, _messages, on_chunk, options):
        formats.append(options.output_format)
        on_chunk('{"action":"final","message":"Ready."}')

    monkeypatch.setattr(capabilities, "get_model_capabilities", caps)
    monkeypatch.setattr(capabilities, "recently_failed_tool_use", failed)
    monkeypatch.setattr(agent, "stream_chat", stream)
    result = asyncio.run(agent.run_agent_loop({"model": "fake", "workspacePath": str(tmp_path), "autoApply": True,
        "messages": [{"role": "user", "content": "hello"}], "callbacks": {}}))
    assert result == "Ready."
    assert formats[0]["oneOf"]
