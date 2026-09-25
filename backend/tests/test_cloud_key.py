"""Cloud API-key verification — the shared probe and /api/settings/test-cloud-key.

The fake cloud endpoint below reproduces the real ollama.com auth contract:
``POST /api/chat`` with an unknown model answers 404 once auth has passed (that
is the success signal) and 401 when the key is wrong. ``GET /v1/models`` is
public, which is exactly why the probe must not trust it — these tests pin that
down so nobody "simplifies" the probe back into a GET.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from fastapi.testclient import TestClient

# Point the app at a temp data dir BEFORE importing the app module.
_TMP = tempfile.mkdtemp(prefix="kasalix-cloudkey-test-")
os.environ["DATA_DIR"] = _TMP
os.environ["OLLAMA_URL"] = "http://127.0.0.1:9"  # unreachable — no accidental Ollama use

from app.cloud_auth import verify_cloud_key  # noqa: E402
from app.main import app  # noqa: E402
from app.routes.chat import looks_like_cloud_failure  # noqa: E402

GOOD_KEY = "good-key"
BAD_KEY = "bad-key"
# Port 9 (discard) is never listening here — used as an unreachable endpoint.
UNREACHABLE = "http://127.0.0.1:9"


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def _reset_cloud_settings(client: TestClient) -> None:
    r = client.put(
        "/api/settings",
        json={
            "cloudMode": "auto",
            "cloudApiKey": "",
            "cloudEndpoint": "",
            "cloudModelAssignments": {},
        },
        headers={"Cookie": "settings_auth=1"},
    )
    assert r.status_code == 200, r.text


def _save(client: TestClient, **fields) -> dict:
    """Save cloud settings and assert the values actually landed.

    A silently dropped save would otherwise surface as a confusing
    "verification failed" in the tests that rely on the saved endpoint.
    """
    r = client.put(
        "/api/settings",
        json=fields,
        headers={"Cookie": "settings_auth=1"},
    )
    assert r.status_code == 200, r.text
    saved = r.json()
    for key, value in fields.items():
        assert saved.get(key) == value, f"{key} was not saved: {saved.get(key)!r}"
    return saved


@pytest.fixture(autouse=True)
def baseline(client):
    """Reset cloud settings before AND after each test.

    Test modules share one DATA_DIR, so leaking a half-configured cloud account
    here would change what later modules see.
    """
    _reset_cloud_settings(client)
    yield
    _reset_cloud_settings(client)


# ─── Fake cloud endpoint ────────────────────────────────────────────────────


class _FakeCloudHandler(BaseHTTPRequestHandler):
    """Mimics ollama.com: auth is checked before model lookup."""

    # HTTP/1.1 + always writing Content-Length keeps the connection alive.
    protocol_version = "HTTP/1.1"

    probe_status = 404
    models: list[dict] | None = [{"id": "gpt-oss:120b"}, {"id": "qwen3-coder:480b"}]

    def log_message(self, *args):  # keep pytest output clean
        pass

    def _drain_request_body(self) -> None:
        """Read the request body before replying.

        Replying while the client is still writing the POST body makes Windows
        reset the connection, which httpx reports as a transport error — that
        turned into an intermittent, very confusing "endpoint unreachable"
        failure in these tests.
        """
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            length = 0
        if length > 0:
            self.rfile.read(length)

    def _send(self, status: int, payload: dict) -> None:
        self._drain_request_body()
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        return self.headers.get("Authorization", "") == f"Bearer {GOOD_KEY}"

    def do_POST(self):  # noqa: N802 — BaseHTTPRequestHandler API
        if self.path != "/api/chat":
            self._send(404, {"error": "not found"})
            return
        if not self._authorized():
            self._send(401, {"error": "unauthorized"})
            return
        self._send(self.probe_status, {"error": f"model not found (probe {self.probe_status})"})

    def do_GET(self):  # noqa: N802 — BaseHTTPRequestHandler API
        if self.path == "/v1/models":
            self._send(200, {"data": self.models or []})
            return
        self._send(404, {"error": "not found"})


class _Probe200Handler(_FakeCloudHandler):
    probe_status = 200


class _ServerErrorHandler(_FakeCloudHandler):
    def do_POST(self):  # noqa: N802
        self._send(500, {"error": "boom"})


class _NoModelListHandler(_FakeCloudHandler):
    def do_GET(self):  # noqa: N802
        self._send(404, {"error": "not found"})


@contextlib.contextmanager
def fake_cloud(handler=_FakeCloudHandler):
    """Serve a fake cloud endpoint on an ephemeral localhost port."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


# ─── verify_cloud_key ───────────────────────────────────────────────────────


