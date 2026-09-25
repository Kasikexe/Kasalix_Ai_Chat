"""Vision-capable agent — raw screenshot-to-context path.

When the assigned CODE model is vision-capable, preview_screenshot places
the PNG directly into the model's context (via the [image:data:...] message
marker the Ollama client converts) instead of routing through the separate
vision model's text description. These tests pin:

- the capability probe (1x1 red PNG; 404 = unknown → name fallback)
- preview_screenshot returns imageData when the code model has vision
  capability, and a text description when it does not
- the image reaches the MODEL's message stream (converted by
  convert_messages_for_ollama) while staying out of the client-visible
  onToolResult output and the saved resume state
- old capability caches (pre-vision) are treated as stale and re-probed
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import tempfile

import pytest

# Isolated data dir BEFORE importing app modules (pattern of test_api.py).
_TMP = tempfile.mkdtemp(prefix="kasalix-vision-")
os.environ.setdefault("DATA_DIR", _TMP)
os.environ.setdefault("OLLAMA_URL", "http://127.0.0.1:9")

import app.capabilities as capabilities  # noqa: E402
from app.agent import execute_tool, run_agent_loop  # noqa: E402
from app.ollama_client import convert_messages_for_ollama  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_caps_cache():
    capabilities._caps_cache.clear()
    capabilities._cache_loaded = True  # never touch the dev machine's real cache
    yield
    capabilities._caps_cache.clear()


# 1x1 fully-red PNG
RED_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAE/AF/"
    "mAHDLwAAAABJRU5ErkJggg=="
)
RED_PNG_B64 = base64.b64encode(RED_PNG).decode()


def _vision_session_with_screenshot(tmp_path, monkeypatch):
    """Start a preview session whose bridge returns a real red screenshot."""
    import app.preview as pv

    (tmp_path / "index.html").write_text("<html><body>game</body></html>", encoding="utf-8")
    info = pv.start_preview(str(tmp_path))
    assert info["ok"], info
    session = pv.get_preview_session()
    assert session is not None
    session.window_registered.set()  # pretend the page registered

    async def fake_client_call(payload: dict, timeout: float = 12.0) -> dict:
        assert payload["type"] == "capture"
        out = os.path.join(tempfile.mkdtemp(), "shot.png")
        with open(out, "wb") as f:
            f.write(RED_PNG)
        return {"ok": True, "path": out}

    monkeypatch.setattr(pv, "client_call", fake_client_call)
    return session, pv


def _fake_httpx(monkeypatch, status_code: int, content: str | None):
    """Patch capabilities' httpx client with a canned response."""

    class FakeResponse:
        def __init__(self) -> None:
            self.status_code = status_code

        def json(self) -> dict:
            return {"message": {"content": content or ""}}

    class FakeClient:
        def __init__(self, *a, **kw) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a) -> bool:
            return False

        async def post(self, *a, **kw):
            return FakeResponse()

    monkeypatch.setattr(capabilities.httpx, "AsyncClient", FakeClient)


class TestVisionProbe:
    def test_probe_rejects_404_as_unknown(self, monkeypatch):
        # 404 = model not installed → None (caller uses the name fallback),
        # NOT a hard "no vision" — that was a real bug this suite caught.
        _fake_httpx(monkeypatch, 404, None)
        assert asyncio.run(capabilities._probe_vision("qwen3:8b")) is None

    def test_probe_detects_red_answer(self, monkeypatch):
        _fake_httpx(monkeypatch, 200, "The dominant color is red.")
        assert asyncio.run(capabilities._probe_vision("llava:13b")) is True

    def test_probe_rejects_non_color_answer(self, monkeypatch):
        _fake_httpx(monkeypatch, 200, "I cannot see images.")
        assert asyncio.run(capabilities._probe_vision("qwen3:8b")) is False

    def test_probe_rejects_http_error(self, monkeypatch):
        _fake_httpx(monkeypatch, 500, None)
        assert asyncio.run(capabilities._probe_vision("qwen3:8b")) is False

    def test_name_fallbacks(self):
        assert capabilities._fallback_vision("qwen3-vl:8b") is True
        assert capabilities._fallback_vision("llava:13b") is True
        assert capabilities._fallback_vision("minicpm-v:8b") is True
        assert capabilities._fallback_vision("gemma3:4b") is True
        assert capabilities._fallback_vision("qwen3:8b") is False
        assert capabilities._fallback_vision("qwen2.5-coder:7b") is False

    def test_capabilities_cache_entry_includes_vision(self):
        caps = asyncio.run(capabilities.get_model_capabilities("llava-fallback-test:latest"))
        assert caps["vision"] is True  # name fallback (no Ollama in test env)


