"""API smoke tests — exercise the FastAPI app with an isolated DATA_DIR.

These tests spin up the real ASGI app (same code the server runs) against a
temporary data directory so nothing touches real user data. Ollama-dependent
routes (models, chat) are not asserted on content — only that they respond
with the expected status/shape.
"""

import os
import tempfile

import pytest
from fastapi.testclient import TestClient

# Point the app at a temp data dir BEFORE importing the app module.
_TMP = tempfile.mkdtemp(prefix="kasalix-test-")
os.environ["DATA_DIR"] = _TMP
os.environ["OLLAMA_URL"] = "http://127.0.0.1:9"  # unreachable — no accidental Ollama use

from app.main import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def auth(client):
    """Register + login a test user; returns (token, user_id)."""
    r = client.post("/api/auth/register", json={"username": "apitest", "password": "secret123"})
    assert r.status_code == 201, r.text  # TS backend also returns 201
    data = r.json()
    return data["token"], data["user"]["id"]


def _h(token, user_id=None):
    headers = {"Authorization": f"Bearer {token}"}
    if user_id:
        headers["X-User-Id"] = user_id
    return headers


def test_release_repository_defaults_and_overrides(monkeypatch):
    from app.config import github_releases_url

    monkeypatch.delenv("GITHUB_RELEASES_URL", raising=False)
    monkeypatch.delenv("GITHUB_RELEASE_REPO", raising=False)
    monkeypatch.delenv("GITHUB_REPO", raising=False)
    assert github_releases_url() == "https://github.com/Kasikexe/Kasalix_Ai_Chat/releases"
    monkeypatch.setenv("GITHUB_REPO", "fork/shared")
    assert github_releases_url() == "https://github.com/fork/shared/releases"
    monkeypatch.setenv("GITHUB_RELEASE_REPO", "fork/releases")
    assert github_releases_url() == "https://github.com/fork/releases/releases"
    monkeypatch.setenv("GITHUB_RELEASES_URL", "https://example.test/releases")
    assert github_releases_url() == "https://example.test/releases"


def test_download_fallback_points_to_release_repository(client, monkeypatch, tmp_path):
    import app.main as main

    monkeypatch.setattr(main, "RELEASE_DIR", tmp_path)
    release_url = "https://github.com/Kasikexe/Kasalix_Ai_Chat/releases"
    assert release_url in client.get("/download").text
    for platform in ("desktop", "android"):
        response = client.get(f"/download/{platform}", follow_redirects=False)
        assert response.status_code == 307
        assert response.headers["location"] == release_url