class TestVerifyCloudKey:
    def test_missing_endpoint(self):
        result = asyncio.run(verify_cloud_key("", GOOD_KEY))
        assert result["ok"] is False
        assert result["kind"] == "endpoint"

    def test_missing_key(self):
        with fake_cloud() as endpoint:
            result = asyncio.run(verify_cloud_key(endpoint, "   "))
        assert result["ok"] is False
        assert result["kind"] == "key"

    def test_valid_key_reports_success(self):
        with fake_cloud() as endpoint:
            result = asyncio.run(verify_cloud_key(endpoint, GOOD_KEY))
        assert result["ok"] is True, result
        # 404 for the fake model is the documented success signal.
        assert result["status"] == 404
        assert isinstance(result["latencyMs"], int)
        # Model listing is opt-in — the chat path must not pay for it.
        assert "modelCount" not in result

    def test_valid_key_with_model_count(self):
        with fake_cloud() as endpoint:
            result = asyncio.run(verify_cloud_key(endpoint, GOOD_KEY, include_models=True))
        assert result["ok"] is True, result
        assert result["modelCount"] == 2

    def test_missing_model_list_still_verifies(self):
        with fake_cloud(_NoModelListHandler) as endpoint:
            result = asyncio.run(verify_cloud_key(endpoint, GOOD_KEY, include_models=True))
        assert result["ok"] is True
        assert "modelCount" not in result

    def test_probe_200_counts_as_success(self):
        with fake_cloud(_Probe200Handler) as endpoint:
            result = asyncio.run(verify_cloud_key(endpoint, GOOD_KEY))
        assert result["ok"] is True
        assert result["status"] == 200

    def test_bad_key_reports_auth_failure(self):
        with fake_cloud() as endpoint:
            result = asyncio.run(verify_cloud_key(endpoint, BAD_KEY))
        assert result["ok"] is False
        assert result["kind"] == "auth"
        assert result["status"] == 401
        # The message must keep matching the pipeline's cloud-failure detector,
        # otherwise the client never learns the key was the problem.
        assert looks_like_cloud_failure(result["message"]) is True

    def test_server_error_reports_service_failure(self):
        with fake_cloud(_ServerErrorHandler) as endpoint:
            result = asyncio.run(verify_cloud_key(endpoint, GOOD_KEY))
        assert result["ok"] is False
        assert result["kind"] == "service"
        assert result["status"] == 500
        assert looks_like_cloud_failure(result["message"]) is True

    def test_unreachable_endpoint_reports_transport_failure(self):
        result = asyncio.run(verify_cloud_key(UNREACHABLE, GOOD_KEY, timeout=2.0))
        assert result["ok"] is False
        assert result["kind"] == "endpoint"
        assert "Cannot reach" in result["message"]
        # httpx connect errors stringify to "", so the message must still carry
        # something the user can act on instead of a dangling "— ".
        assert result["message"].strip().endswith(")")
        assert not result["message"].rstrip().endswith("—")
        assert looks_like_cloud_failure(result["message"]) is True

    def test_trailing_slash_is_normalized(self):
        with fake_cloud() as endpoint:
            result = asyncio.run(verify_cloud_key(endpoint + "/", GOOD_KEY))
        assert result["ok"] is True, result


# ─── POST /api/settings/test-cloud-key ──────────────────────────────────────


class TestTestCloudKeyRoute:
    def _post(self, client, payload):
        r = client.post(
            "/api/settings/test-cloud-key",
            json=payload,
            headers={"Cookie": "settings_auth=1"},
        )
        assert r.status_code == 200, r.text
        return r.json()

    def test_validates_the_posted_key_and_endpoint(self, client):
        with fake_cloud() as endpoint:
            body = self._post(client, {"cloudApiKey": GOOD_KEY, "cloudEndpoint": endpoint})
        assert body["ok"] is True, body
        assert body["modelCount"] == 2

    def test_rejects_a_dead_posted_key(self, client):
        with fake_cloud() as endpoint:
            body = self._post(client, {"cloudApiKey": BAD_KEY, "cloudEndpoint": endpoint})
        assert body["ok"] is False
        assert body["kind"] == "auth"

    def test_reports_missing_key(self, client):
        with fake_cloud() as endpoint:
            body = self._post(client, {"cloudApiKey": "", "cloudEndpoint": endpoint})
        assert body["ok"] is False
        assert body["kind"] == "key"

    def test_reports_missing_endpoint(self, client):
        body = self._post(client, {"cloudApiKey": GOOD_KEY})
        assert body["ok"] is False
        assert body["kind"] == "endpoint"

    def test_falls_back_to_saved_settings(self, client):
        with fake_cloud() as endpoint:
            _save(client, cloudApiKey=GOOD_KEY, cloudEndpoint=endpoint)
            body = self._post(client, {})
        assert body["ok"] is True, body

    def test_posted_key_overrides_saved_key(self, client):
        with fake_cloud() as endpoint:
            _save(client, cloudApiKey=BAD_KEY, cloudEndpoint=endpoint)
            body = self._post(client, {"cloudApiKey": GOOD_KEY})
        assert body["ok"] is True, body

    def test_posted_endpoint_overrides_saved_endpoint(self, client):
        with fake_cloud() as endpoint:
            _save(client, cloudApiKey=GOOD_KEY, cloudEndpoint=UNREACHABLE)
            body = self._post(client, {"cloudEndpoint": endpoint})
        assert body["ok"] is True, body

    def test_testing_does_not_save_the_key(self, client):
        with fake_cloud() as endpoint:
            _save(client, cloudApiKey=BAD_KEY, cloudEndpoint=endpoint)
            assert self._post(client, {"cloudApiKey": GOOD_KEY})["ok"] is True
            saved = client.get("/api/settings").json()
        # Testing must never quietly persist the key under test.
        assert saved["cloudApiKey"] == BAD_KEY

    def test_malformed_body_falls_back_to_saved_settings(self, client):
        r = client.post(
            "/api/settings/test-cloud-key",
            content="not json at all",
            headers={"Cookie": "settings_auth=1", "Content-Type": "application/json"},
        )
        assert r.status_code == 200, r.text
        assert r.json()["ok"] is False
        assert r.json()["kind"] in {"key", "endpoint"}
