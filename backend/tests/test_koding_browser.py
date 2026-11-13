import asyncio
import json

import httpx
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
    {}, {"operation": "open", "url": "", "path": "index.html"}, {"operation": "click", "selector": ""},
    {"operation": "type", "selector": "#x"}, {"operation": "eval", "text": "alert(1)"},
    {"operation": "inspect", "url": "http://localhost"},
])
def test_invalid_browser_actions_are_rejected(tmp_path, args):
    names = {tool["name"] for tool in agent.available_tools(True)}
    with pytest.raises(ValueError):
        normalize_native_calls([{"function": {"name": "browser", "arguments": args}}], names)
    result = asyncio.run(agent.execute_tool(str(tmp_path), {"tool": "browser", "args": args}, True))
    assert not result["ok"]


def test_browser_validation_names_unexpected_arguments():
    names = {tool["name"] for tool in agent.available_tools(True)}
    with pytest.raises(ValueError, match="inspect does not accept url"):
        normalize_native_calls([{"function": {"name": "browser", "arguments": {"operation": "inspect", "url": "http://localhost"}}}], names)


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


def test_browser_requires_inspection_before_each_click(tmp_path):
    async def scenario():
        requests = []
        evidence = {"inspected": False, "needs_observation": False, "used": False, "closed_unverified": False, "failed_interaction": False}
        def callback(request):
            requests.append(request["args"]["operation"])
            agent.resolve_browser_action(request["key"], "owner", {"ok": True, "output": "Action completed"})
        context = {"callbacks": {"onBrowserAction": callback}, "userId": "owner", "browserSession": "session", "browser_evidence": evidence}
        async def call(args):
            return await agent.execute_tool(str(tmp_path), {"tool": "browser", "args": args}, True, context)
        assert not (await call({"operation": "click", "selector": "#button"}))["ok"]
        assert requests == []
        assert (await call({"operation": "inspect"}))["ok"]
        assert (await call({"operation": "click", "selector": "#button"}))["ok"]
        assert evidence["needs_observation"]
        assert not (await call({"operation": "click", "selector": "#button"}))["ok"]
        assert requests == ["inspect", "click"]
    asyncio.run(scenario())


@pytest.mark.parametrize("inspect", [True, False])
def test_agent_does_not_claim_browser_was_verified_without_observing_it(tmp_path, monkeypatch, inspect):
    calls = []
    replies = [json.dumps({"tool": "browser", "args": {"operation": "open", "url": "http://localhost:3000"}}), "Everything works perfectly."]
    if inspect:
        replies.extend([json.dumps({"tool": "browser", "args": {"operation": "inspect"}}), "The page contains a login form."])
    else:
        replies.extend(["Everything works perfectly.", "Everything works perfectly."])
    replies = iter(replies)

    async def stream(_opts, _messages, on_chunk, _thinking, **_kwargs):
        reply = next(replies, "Everything works perfectly.")
        on_chunk(reply)
        return reply

    def callback(request):
        calls.append(request["args"]["operation"])
        agent.resolve_browser_action(request["key"], "owner", {"ok": True, "output": "Observed page"})

    monkeypatch.setattr(agent, "stream_chat_with_retry", stream)
    answer = asyncio.run(agent.run_agent_loop({"model": "fake", "workspacePath": str(tmp_path), "autoApply": True,
        "userId": "owner", "messages": [{"role": "user", "content": "Open the page"}], "callbacks": {"onBrowserAction": callback}}))
    if inspect:
        assert calls == ["open", "inspect"] and "login form" in answer
    else:
        assert calls == ["open"] and "could not verify" in answer.lower()
        assert "works perfectly" not in answer


def test_agent_does_not_claim_failed_page_open_succeeded(tmp_path, monkeypatch):
    replies = iter([json.dumps({"tool": "browser", "args": {"operation": "open", "url": "http://localhost:3000"}}),
                    "The page opened and works."])

    async def stream(_opts, _messages, on_chunk, _thinking, **_kwargs):
        reply = next(replies, "The page opened and works.")
        on_chunk(reply)
        return reply

    def callback(request):
        agent.resolve_browser_action(request["key"], "owner", {"ok": False, "error": "connection refused"})

    monkeypatch.setattr(agent, "stream_chat_with_retry", stream)
    answer = asyncio.run(agent.run_agent_loop({"model": "fake", "workspacePath": str(tmp_path), "autoApply": True,
        "userId": "owner", "messages": [{"role": "user", "content": "Open the page"}], "callbacks": {"onBrowserAction": callback}}))
    assert "could not open" in answer.lower() and "opened and works" not in answer


