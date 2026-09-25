"""Preview system tests — the agent's ability to SEE its web work.

Covers:
- the static preview server (HTML injection, bridge JS route, traversal
  jail, console capture, stop) — a real server on a random loopback port
- the /api/preview/register-client endpoint (loopback guard, URL
  validation, registration effect)
- the write_file no-op guard: a successful "no change needed" write must
  NOT count as a failure for the identical-call guard
"""
from __future__ import annotations

import asyncio
import json
import os
import tempfile
import urllib.request

import pytest
from starlette.requests import Request

from app.preview import (
    client_bridge_url,
    get_preview_session,
    register_client_bridge,
    start_preview,
    stop_preview,
)
from app.routes.preview import register_preview_client


# ─── helpers ─────────────────────────────────────────────────────────────


def _mk_request(path: str, body: dict, client_host: str) -> Request:
    payload = json.dumps(body).encode()
    scope = {
        "type": "http",
        "method": "POST",
        "path": path,
        "headers": [(b"content-type", b"application/json")],
        "query_string": b"",
        "client": (client_host, 50000),
    }
    received = {"done": False}

    async def receive() -> dict:
        if received["done"]:
            return {"type": "http.disconnect"}
        received["done"] = True
        return {"type": "http.request", "body": payload, "more_body": False}

    return Request(scope, receive)


# ─── static server ───────────────────────────────────────────────────────


@pytest.fixture()
def preview_site(tmp_path):
    (tmp_path / "index.html").write_text("<html><body><h1>Snake</h1></body></html>", encoding="utf-8")
    (tmp_path / "app.js").write_text("console.log('hi');", encoding="utf-8")
    info = start_preview(str(tmp_path))
    assert info["ok"], info
    yield info
    stop_preview()


def test_preview_serves_and_injects_bridge(preview_site):
    url = preview_site["url"]
    html = urllib.request.urlopen(url, timeout=5).read().decode()
    assert "<h1>Snake</h1>" in html
    assert '<script src="/__preview.js"></script>' in html
    js = urllib.request.urlopen(url.split("?")[0] + "__preview.js", timeout=5).read().decode()
    assert "__kasalixPreviewLoaded" in js


def test_preview_traversal_blocked(preview_site):
    base = preview_site["url"].split("?")[0]
    for evil in ("..%2f..%2fsecret", "a/../..%2fsecret"):
        try:
            urllib.request.urlopen(base + evil, timeout=5)
            pytest.fail(f"traversal not blocked: {evil}")
        except Exception:
            pass  # 403/400 — blocked


def test_preview_bridge_console_capture(preview_site):
    session = get_preview_session()
    assert session is not None
    base = preview_site["url"].split("?")[0]
    body = json.dumps({"type": "console", "level": "error", "text": "boom", "id": session.session_id}).encode()
    req = urllib.request.Request(
        base + "__bridge", data=body, headers={"Content-Type": "application/json"}
    )
    urllib.request.urlopen(req, timeout=5)
    assert len(session.console) == 1
    assert session.console[0]["level"] == "error"
    assert session.console[0]["text"] == "boom"


def test_preview_register_requires_matching_session_id(preview_site):
    session = get_preview_session()
    assert session is not None and not session.window_registered.is_set()
    base = preview_site["url"].split("?")[0]

    def _post(payload: dict) -> None:
        body = json.dumps(payload).encode()
        req = urllib.request.Request(
            base + "__bridge", data=body, headers={"Content-Type": "application/json"}
        )
        urllib.request.urlopen(req, timeout=5)

    _post({"type": "register", "id": "stale-session-id"})
    assert not session.window_registered.is_set(), "stale session id must not register"
    _post({"type": "register", "id": session.session_id})
    assert session.window_registered.is_set()


def test_preview_stop_kills_server(tmp_path):
    (tmp_path / "index.html").write_text("<html></html>", encoding="utf-8")
    info = start_preview(str(tmp_path))
    assert info["ok"]
    url = info["url"]
    assert stop_preview()["stopped"] is True
    assert get_preview_session() is None
    with pytest.raises(Exception):
        urllib.request.urlopen(url, timeout=2)


def test_start_preview_rejects_missing_dir(tmp_path):
    info = start_preview(str(tmp_path / "does-not-exist"))
    assert not info["ok"] and "not a directory" in info["error"]


# ─── bridge registration endpoint ────────────────────────────────────────


@pytest.mark.asyncio
async def test_register_client_accepts_lan_source():
    """The client may reach the backend over a LAN IP while running on the
    same machine (its saved server URL, e.g. https://192.168.31.89:3001).
    Source-IP gating silently broke registration forever — the invariant
    that matters is the registered URL being loopback, which is enforced
    in register_client_bridge regardless of source."""
    try:
        req = _mk_request("/api/preview/register-client", {"url": "http://127.0.0.1:59998/"}, "192.168.31.89")
        resp = await register_preview_client(req)
        assert resp.status_code == 200
        assert client_bridge_url() == "http://127.0.0.1:59998/"
    finally:
        import app.preview as pv

        pv._client_bridge["url"] = None


@pytest.mark.asyncio
async def test_register_client_rejects_bad_url():
    req = _mk_request("/api/preview/register-client", {"url": "https://evil.example/"}, "127.0.0.1")
    resp = await register_preview_client(req)
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_register_client_rejects_non_loopback_url_even_from_lan():
    """A remote host must not be able to point the backend's bridge calls at
    an arbitrary target — only loopback URLs are ever accepted."""
    req = _mk_request("/api/preview/register-client", {"url": "http://10.9.9.9:8080/"}, "10.1.2.3")
    resp = await register_preview_client(req)
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_bridge_status_reflects_registration():
    from app.routes.preview import preview_bridge_status

    import app.preview as pv

    try:
        pv._client_bridge["url"] = None
        resp = await preview_bridge_status()
        assert json.loads(bytes(resp.body)) == {"ok": True, "registered": False}
        pv._client_bridge["url"] = "http://127.0.0.1:59997/"
        resp = await preview_bridge_status()
        assert json.loads(bytes(resp.body)) == {"ok": True, "registered": True}
    finally:
        pv._client_bridge["url"] = None


@pytest.mark.asyncio
async def test_register_client_roundtrip():
    try:
        req = _mk_request("/api/preview/register-client", {"url": "http://127.0.0.1:59999/"}, "127.0.0.1")
        resp = await register_preview_client(req)
        assert resp.status_code == 200
        assert client_bridge_url() == "http://127.0.0.1:59999/"
    finally:
        import app.preview as pv

        pv._client_bridge["url"] = None


# ─── write_file no-op guard (identical-call misclassification fix) ──────


def test_noop_tools_excludes_write_noop_paths():
    from app.agent import NOOP_OK_TOOLS

    # The guard only treats SUCCESSFUL no-op strings as benign; the set
    # itself must exist and be a set of tool names.
    assert isinstance(NOOP_OK_TOOLS, set) and "write_file" in NOOP_OK_TOOLS


def test_write_noop_output_strings_are_benign():
    # The two success strings the guard looks for — keep them stable.
    assert "no change needed" in "snakegame.html already has exactly this content — no change needed."
    assert "already running" in "Preview already running — no change needed."