def test_ui_plugin_modes_are_available_and_saved_with_conversations(client, auth, tmp_path, monkeypatch):
    import json
    import app.routes.chat as chat_route
    from app.services.plugins import manager

    folder = tmp_path / "plugin"
    folder.mkdir()
    (folder / "plugin.json").write_text(json.dumps({"id": "sample-ui", "name": "Sample", "version": "1", "kind": "ui",
        "modes": [{"id": "sample", "name": "Sample", "baseMode": "chat", "welcome": {"title": "Hello", "items": [
            {"id": "first", "label": "First", "message": "Hello", "instructions": "Be thoughtful and concise."},
            {"id": "second", "label": "Second", "message": "Hello", "instructions": "Be energetic."}]}}]}), encoding="utf-8")
    monkeypatch.setattr(manager, "get_data_dir", lambda: tmp_path / "plugin-data")
    assert client.post("/api/plugins/install-local-ui", json={"path": str(folder)}).status_code == 403
    local_client = TestClient(app, client=("127.0.0.1", 50000))
    installed = local_client.post("/api/plugins/install-local-ui", json={"path": str(folder)})
    assert installed.status_code == 200, installed.text
    assert "localPath" not in client.get("/api/plugins").json()["plugins"][0]
    assert local_client.get("/api/plugins").json()["plugins"][0]["localPath"] == str(folder)
    mode_id = "plugin:sample-ui:sample"
    assert any(m["id"] == mode_id for m in client.get("/api/plugins/modes").json()["modes"])
    token, _ = auth
    headers = {"Authorization": f"Bearer {token}"}
    created = client.post("/api/conversations", headers=headers, json={"model": "fake", "mode": "chat", "pluginModeId": mode_id})
    assert created.status_code == 200 and created.json()["conversation"]["pluginModeId"] == mode_id
    assert client.post("/api/conversations", headers=headers, json={"model": "fake", "mode": "agent", "pluginModeId": mode_id}).status_code == 400

    seen_messages = []
    async def fake_pipeline(opts):
        seen_messages.append(opts["messages"])
        opts["onChunk"]("Done")
        return "Done"
    monkeypatch.setattr(chat_route, "run_pipeline", fake_pipeline)
    streamed = client.post("/api/chat", headers=headers, json={"model": "fake", "mode": "chat", "pluginModeId": mode_id, "pluginItemId": "first",
        "messages": [{"role": "user", "content": "Hello"}]})
    events = [json.loads(line[6:]) for line in streamed.text.splitlines() if line.startswith("data: ")]
    conversation_id = next(event["conversationId"] for event in events if event.get("type") == "conversationId")
    saved = client.get(f"/api/conversations/{conversation_id}", headers=headers).json()["conversation"]
    assert saved["pluginModeId"] == mode_id and saved["pluginSelection"]["id"] == "first"
    assert seen_messages[-1][0]["role"] == "system" and "Be thoughtful and concise." in seen_messages[-1][0]["content"]
    continued = client.post("/api/chat", headers=headers, json={"model": "fake", "mode": "chat", "conversationId": conversation_id,
        "messages": [{"role": "user", "content": "What next?"}]})
    assert continued.status_code == 200 and "Be thoughtful and concise." in seen_messages[-1][0]["content"]
    assert client.post("/api/chat", headers=headers, json={"model": "fake", "conversationId": conversation_id, "pluginItemId": "second",
        "messages": [{"role": "user", "content": "Switch"}]}).status_code == 409
    assert client.post("/api/plugins/sample-ui/toggle", json={"enabled": False}).status_code == 403
    assert local_client.post("/api/plugins/sample-ui/toggle", headers={"Origin": "https://example.invalid"}, json={"enabled": False}).status_code == 403
    assert local_client.post("/api/plugins/sample-ui/toggle", json={"enabled": False}).status_code == 200
    assert client.get("/api/plugins/modes").json()["modes"] == []
    assert client.post("/api/conversations", headers=headers, json={"model": "fake", "pluginModeId": mode_id}).status_code == 400


@pytest.mark.parametrize("path,body", [
    ("/api/plugins/install", {"repo": "owner/repo"}),
    ("/api/plugins/install-local-ui", {"path": "x"}),
    ("/api/plugins/sample/toggle", {"enabled": True}),
    ("/api/plugins/sample/update", {}),
    ("/api/plugins/sample/uninstall", {}),
])
def test_plugin_management_rejects_remote_and_browser_origin(client, path, body):
    assert client.post(path, json=body).status_code == 403
    local = TestClient(app, client=("127.0.0.1", 50000))
    assert local.post(path, headers={"Origin": "https://example.invalid"}, json=body).status_code == 403


