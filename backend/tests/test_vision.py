"""Vision capability detection and cache compatibility."""

from __future__ import annotations

import asyncio
import json
import os
import tempfile

import pytest

# Isolated data dir BEFORE importing app modules (pattern of test_api.py).
_TMP = tempfile.mkdtemp(prefix="kasalix-vision-")
os.environ.setdefault("DATA_DIR", _TMP)
os.environ.setdefault("OLLAMA_URL", "http://127.0.0.1:9")

import app.capabilities as capabilities  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_caps_cache():
    capabilities._caps_cache.clear()
    capabilities._cache_loaded = True  # never touch the dev machine's real cache
    yield
    capabilities._caps_cache.clear()


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
