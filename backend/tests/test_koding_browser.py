import asyncio
import json

import pytest

from app import agent
from app.agent_protocol import native_tool_schemas, normalize_native_calls, normalize_structured_action


def test_browser_schema_supports_all_call_formats():
    names = {tool["name"] for tool in agent.available_tools(True)}
    assert "browser" in {tool["function"]["name"] for tool in native_tool_schemas(agent.available_tools(True))}
    args = {"operation": "type", "selector": "#name", "text": "hello"}
    assert normalize_native_calls([{"function": {"name": "browser", "arguments": args}}], names)[0]["args"] == args
    assert normalize_structured_action(json.dumps({"action": "tool", "tool": "browser", "args": args}), names)["call"]["args"] == args
    assert agent.extract_tool_calls(json.dumps({"tool": "browser", "args": args}))[0]["args"] == args


@pytest.mark.parametrize("args", [
    {}, {"operation": "open"}, {"operation": "click", "selector": ""},
    {"operation": "type", "selector": "#x"}, {"operation": "eval", "text": "alert(1)"},
    {"operation": "inspect", "url": "http://localhost"},
])
def test_invalid_browser_actions_are_rejected(tmp_path, args):
    names = {tool["name"] for tool in agent.available_tools(True)}
    with pytest.raises(ValueError):
        normalize_native_calls([{"function": {"name": "browser", "arguments": args}}], names)
    result = asyncio.run(agent.execute_tool(str(tmp_path), {"tool": "browser", "args": args}, True))
    assert not result["ok"]


@pytest.mark.parametrize("url", ["https://example.com", "file:///etc/passwd", "http://localhost@evil.test", "http://@localhost", "http://127.0.0.1:99999"])
def test_browser_rejects_nonlocal_or_invalid_urls(tmp_path, url):
    result = asyncio.run(agent.execute_tool(str(tmp_path), {"tool": "browser", "args": {"operation": "open", "url": url}}, True))
    assert not result["ok"]


def test_browser_action_is_scoped_to_user_and_returns_result(tmp_path):
    async def scenario():
        seen = []
        def callback(request):
            seen.append(request)
            assert not agent.resolve_browser_action(request["key"], "other-user", {"ok": True, "output": "wrong"})
            assert agent.resolve_browser_action(request["key"], "owner", {"ok": True, "output": "page opened"})
        result = await agent.execute_tool(str(tmp_path), {"tool": "browser", "args": {"operation": "open", "url": "http://localhost:3000"}}, True,
            {"callbacks": {"onBrowserAction": callback}, "userId": "owner", "browserSession": "session", "conversationId": "chat"})
        assert result == {"ok": True, "output": "page opened"}
        assert seen[0]["conversationId"] == "chat" and seen[0]["sessionId"] == "session"
        assert not agent.resolve_browser_action(seen[0]["key"], "owner", {"ok": True})
    asyncio.run(scenario())


@pytest.mark.parametrize("vision", [True, False])
def test_screenshot_only_attaches_image_for_vision_models(tmp_path, vision):
    async def scenario():
        def callback(request):
            agent.resolve_browser_action(request["key"], "owner", {"ok": True, "output": "Captured.", "imageData": "data:image/jpeg;base64,YQ=="})
        result = await agent.execute_tool(str(tmp_path), {"tool": "browser", "args": {"operation": "screenshot"}}, True,
            {"callbacks": {"onBrowserAction": callback}, "userId": "owner", "browserSession": "session", "use_vision_model": vision})
        assert result["ok"] and ("imageData" in result) is vision
        if not vision:
            assert "cannot inspect" in result["output"]
    asyncio.run(scenario())


def test_cancelled_browser_action_is_removed(tmp_path):
    async def scenario():
        seen = []
        stop = asyncio.Event()
        task = asyncio.create_task(agent.execute_tool(str(tmp_path), {"tool": "browser", "args": {"operation": "inspect"}}, True,
            {"callbacks": {"onBrowserAction": seen.append}, "userId": "owner", "browserSession": "session", "signal": stop}))
        await asyncio.sleep(0)
        stop.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not agent.resolve_browser_action(seen[0]["key"], "owner", {"ok": True})
    asyncio.run(scenario())


def test_agent_waits_for_browser_result_before_continuing(tmp_path, monkeypatch):
    messages_seen = []
    replies = iter([json.dumps({"tool": "browser", "args": {"operation": "inspect"}}), "The page contains the login form."])

    async def stream(_opts, messages, on_chunk, _thinking, **_kwargs):
        messages_seen.append([dict(message) for message in messages])
        reply = next(replies, "The page contains the login form.")
        on_chunk(reply)
        return reply

    def browser_action(request):
        assert request["args"]["operation"] == "inspect"
        agent.resolve_browser_action(request["key"], "owner", {"ok": True, "output": "Login form found"})

    monkeypatch.setattr(agent, "stream_chat_with_retry", stream)
    asyncio.run(agent.run_agent_loop({"model": "fake", "workspacePath": str(tmp_path), "autoApply": True,
        "userId": "owner", "conversationId": "chat", "messages": [{"role": "user", "content": "Inspect the page"}],
        "callbacks": {"onBrowserAction": browser_action}}))
    assert len(messages_seen) >= 2
    assert any("Login form found" in str(message.get("content", "")) for message in messages_seen[1])