def test_plugin_memory_is_isolated_by_user_and_selection_and_respects_settings(client, tmp_path, monkeypatch):
    import json
    import app.routes.chat as chat_route
    from app import memory as memory_module
    from app.services.plugins import manager

    folder = tmp_path / "plugin"
    folder.mkdir()
    (folder / "plugin.json").write_text(json.dumps({"id": "memory-test", "name": "Memory Test", "version": "1", "kind": "ui",
        "modes": [{"id": "sample", "name": "Sample", "baseMode": "chat", "memory": "per-item", "welcome": {"title": "Choose", "items": [
            {"id": "first", "label": "First", "message": "Hello", "instructions": "Be calm."},
            {"id": "second", "label": "Second", "message": "Hello", "instructions": "Be energetic."}]}}]}), encoding="utf-8")
    monkeypatch.setattr(manager, "get_data_dir", lambda: tmp_path / "plugins-data")
    monkeypatch.setattr(memory_module, "get_data_dir", lambda: tmp_path / "memory-data")
    local = TestClient(app, client=("127.0.0.1", 50000))
    assert local.post("/api/plugins/install-local-ui", json={"path": str(folder)}).status_code == 200
    tokens = []
    for name in ("pluginmemoryone", "pluginmemorytwo"):
        response = client.post("/api/auth/register", json={"username": name, "password": "secret123"})
        tokens.append(response.json()["token"])
    headers = [{"Authorization": f"Bearer {token}"} for token in tokens]
    for header in headers:
        assert client.put("/api/memory", headers=header, json={"enabled": True}).status_code == 200

    seen = []
    async def fake_pipeline(opts):
        seen.append(opts)
        opts["onChunk"]("Done")
        return "Done"
    async def fake_extract(*_args):
        return None
    monkeypatch.setattr(chat_route, "run_pipeline", fake_pipeline)
    monkeypatch.setattr(chat_route, "extract_memory_from_turn", fake_extract)
    mode_id = "plugin:memory-test:sample"

    def start(header, item):
        response = client.post("/api/chat", headers=header, json={"model": "fake", "mode": "chat", "pluginModeId": mode_id, "pluginItemId": item,
            "messages": [{"role": "user", "content": "Hello"}]})
        assert response.status_code == 200, response.text
        events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")]
        return next(event["conversationId"] for event in events if event.get("type") == "conversationId"), seen[-1]["memoryUserId"]

    first_conv, first_scope = start(headers[0], "first")
    fork = client.post("/api/conversations", headers=headers[0], json={"model": "fake", "mode": "chat",
        "pluginModeId": mode_id, "pluginItemId": "first"})
    assert fork.status_code == 200 and fork.json()["conversation"]["pluginSelection"]["memory"] == "per-item"
    assert client.post("/api/conversations", headers=headers[0], json={"model": "fake", "pluginItemId": "first"}).status_code == 400
    _, same_scope = start(headers[0], "first")
    second_conv, second_scope = start(headers[0], "second")
    other_conv, other_user_scope = start(headers[1], "first")
    assert first_scope == same_scope
    assert len({first_scope, second_scope, other_user_scope}) == 3
    import asyncio
    asyncio.run(memory_module.update_memory(first_scope, {"categories": {"Details": {"color": "blue"}}}))
    asyncio.run(memory_module.update_memory(second_scope, {"categories": {"Details": {"color": "green"}}}))
    asyncio.run(memory_module.update_memory(other_user_scope, {"categories": {"Details": {"color": "gold"}}}))
    memory_module._memory_cache.pop(first_scope, None)  # Re-read persisted data from disk.
    first = client.get("/api/memory/plugin", headers=headers[0], params={"conversationId": first_conv}).json()
    second = client.get("/api/memory/plugin", headers=headers[0], params={"conversationId": second_conv}).json()
    assert first["categories"]["Details"]["color"] == "blue" and second["categories"]["Details"]["color"] == "green"
    assert client.get("/api/memory/plugin", headers=headers[1], params={"conversationId": first_conv}).status_code == 404
    assert client.delete("/api/memory/plugin", headers=headers[1], params={"conversationId": first_conv}).status_code == 404
    assert client.delete("/api/memory/plugin", headers=headers[0], params={"conversationId": first_conv}).status_code == 200
    assert client.get("/api/memory/plugin", headers=headers[0], params={"conversationId": first_conv}).json()["categories"] == {}
    assert client.get("/api/memory/plugin", headers=headers[0], params={"conversationId": second_conv}).json()["categories"]["Details"]["color"] == "green"
    assert client.put("/api/memory", headers=headers[0], json={"enabled": False}).status_code == 200
    continued = client.post("/api/chat", headers=headers[0], json={"model": "fake", "conversationId": first_conv,
        "messages": [{"role": "user", "content": "Continue"}]})
    assert continued.status_code == 200 and seen[-1]["memoryUserId"] is None
    assert client.delete("/api/memory", headers=headers[0]).status_code == 200
    assert client.get("/api/memory/plugin", headers=headers[0], params={"conversationId": first_conv}).json()["categories"] == {}
    assert client.get("/api/memory/plugin", headers=headers[0], params={"conversationId": second_conv}).json()["categories"] == {}
    assert client.get("/api/memory/plugin", headers=headers[1], params={"conversationId": other_conv}).json()["categories"]["Details"]["color"] == "gold"


