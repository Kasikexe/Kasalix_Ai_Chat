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