class TestScreenshotRawImage:
    def test_vision_capable_model_gets_image_data(self, tmp_path, monkeypatch):
        capabilities._caps_cache["fake-vision-model"] = {"tools": True, "thinking": False, "vision": True}
        _, pv = _vision_session_with_screenshot(tmp_path, monkeypatch)
        try:
            result = asyncio.run(
                execute_tool(
                    str(tmp_path),
                    {"tool": "preview_screenshot", "args": {}},
                    True,
                    extra={"use_vision_model": True},
                )
            )
            assert result["ok"] is True
            assert result["imageData"].startswith("data:image/png;base64,")
            assert base64.b64decode(result["imageData"].split(",", 1)[1]) == RED_PNG
            assert "attached to this tool result" in result["output"]
        finally:
            pv.stop_preview()

    def test_text_model_gets_description_instead(self, tmp_path, monkeypatch):
        """use_vision_model=False (non-vision code model) → the separate
        vision model describes the screenshot (stubbed here)."""
        capabilities._caps_cache["fake-text-model"] = {"tools": True, "thinking": False, "vision": False}
        _, pv = _vision_session_with_screenshot(tmp_path, monkeypatch)

        import app.agent as agent

        async def fake_describe(target: str) -> str:
            return "A red square fills the page."

        monkeypatch.setattr(agent, "describe_image", fake_describe)
        try:
            result = asyncio.run(
                execute_tool(
                    str(tmp_path),
                    {"tool": "preview_screenshot", "args": {}},
                    True,
                    extra={"use_vision_model": False},
                )
            )
            assert result["ok"] is True
            assert "imageData" not in result
            assert "A red square fills the page." in result["output"]
        finally:
            pv.stop_preview()

    def test_oversized_screenshot_falls_back_to_description(self, tmp_path, monkeypatch):
        """Vision-capable model + > 3000 KB base64 → description path
        instead of a context bomb."""
        capabilities._caps_cache["fake-vision-model"] = {"tools": True, "thinking": False, "vision": True}
        import app.preview as pv

        (tmp_path / "index.html").write_text("<html></html>", encoding="utf-8")
        info = pv.start_preview(str(tmp_path))
        assert info["ok"]
        session = pv.get_preview_session()
        session.window_registered.set()

        async def fake_client_call(payload: dict, timeout: float = 12.0) -> dict:
            out = os.path.join(tempfile.mkdtemp(), "huge.png")
            with open(out, "wb") as f:
                f.write(b"\x00" * (3100 * 1024))  # incompressible, safely > 3000 KB
            return {"ok": True, "path": out}

        monkeypatch.setattr(pv, "client_call", fake_client_call)

        import app.agent as agent

        async def fake_describe(target: str) -> str:
            return "described fallback"

        monkeypatch.setattr(agent, "describe_image", fake_describe)
        try:
            result = asyncio.run(
                execute_tool(
                    str(tmp_path),
                    {"tool": "preview_screenshot", "args": {}},
                    True,
                    extra={"use_vision_model": True},
                )
            )
            assert result["ok"] is True
            assert "imageData" not in result
            assert "described fallback" in result["output"]
        finally:
            pv.stop_preview()


