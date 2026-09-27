"""ALC API routes — the documentation index and knowledge views used by Settings.

The cycle itself is covered by the other ALC tests; this file pins the HTTP
surface: it is session-protected, it reports what is indexed, it can rebuild on
demand, and it lists the notes a workspace's earlier cycles remembered.
"""

from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# Point the app at a temp data dir BEFORE importing app modules.
_TMP = tempfile.mkdtemp(prefix="kasalix-alc-routes-test-")
os.environ["DATA_DIR"] = _TMP
os.environ["OLLAMA_URL"] = "http://127.0.0.1:9"  # unreachable — no accidental Ollama use

from app.main import app  # noqa: E402
from app.alc import docs, knowledge  # noqa: E402
from app.settings_store import invalidate_settings_cache  # noqa: E402

GUIDE = """# Zorb engine

## Pace

Call zorb_set_pace(frames) to change the pace; the default is 12 frames.
"""


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def docs_dir(tmp_path, monkeypatch):
    """An isolated DATA_DIR plus one documentation folder with a markdown file."""
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setenv("DATA_DIR", str(data))
    invalidate_settings_cache()

    root = tmp_path / "documentation"
    root.mkdir()
    (root / "guide.md").write_text(GUIDE, encoding="utf-8")
    yield root
    invalidate_settings_cache()


@pytest.fixture(scope="module")
def session(client):
    # Registered once for the whole module: the auth store keeps users in memory,
    # so a per-test registration would collide on the username.
    r = client.post("/api/auth/register", json={"username": "alctest", "password": "secret123"})
    assert r.status_code == 201, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


# ─── Auth ───────────────────────────────────────────────────────────────
def test_alc_routes_require_a_session(client):
    assert client.get("/api/alc/index").status_code == 401
    assert client.post("/api/alc/index").status_code == 401
    assert client.get("/api/alc/knowledge").status_code == 401


# ─── Index status ───────────────────────────────────────────────────────
def test_index_status_is_empty_before_anything_is_configured(client, docs_dir, session):
    data = client.get("/api/alc/index", headers=session).json()
    assert data["roots"] == []
    assert data["status"]["built"] is False
    assert data["status"]["files"] == 0
    assert isinstance(data["fts5"], bool)
    assert data["indexPath"].endswith("docs-index.sqlite")


def test_configured_folders_are_resolved_and_missing_ones_reported(client, docs_dir, session):
    ghost = str(docs_dir / "does-not-exist")
    r = client.put(
        "/api/settings",
        json={"alcDocsPaths": [str(docs_dir), ghost, "   "]},
    )
    assert r.status_code == 200

    data = client.get("/api/alc/index", headers=session).json()
    assert data["roots"] == [os.path.realpath(str(docs_dir))]
    assert data["missing"] == [ghost]

    # …and clean up so the settings do not leak into the other tests.
    client.put("/api/settings", json={"alcDocsPaths": []})


def test_rebuild_indexes_the_configured_folders(client, docs_dir, session):
    client.put("/api/settings", json={"alcDocsPaths": [str(docs_dir)]})
    try:
        r = client.post("/api/alc/index", json={}, headers=session)
        assert r.status_code == 200
        data = r.json()
        assert data["ok"] is True
        assert data["stats"]["files"] == 1
        assert data["stats"]["chunks"] > 0
        assert data["status"]["built"] is True
        assert data["status"]["files"] == 1
        assert docs.search("zorb_set_pace", roots=[str(docs_dir)])

        # A second, non-forced build skips the unchanged file.
        again = client.post("/api/alc/index", json={"force": False}, headers=session).json()
        assert again["stats"]["updated"] == 0
        assert again["stats"]["skipped"] == 1
    finally:
        client.put("/api/settings", json={"alcDocsPaths": []})


def test_rebuild_without_folders_says_so_instead_of_failing(client, docs_dir, session):
    data = client.post("/api/alc/index", json={}, headers=session).json()
    assert data["ok"] is False
    assert "folder" in data["error"]


def test_clearing_the_index_forgets_every_document(client, docs_dir, session):
    client.put("/api/settings", json={"alcDocsPaths": [str(docs_dir)]})
    try:
        client.post("/api/alc/index", json={}, headers=session)
        assert docs.index_status()["files"] == 1

        data = client.delete("/api/alc/index", headers=session).json()
        assert data["ok"] is True
        assert data["status"]["files"] == 0
        assert data["status"]["built"] is False
    finally:
        client.put("/api/settings", json={"alcDocsPaths": []})


