"""Image inspection — storing attached pictures, feeding them to the model, and
the two routes the clients use to render them.

What this locks down:

- an image attached in a client is written to disk once (content-addressed) and
  the *saved* message keeps only a small ``[image:<filename>]`` reference, so a
  10 MB photo never becomes 13 MB of base64 in the conversation store
- that reference resolves back to base64 for a vision model — including images
  replayed from earlier turns and more than one image per message
- image markers never leak into the text the model reads, and one request can
  never carry an unbounded number of images
- ``/api/attachments`` and ``/api/files/raw`` are session-protected, sandboxed,
  and refuse anything that is not an image
"""

from __future__ import annotations

import asyncio
import base64
import os
import re
import tempfile

import pytest
from fastapi.testclient import TestClient

# Isolated data dir BEFORE importing app modules (pattern of test_api.py).
_TMP = tempfile.mkdtemp(prefix="kasalix-images-")
os.environ.setdefault("DATA_DIR", _TMP)
os.environ.setdefault("OLLAMA_URL", "http://127.0.0.1:9")

import app.attachments as attachments  # noqa: E402
from app.main import app  # noqa: E402
from app.ollama_client import convert_messages_for_ollama  # noqa: E402
from app.pipeline import detect_intent  # noqa: E402

# 1x1 fully-red PNG
RED_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAE/AF/"
    "mAHDLwAAAABJRU5ErkJggg=="
)
RED_PNG_B64 = base64.b64encode(RED_PNG).decode()
RED_DATA_URL = f"data:image/png;base64,{RED_PNG_B64}"

# A second, visibly different payload — enough to prove ordering and dedupe.
OTHER_B64 = base64.b64encode(b"\x89PNG\r\n\x1a\n-second-image-bytes").decode()
OTHER_DATA_URL = f"data:image/png;base64,{OTHER_B64}"

REF_RE = re.compile(r"^\[image:[0-9a-f]{32}\.png\]$")


@pytest.fixture()
def store(tmp_path, monkeypatch):
    """Point the attachment store at a scratch directory."""
    monkeypatch.setenv("ATTACHMENTS_DIR", str(tmp_path))
    return tmp_path


class TestAttachmentStorage:
    def test_data_url_is_stored_and_rewritten(self, store):
        out = attachments.persist_data_urls(f"look at this [image:{RED_DATA_URL}]")
        assert REF_RE.match(out.split(" ", 3)[-1]), out
        assert out.startswith("look at this ")
        files = list(store.iterdir())
        assert len(files) == 1
        assert files[0].read_bytes() == RED_PNG
        assert attachments.load_attachment_b64(files[0].name) == RED_PNG_B64

    def test_same_image_twice_is_stored_once(self, store):
        first = attachments.persist_data_urls(f"[image:{RED_DATA_URL}]")
        second = attachments.persist_data_urls(f"[image:{RED_DATA_URL}]")
        assert first == second
        assert len(list(store.iterdir())) == 1

    def test_different_images_get_different_names(self, store):
        a = attachments.persist_data_urls(f"[image:{RED_DATA_URL}]")
        b = attachments.persist_data_urls(f"[image:{OTHER_DATA_URL}]")
        assert a != b
        assert len(list(store.iterdir())) == 2

    def test_unsupported_subtype_degrades_to_placeholder(self, store):
        out = attachments.persist_data_urls("[image:data:image/tiff;base64,QUJD]")
        assert out == "[image]"
        assert list(store.iterdir()) == []

    def test_broken_base64_degrades_to_placeholder(self, store):
        out = attachments.persist_data_urls("[image:data:image/png;base64,@@@]")
        assert out == "[image]"

    def test_oversized_image_degrades_to_placeholder(self, store, monkeypatch):
        monkeypatch.setattr(attachments, "MAX_ATTACHMENT_BYTES", 10)
        out = attachments.persist_data_urls(f"[image:{RED_DATA_URL}]")
        assert out == "[image]"
        assert list(store.iterdir()) == []

    def test_text_without_images_is_untouched(self, store):
        text = "no picture here, just [brackets] and a path/to/file.png"
        assert attachments.persist_data_urls(text) == text

    def test_resolve_skips_missing_files(self, store):
        assert attachments.resolve_image_refs(f"[image:{'a' * 32}.png]") == []

    def test_unsafe_filenames_are_refused(self, store):
        (store / "real.png").write_bytes(RED_PNG)
        for name in ("../../users.json", "..png", "a/b.png", "nested/real.png", "real.txt", "real.png.exe"):
            assert attachments.attachment_path(name) is None, name
            assert attachments.load_attachment_b64(name) is None, name

    def test_strip_image_markers_removes_every_form(self):
        text = f"before [image:{RED_DATA_URL}] middle [image:abc.png] after [image]"
        assert attachments.strip_image_markers(text) == "before  middle  after"

    def test_resolve_returns_inline_and_stored_payloads(self, store):
        stored = attachments.persist_data_urls(f"[image:{OTHER_DATA_URL}]")
        name = stored[len("[image:") : -1]
        payloads = attachments.resolve_image_refs(f"[image:{name}] and [image:{RED_DATA_URL}]")
        assert payloads == [OTHER_B64, RED_PNG_B64]