class TestAuth:
    def test_register_login_me(self, client, auth):
        token, user_id = auth
        assert token and user_id
        me = client.get("/api/auth/me", headers=_h(token))
        assert me.status_code == 200
        assert me.json()["authenticated"] is True
        assert me.json()["user"]["id"] == user_id

    def test_chat_requires_session(self, client):
        r = client.post("/api/chat/", json={"model": "x", "messages": []})
        assert r.status_code == 401

    def test_login_wrong_password(self, client):
        r = client.post("/api/auth/login", json={"username": "apitest", "password": "wrong"})
        assert r.status_code in (401, 400)


class TestSettings:
    @pytest.fixture()
    def admin_cookies(self):
        # Admin routes require the settings_auth=1 cookie, set via POST /api/settings/auth
        return {"settings_auth": "1"}

    def test_get_settings_returns_object(self, client):
        r = client.get("/api/settings")
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, dict)
        assert "modelAssignments" in data

    def test_put_settings_roundtrip(self, client, admin_cookies):
        r = client.put("/api/settings", cookies=admin_cookies, json={"kvCacheOffload": False})
        assert r.status_code == 200
        data = client.get("/api/settings").json()
        assert data.get("kvCacheOffload") is False


class TestConversations:
    def test_crud(self, client, auth):
        token, user_id = auth
        h = _h(token, user_id)
        created = client.post("/api/conversations/", headers=h, json={"title": "T", "mode": "chat", "model": "m"})
        assert created.status_code == 200, created.text
        conv = created.json()["conversation"]
        cid = conv["id"]

        listed = client.get("/api/conversations/", headers=h)
        assert listed.status_code == 200
        assert any(c["id"] == cid for c in listed.json()["conversations"])

        got = client.get(f"/api/conversations/{cid}", headers=h)
        assert got.status_code == 200
        assert got.json()["conversation"]["id"] == cid

        deleted = client.delete(f"/api/conversations/{cid}", headers=h)
        assert deleted.status_code == 200


class TestMemory:
    def test_get_memory(self, client, auth):
        token, user_id = auth
        r = client.get("/api/memory", headers=_h(token, user_id))
        assert r.status_code == 200
        assert "enabled" in r.json()


class TestHealth:
    def test_health(self, client):
        r = client.get("/api/health")
        assert r.status_code == 200
        assert r.json()["status"] == "ok"


class TestGeneratedImages:
    def test_missing_image_404(self, client):
        r = client.get("/api/generated/does-not-exist.png")
        assert r.status_code == 404


class TestMalformedBodies:
    """A wedged client can POST `null` or truncated JSON — the routes must
    answer 400, never crash with "'NoneType' object has no attribute 'get'"
    (which returned 500 and made the whole client look dead)."""

    def test_chat_null_body_400(self, client, auth):
        token, _ = auth
        r = client.post("/api/chat/", content=b"null", headers=_h(token))
        assert r.status_code == 400
        assert "JSON object" in r.json()["error"]

    def test_chat_malformed_json_400(self, client, auth):
        token, _ = auth
        r = client.post("/api/chat/", content=b'{"model":', headers=_h(token))
        assert r.status_code == 400

    def test_chat_non_dict_body_400(self, client, auth):
        token, _ = auth
        r = client.post("/api/chat/", content=b'[1,2,3]', headers=_h(token))
        assert r.status_code == 400

    def test_chat_null_message_entry_400(self, client, auth):
        token, _ = auth
        r = client.post(
            "/api/chat/",
            json={"model": "qwen3:0.6b", "messages": [{"role": "user", "content": "hi"}, None]},
            headers=_h(token),
        )
        assert r.status_code == 400

    def test_chat_empty_messages_400(self, client, auth):
        token, _ = auth
        r = client.post("/api/chat/", json={"model": "x", "messages": []}, headers=_h(token))
        assert r.status_code == 400

    def test_stop_null_body_400(self, client, auth):
        token, _ = auth
        r = client.post("/api/chat/stop", content=b"null", headers=_h(token))
        assert r.status_code == 400

    def test_answer_null_body_400(self, client, auth):
        token, _ = auth
        r = client.post("/api/chat/answer", content=b"null", headers=_h(token))
        assert r.status_code == 400

    def test_approve_null_body_400(self, client, auth):
        token, _ = auth
        r = client.post("/api/chat/approve", content=b"null", headers=_h(token))
        assert r.status_code == 400

    def test_title_null_body_400(self, client, auth):
        token, _ = auth
        r = client.post("/api/chat/title", content=b"null", headers=_h(token))
        assert r.status_code == 400