class TestScreenshotReachesModelOnly:
    """End-to-end: preview_start → preview_screenshot with a vision-capable
    code model. The image must reach the MODEL message stream but NOT the
    client-visible onToolResult output or the saved resume state."""

    def test_image_lands_in_model_stream_only(self, tmp_path, monkeypatch):
        import app.agent as agent
        import app.preview as pv

        capabilities._caps_cache["fake-model"] = {"tools": True, "thinking": False, "vision": True}
        (tmp_path / "index.html").write_text("<html><body>game</body></html>", encoding="utf-8")

        async def fake_client_call(payload: dict, timeout: float = 12.0) -> dict:
            if payload.get("type") == "open":
                pv.get_preview_session().window_registered.set()
                return {"ok": True}
            if payload.get("type") == "capture":
                out = os.path.join(tempfile.mkdtemp(), "shot.png")
                with open(out, "wb") as f:
                    f.write(RED_PNG)
                return {"ok": True, "path": out}
            return {"ok": True}

        scripted = [
            json.dumps({"tool": "preview_start", "args": {"entry": "index.html"}}),
            json.dumps({"tool": "preview_screenshot", "args": {}}),
            "The page renders correctly. Task complete.",
        ]
        client_outputs: list[str] = []
        counter = {"n": 0}
        captured: dict = {}

        async def fake_stream(opts, messages, on_chunk, on_thinking_chunk, **kw):
            counter["n"] += 1
            resp = scripted[counter["n"] - 1] if counter["n"] <= len(scripted) else "Done."
            on_chunk(resp)
            return resp

        original_stream = agent.stream_chat_with_retry
        original_call = pv.client_call

        def on_tool_result(r: dict) -> None:
            client_outputs.append(str(r.get("output") or ""))

        def on_resume_state(state: dict) -> None:
            captured["resume"] = state

        agent.stream_chat_with_retry = fake_stream
        pv.client_call = fake_client_call
        try:
            asyncio.run(
                run_agent_loop(
                    {
                        "model": "fake-model",
                        "workspacePath": str(tmp_path),
                        "autoApply": True,
                        "messages": [{"role": "user", "content": "make a web game and verify it"}],
                        "callbacks": {
                            "onChunk": lambda *_: None,
                            "onToolResult": on_tool_result,
                            "onResumeState": on_resume_state,
                        },
                    }
                )
            )
        finally:
            agent.stream_chat_with_retry = original_stream
            pv.client_call = original_call
            pv.stop_preview()

        assert counter["n"] == 3, f"run ended early after {counter['n']} rounds"

        # The marker converts to a proper Ollama image message for the MODEL
        marker_msg = {
            "role": "user",
            "content": f"[TOOL RESULT — preview_screenshot]\nok\n\n[image:data:image/png;base64,{RED_PNG_B64}]",
        }
        converted = convert_messages_for_ollama([marker_msg])
        assert converted[0].get("images") == [RED_PNG_B64]
        assert "[image:" not in converted[0]["content"]

        # NOT in the client-visible tool result
        assert all("[image:" not in o for o in client_outputs), client_outputs

        # NOT in the saved resume state
        resume_history = captured.get("resume", {}).get("history", [])
        assert all("[image:" not in m.get("content", "") for m in resume_history)


class TestCacheStaleness:
    def test_old_cache_version_is_cleared(self, tmp_path):
        cache_file = os.path.join(_TMP, "model-capabilities.json")
        with open(cache_file, "w", encoding="utf-8") as f:
            json.dump({"version": 3, "models": {"qwen3:8b": {"tools": True, "thinking": True}}}, f)
        capabilities._caps_cache.clear()
        capabilities._cache_loaded = False  # simulate a fresh process load
        try:
            asyncio.run(capabilities.load_cache())
            # v3 < CACHE_VERSION(4) → entries discarded, re-probed lazily
            assert "qwen3:8b" not in capabilities._caps_cache
        finally:
            capabilities._cache_loaded = True