class TestConverterImages:
    def test_stored_reference_reaches_model(self, store):
        stored = attachments.persist_data_urls(f"[image:{RED_DATA_URL}]")
        name = stored[len("[image:") : -1]
        converted = convert_messages_for_ollama([{"role": "user", "content": f"what is this [image:{name}]"}])
        assert converted[0]["images"] == [RED_PNG_B64]
        assert converted[0]["content"] == "what is this"
        assert "[image" not in converted[0]["content"]

    def test_inline_data_url_still_reaches_model(self):
        converted = convert_messages_for_ollama([{"role": "user", "content": f"see [image:{RED_DATA_URL}]"}])
        assert converted[0]["images"] == [RED_PNG_B64]

    def test_several_images_in_one_message_keep_their_order(self, store):
        stored = attachments.persist_data_urls(f"[image:{OTHER_DATA_URL}]")
        name = stored[len("[image:") : -1]
        content = f"[image:{name}] then [image:{RED_DATA_URL}]"
        converted = convert_messages_for_ollama([{"role": "user", "content": content}])
        assert converted[0]["images"] == [OTHER_B64, RED_PNG_B64]

    def test_image_from_an_earlier_turn_is_replayed(self, store):
        stored = attachments.persist_data_urls(f"[image:{RED_DATA_URL}]")
        name = stored[len("[image:") : -1]
        converted = convert_messages_for_ollama(
            [
                {"role": "user", "content": f"what colour is this? [image:{name}]"},
                {"role": "assistant", "content": "It is red."},
                {"role": "user", "content": "and the top half?"},
            ]
        )
        assert converted[0]["images"] == [RED_PNG_B64]
        assert "images" not in converted[2]

    def test_newest_images_win_past_the_cap(self, store):
        messages = [
            {"role": "user", "content": f"round {i} [image:{RED_DATA_URL}]"} for i in range(6)
        ]
        converted = convert_messages_for_ollama(messages)
        attached = [m for m in converted if m.get("images")]
        assert len(attached) == 4, "one request must not carry an unbounded number of images"
        # The four most recent survive; the two oldest lose their image but keep
        # their words (and their stripped marker).
        assert converted[0]["content"] == "round 0"
        assert "images" not in converted[0]
        assert converted[5]["images"] == [RED_PNG_B64]

    def test_oversized_payload_is_dropped_not_sent(self, monkeypatch):
        monkeypatch.setattr("app.ollama_client.MAX_IMAGE_BASE64_CHARS", 10)
        converted = convert_messages_for_ollama([{"role": "user", "content": f"see [image:{RED_DATA_URL}]"}])
        assert "images" not in converted[0]
        assert converted[0]["content"] == "see"

    def test_placeholder_without_a_resolvable_image_keeps_the_message(self, store):
        converted = convert_messages_for_ollama([{"role": "user", "content": "have a look [image:gone.png]"}])
        assert "images" not in converted[0]
        assert converted[0]["content"] == "have a look"

    def test_bare_placeholder_still_produces_content(self):
        converted = convert_messages_for_ollama([{"role": "user", "content": "[image]"}])
        assert converted[0]["content"] == "[image]"
        assert "images" not in converted[0]

    def test_tool_calls_survive_on_an_image_message(self, store):
        stored = attachments.persist_data_urls(f"[image:{RED_DATA_URL}]")
        name = stored[len("[image:") : -1]
        converted = convert_messages_for_ollama(
            [
                {
                    "role": "assistant",
                    "content": f"here [image:{name}]",
                    "tool_calls": [{"function": {"name": "look"}}],
                }
            ]
        )
        assert converted[0]["tool_calls"] == [{"function": {"name": "look"}}]
        assert converted[0]["images"] == [RED_PNG_B64]