# ─── The chat route's ALC contract ──────────────────────────────────────
class TestChatRouteAlcContract:
    """The client's half of ALC: the `alc` request field and the `alc:*` frames.

    The cycle itself is covered by test_alc_controller.py; what is pinned here is
    the wire contract the frontend depends on — `alc: true` in the body reaches
    the pipeline, its events stream back as their own SSE types (so they can
    never be mistaken for answer text), and the toggle is remembered on the
    conversation.
    """

    def test_alc_flag_and_events_travel_over_the_chat_stream(self, client, docs_dir, session, monkeypatch):
        import app.routes.chat as chat_route

        seen: dict = {}

        async def fake_run_pipeline(opts):
            seen["alc"] = opts.get("alc")
            sink = opts.get("onAlcEvent")
            assert callable(sink), "the route must pass an onAlcEvent sink"
            sink({"type": "alc:start", "model": "test-model", "roots": 0, "tools": [],
                  "maxCycles": 3, "maxToolCalls": 12, "maxTokens": 4000, "webEnabled": False})
            sink({"type": "alc:finding", "source": "docs:guide.md",
                  "text": "zorb_set_pace defaults to 12 frames.", "query": "pace"})
            opts["onChunk"]("The zorb pace defaults to 12 frames.")
            return "The zorb pace defaults to 12 frames."

        monkeypatch.setattr(chat_route, "run_pipeline", fake_run_pipeline)

        with client.stream(
            "POST",
            "/api/chat/",
            json={
                "model": "test-model",
                "messages": [{"role": "user", "content": "what is the zorb pace?"}],
                "alc": True,
            },
            headers=session,
        ) as response:
            assert response.status_code == 200
            body = "".join(response.iter_text())

        assert seen["alc"] is True
        assert '"type": "alc:start"' in body
        assert '"type": "alc:finding"' in body
        assert "zorb_set_pace defaults to 12 frames." in body

        conversation_id = re.search(r'"conversationId": "([^"]+)"', body)
        assert conversation_id, body
        stored = client.get(f"/api/conversations/{conversation_id.group(1)}", headers=session).json()
        assert stored["conversation"]["alc"] is True

    def test_alc_off_by_default_even_when_the_field_is_absent(self, client, docs_dir, session, monkeypatch):
        import app.routes.chat as chat_route

        seen: dict = {}

        async def fake_run_pipeline(opts):
            seen["alc"] = opts.get("alc")
            opts["onChunk"]("ok")
            return "ok"

        monkeypatch.setattr(chat_route, "run_pipeline", fake_run_pipeline)
        with client.stream(
            "POST",
            "/api/chat/",
            json={"model": "test-model", "messages": [{"role": "user", "content": "hi"}]},
            headers=session,
        ) as response:
            assert response.status_code == 200
            "".join(response.iter_text())

        assert seen["alc"] is False


# ─── Project knowledge ──────────────────────────────────────────────────
def test_knowledge_needs_an_existing_workspace(client, docs_dir, session):
    data = client.get("/api/alc/knowledge", params={"workspace": str(docs_dir / "nope")}, headers=session).json()
    assert data["available"] is False
    assert data["topics"] == []


def test_knowledge_lists_what_earlier_cycles_remembered(client, docs_dir, session, tmp_path):
    workspace = tmp_path / "project"
    workspace.mkdir()
    knowledge.remember(str(workspace), "Zorb pace", "zorb_set_pace defaults to 12 frames.", tags=["alc"])

    data = client.get("/api/alc/knowledge", params={"workspace": str(workspace)}, headers=session).json()
    assert data["available"] is True
    assert [topic["topic"] for topic in data["topics"]] == ["zorb-pace"]
    assert data["topics"][0]["title"] == "Zorb pace"
    assert data["topics"][0]["notes"] == 1
    assert data["stats"]["topics"] == 1
    assert data["stats"]["notes"] == 1
    # The store must never be written to by a read.
    assert (Path(workspace) / "ALC" / "knowledge").is_dir()


def test_knowledge_without_a_workspace_is_not_an_error(client, docs_dir, session):
    data = client.get("/api/alc/knowledge", headers=session).json()
    assert data["available"] is False