def test_static_html_preview_is_started_and_survives_follow_up(tmp_path):
    (tmp_path / "index.html").write_text("<h1>Test1</h1>", encoding="utf-8")
    (tmp_path / "styles.css").write_text("body { color: red; }", encoding="utf-8")
    (tmp_path / ".env").write_text("secret", encoding="utf-8")
    (tmp_path / "AGENT_RULES.md").write_text("private", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "secret.txt").write_text("private", encoding="utf-8")

    async def scenario():
        key, resources = await agent.acquire_conversation_resources("owner", "static-chat", str(tmp_path))
        seen = []
        def callback(request):
            seen.append(request)
            agent.resolve_browser_action(request["key"], "owner", {"ok": True, "output": "Opened."})
        context = {"callbacks": {"onBrowserAction": callback}, "userId": "owner", "browserSession": resources["browser_session"],
                   "browser_state": resources["browser"], "resources": resources}
        try:
            result = await agent.execute_tool(str(tmp_path), {"tool": "browser", "args": {"operation": "open", "path": "index.html"}}, True, context)
            assert result["ok"] and seen[0]["args"]["url"].startswith("http://127.0.0.1:")
            url = resources["browser"]["url"]
            async with httpx.AsyncClient(trust_env=False) as client:
                assert "Test1" in (await client.get(url)).text
                base = url.rsplit("/", 1)[0]
                assert (await client.get(base + "/styles.css")).status_code == 200
                for forbidden in ("/.env", "/AGENT_RULES.md", "/node_modules/secret.txt", "/%2e%2e/secret.txt"):
                    assert (await client.get(base + forbidden)).status_code == 403
                await agent.release_conversation_resources(key, resources)
                again_key, again = await agent.acquire_conversation_resources("owner", "static-chat", str(tmp_path))
                assert again is resources and (await client.get(url)).status_code == 200
                await agent.release_conversation_resources(again_key, again)
        finally:
            await agent.close_conversation_resources("owner", "static-chat")
    asyncio.run(scenario())


def test_static_preview_stops_if_client_cannot_open(tmp_path):
    (tmp_path / "index.html").write_text("hello", encoding="utf-8")
    async def scenario():
        key, resources = await agent.acquire_conversation_resources("owner", "failed-static", str(tmp_path))
        urls = []
        def callback(request):
            urls.append(request["args"]["url"])
            agent.resolve_browser_action(request["key"], "owner", {"ok": False, "error": "client unavailable"})
        context = {"callbacks": {"onBrowserAction": callback}, "userId": "owner", "browserSession": resources["browser_session"],
                   "browser_state": resources["browser"], "resources": resources}
        result = await agent.execute_tool(str(tmp_path), {"tool": "browser", "args": {"operation": "open"}}, True, context)
        assert not result["ok"] and resources["preview"] is None
        async with httpx.AsyncClient(trust_env=False) as client:
            with pytest.raises(httpx.ConnectError):
                await client.get(urls[0])
        await agent.release_conversation_resources(key, resources)
    asyncio.run(scenario())


def test_automatic_static_preview_refuses_ambiguous_or_outside_paths(tmp_path):
    for directory in ("one", "two"):
        (tmp_path / directory).mkdir()
        (tmp_path / directory / "index.html").write_text("hello", encoding="utf-8")
    async def scenario():
        key, resources = await agent.acquire_conversation_resources("owner", "ambiguous", str(tmp_path))
        context = {"resources": resources}
        try:
            result = await agent.execute_tool(str(tmp_path), {"tool": "browser", "args": {"operation": "open"}}, True, context)
            assert not result["ok"] and "Multiple" in result["output"]
            result = await agent.execute_tool(str(tmp_path), {"tool": "browser", "args": {"operation": "open", "path": "../index.html"}}, True, context)
            assert not result["ok"]
        finally:
            await agent.release_conversation_resources(key, resources)
    asyncio.run(scenario())