class TestPipelineSeesStoredImages:
    """The chat pipeline routes an attached picture through the vision model for
    a non-vision chat model — that must keep working once the image lives on
    disk as a reference (a re-sent or regenerated message)."""

    def _store(self, data_url: str) -> str:
        stored = attachments.persist_data_urls(f"[image:{data_url}]")
        return stored[len("[image:") : -1]

    def test_intent_resolves_a_stored_reference(self, store):
        name = self._store(RED_DATA_URL)
        intent = asyncio.run(detect_intent([{"role": "user", "content": f"what is this [image:{name}]"}], "chat"))
        assert intent["hasImage"] is True
        assert intent["imageDataUrl"] == f"data:image/png;base64,{RED_PNG_B64}"

    def test_intent_ignores_a_placeholder(self, store):
        intent = asyncio.run(detect_intent([{"role": "user", "content": "just some text [image]"}], "chat"))
        assert intent["hasImage"] is False
        assert intent["imageDataUrl"] is None

    def test_data_urls_reencode_stored_files_with_their_mime(self, store):
        jpeg_b64 = base64.b64encode(b"pretend-jpeg-bytes").decode()
        name = self._store(f"data:image/jpeg;base64,{jpeg_b64}")
        assert attachments.image_data_urls(f"see [image:{name}]") == [f"data:image/jpeg;base64,{jpeg_b64}"]

    def test_data_urls_pass_inline_images_through(self, store):
        assert attachments.image_data_urls(f"see [image:{RED_DATA_URL}]") == [RED_DATA_URL]


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def token(client):
    payload = {"username": "imagetest", "password": "secret123"}
    r = client.post("/api/auth/register", json=payload)
    if r.status_code == 409:
        r = client.post("/api/auth/login", json=payload)
    assert r.status_code in (200, 201), r.text
    return r.json()["token"]


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


class TestAttachmentRoute:
    def test_requires_a_session(self, client):
        assert client.get("/api/attachments/abc.png").status_code == 401

    def test_serves_the_stored_image(self, client, token, store):
        stored = attachments.persist_data_urls(f"[image:{RED_DATA_URL}]")
        name = stored[len("[image:") : -1]
        r = client.get(f"/api/attachments/{name}", headers=_headers(token))
        assert r.status_code == 200
        assert r.headers["content-type"] == "image/png"
        assert r.content == RED_PNG

    def test_missing_image_is_404(self, client, token, store):
        r = client.get(f"/api/attachments/{'b' * 32}.png", headers=_headers(token))
        assert r.status_code == 404

    def test_traversal_and_bad_names_are_400(self, client, token, store):
        for name in ("..%5Cusers.json", "notes.txt", "no-extension"):
            r = client.get(f"/api/attachments/{name}", headers=_headers(token))
            assert r.status_code == 400, (name, r.status_code)


class TestWorkspaceRawImageRoute:
    def _workspace(self, tmp_path):
        ws = tmp_path / "ws"
        (ws / "screenshots").mkdir(parents=True)
        (ws / "screenshots" / "shot.png").write_bytes(RED_PNG)
        (ws / "notes.txt").write_text("hello", encoding="utf-8")
        (ws / "node_modules").mkdir()
        (ws / "node_modules" / "logo.png").write_bytes(RED_PNG)
        return ws

    def test_requires_a_session(self, client, tmp_path):
        ws = self._workspace(tmp_path)
        r = client.get("/api/files/raw", params={"path": str(ws / "screenshots" / "shot.png"), "workspacePath": str(ws)})
        assert r.status_code == 401

    def test_serves_image_bytes(self, client, token, tmp_path):
        ws = self._workspace(tmp_path)
        r = client.get(
            "/api/files/raw",
            params={"path": str(ws / "screenshots" / "shot.png"), "workspacePath": str(ws)},
            headers=_headers(token),
        )
        assert r.status_code == 200, r.text
        assert r.headers["content-type"] == "image/png"
        assert r.content == RED_PNG

    def test_non_image_is_refused(self, client, token, tmp_path):
        ws = self._workspace(tmp_path)
        r = client.get(
            "/api/files/raw",
            params={"path": str(ws / "notes.txt"), "workspacePath": str(ws)},
            headers=_headers(token),
        )
        assert r.status_code == 415

    def test_outside_the_workspace_is_refused(self, client, token, tmp_path):
        ws = self._workspace(tmp_path)
        outside = tmp_path / "outside.png"
        outside.write_bytes(RED_PNG)
        r = client.get(
            "/api/files/raw",
            params={"path": str(outside), "workspacePath": str(ws)},
            headers=_headers(token),
        )
        assert r.status_code == 403

    def test_protected_directory_is_refused(self, client, token, tmp_path):
        ws = self._workspace(tmp_path)
        r = client.get(
            "/api/files/raw",
            params={"path": str(ws / "node_modules" / "logo.png"), "workspacePath": str(ws)},
            headers=_headers(token),
        )
        assert r.status_code == 403

    def test_missing_workspace_is_refused(self, client, token, tmp_path):
        r = client.get("/api/files/raw", params={"path": str(tmp_path / "x.png")}, headers=_headers(token))
        assert r.status_code == 403
