"""Capability detection and the requests that depend on it.

The bug this locks down: the tools probe sent `"tools": []`, and Ollama only
validates tool support when the array is NON-empty — so every model was cached
as tools=True. Chat mode then attached real tool definitions to every request,
and a model like deepseek-v2:16b (whose template has no tool support) answered
`400 ... does not support tools`. The user lost the whole reply (an empty
"cut off" message) and, because the error text contained "Ollama error", the
client claimed the CLOUD provider was unavailable and that it was "falling back
to local models" — while already running local models.
"""

import asyncio

import app.capabilities as capabilities
import app.ollama_client as oc
from app.ollama_client import OllamaError, StreamOptions, stream_chat_with_tools
from app.routes.chat import looks_like_cloud_failure


class FakeResponse:
    def __init__(self, status_code: int, payload: dict | None, text: str = "") -> None:
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text or ("" if status_code < 400 else "error")

    def json(self) -> dict:
        return self._payload


class FakeOllama:
    """Canned /api/chat responses, keyed by which optional field the request used.

    Real Ollama only rejects `tools` when the array is non-empty — this fake
    reproduces that check, which is exactly what the old probe got wrong.
    """

    def __init__(self, thinking_status=200, thinking_payload=None, tools_status=200, tools_payload=None) -> None:
        self.thinking = (thinking_status, thinking_payload)
        self.tools = (tools_status, tools_payload)
        self.requests: list[dict] = []

    def __call__(self, *args, **kwargs):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args) -> bool:
        return False

    async def post(self, url, json=None, **kwargs):
        body = json or {}
        self.requests.append(body)
        if body.get("tools"):
            status, payload = self.tools
            text = ""
            if status == 400:
                text = "registry.ollama.ai/library/deepseek-v2:16b does not support tools"
            elif status >= 400:
                text = "model runner has crashed"
            return FakeResponse(status, payload, text=text)
        if body.get("think"):
            status, payload = self.thinking
            text = ""
            if status == 400:
                text = '"deepseek-v2:16b" does not support thinking'
            elif status >= 400:
                text = "model runner has crashed"
            return FakeResponse(status, payload, text=text)
        return FakeResponse(200, {"message": {"content": "ok"}})


def _patch_ollama(monkeypatch, fake: FakeOllama) -> FakeOllama:
    monkeypatch.setattr(capabilities.httpx, "AsyncClient", fake)
    return fake


def _fresh_cache(monkeypatch, tmp_path):
    monkeypatch.setattr(capabilities, "_cache_file", lambda: str(tmp_path / "caps.json"))
    monkeypatch.setattr(capabilities, "_caps_cache", {})
    return monkeypatch


class TestToolsProbe:
    def test_probe_sends_a_real_tool_not_an_empty_array(self, monkeypatch):
        # An empty array is accepted by EVERY model, which is how deepseek-v2 got
        # cached as tools=True while rejecting every real tool definition.
        fake = _patch_ollama(monkeypatch, FakeOllama(tools_status=400))
        asyncio.run(capabilities._probe_tools("deepseek-v2:16b"))
        assert fake.requests, "probe made no request"
        assert fake.requests[0].get("tools"), "probe must send at least one tool"

    def test_probe_reports_false_when_the_model_rejects_tools(self, monkeypatch):
        _patch_ollama(monkeypatch, FakeOllama(tools_status=400))
        assert asyncio.run(capabilities._probe_tools("deepseek-v2:16b")) is False

    def test_probe_reports_true_when_tools_are_accepted(self, monkeypatch):
        _patch_ollama(monkeypatch, FakeOllama(tools_status=200, tools_payload={"message": {"content": "ok"}}))
        assert asyncio.run(capabilities._probe_tools("qwen3.5:9b")) is True

    def test_probe_reports_unknown_for_a_model_that_is_not_installed(self, monkeypatch):
        class NotFound(FakeOllama):
            async def post(self, url, json=None, **kwargs):
                return FakeResponse(404, {"error": "model not found"})

        _patch_ollama(monkeypatch, NotFound())
        assert asyncio.run(capabilities._probe_tools("ghost:1b")) is None


class TestThinkingProbe:
    def test_hard_rejection_is_a_definitive_no(self, monkeypatch):
        _patch_ollama(monkeypatch, FakeOllama(thinking_status=400))
        assert asyncio.run(capabilities._probe_thinking("deepseek-v2:16b")) is False

    def test_other_errors_are_unknown_not_a_no(self, monkeypatch):
        _patch_ollama(monkeypatch, FakeOllama(thinking_status=500))
        assert asyncio.run(capabilities._probe_thinking("qwen3:8b")) is None

    def test_a_thinking_field_means_yes(self, monkeypatch):
        _patch_ollama(monkeypatch, FakeOllama(thinking_payload={"message": {"thinking": "hmm"}}))
        assert asyncio.run(capabilities._probe_thinking("qwen3:8b")) is True

    def test_200_without_a_field_is_unknown(self, monkeypatch):
        # Thinking that arrives as <think> tags leaves no field to detect.
        _patch_ollama(monkeypatch, FakeOllama(thinking_payload={"message": {"content": "4"}}))
        assert asyncio.run(capabilities._probe_thinking("qwen3:8b")) is None


class TestCapabilityResolution:
    def test_probe_no_beats_the_name_fallback(self, monkeypatch, tmp_path):
        # "qwen2.5-coder:7b" used to match the bare "qwen" name heuristic, so it
        # was cached as thinking-capable even though Ollama refuses `think` on
        # it — every reply then died with a 400.
        _fresh_cache(monkeypatch, tmp_path)
        _patch_ollama(monkeypatch, FakeOllama(thinking_status=400, tools_status=400))
        caps = asyncio.run(capabilities.get_model_capabilities("qwen2.5-coder:7b"))
        assert caps["thinking"] is False
        assert caps["tools"] is False

    def test_name_fallback_still_covers_unknown_probes(self, monkeypatch, tmp_path):
        _fresh_cache(monkeypatch, tmp_path)

        class Unreachable(FakeOllama):
            async def post(self, url, json=None, **kwargs):
                raise ConnectionError("ollama is down")

        _patch_ollama(monkeypatch, Unreachable())
        caps = asyncio.run(capabilities.get_model_capabilities("qwen3:8b"))
        assert caps["thinking"] is True  # name heuristic only when the probe is blind
        assert caps["tools"] is True

    def test_bare_qwen_is_no_longer_a_thinking_family(self):
        assert capabilities._fallback_thinking("qwen3:8b") is True
        assert capabilities._fallback_thinking("qwen2.5-coder:7b") is False
        assert capabilities._fallback_thinking("qwen2.5:14b") is False

    def test_bogus_v4_cache_entries_are_not_loaded(self, monkeypatch, tmp_path):
        # The old cache is full of tools=True entries that were never true.
        path = tmp_path / "caps.json"
        path.write_text(
            '{"version": 4, "models": {"deepseek-v2:16b": {"tools": true, "thinking": false, "vision": false}}}',
            encoding="utf-8",
        )
        monkeypatch.setattr(capabilities, "_cache_file", lambda: str(path))
        monkeypatch.setattr(capabilities, "_caps_cache", {})
        monkeypatch.setattr(capabilities, "_cache_loaded", False)
        asyncio.run(capabilities.load_cache())
        assert capabilities._caps_cache == {}, "a stale-probe cache must be re-probed"

    def test_current_version_cache_is_loaded(self, monkeypatch, tmp_path):
        path = tmp_path / "caps.json"
        path.write_text(
            '{"version": %d, "models": {"deepseek-v2:16b": {"tools": false, "thinking": false, "vision": false}}}'
            % capabilities.CACHE_VERSION,
            encoding="utf-8",
        )
        monkeypatch.setattr(capabilities, "_cache_file", lambda: str(path))
        monkeypatch.setattr(capabilities, "_caps_cache", {})
        monkeypatch.setattr(capabilities, "_cache_loaded", False)
        asyncio.run(capabilities.load_cache())
        assert capabilities._caps_cache["deepseek-v2:16b"]["tools"] is False

    def test_mark_tools_unsupported_persists_a_full_entry(self, monkeypatch, tmp_path):
        _fresh_cache(monkeypatch, tmp_path)
        monkeypatch.setattr(capabilities, "save_cache", lambda: asyncio.sleep(0))
        asyncio.run(capabilities.mark_tools_unsupported("deepseek-v2:16b"))
        entry = capabilities._caps_cache["deepseek-v2:16b"]
        assert entry["tools"] is False
        assert "thinking" in entry and "vision" in entry


class TestToolsAreNotSentToModelsThatRejectThem:
    def test_tools_are_dropped_upfront_for_a_model_without_tool_support(self, monkeypatch, tmp_path):
        _fresh_cache(monkeypatch, tmp_path)
        monkeypatch.setattr(capabilities, "save_cache", lambda: asyncio.sleep(0))
        sent: list[dict] = []

        async def fake_stream(endpoint, body, opts, log_line, on_chunk, collect_tool_calls):
            sent.append(dict(body))
            return "hello", [], {}

        monkeypatch.setattr(oc, "_stream_response", fake_stream)

        async def no_tools(model):
            return False

        async def no_think(model):
            return False

        monkeypatch.setattr(oc, "supports_tools", no_tools)
        monkeypatch.setattr(oc, "supports_thinking", no_think)
        result = asyncio.run(
            stream_chat_with_tools("deepseek-v2:16b", [{"role": "user", "content": "hi"}], [{"type": "function"}], None, StreamOptions())
        )
        assert result["content"] == "hello"
        assert len(sent) == 1 and "tools" not in sent[0], "tools must not be sent to a model that rejects them"

    def test_a_rejected_tool_request_is_retried_without_tools(self, monkeypatch, tmp_path):
        _fresh_cache(monkeypatch, tmp_path)
        monkeypatch.setattr(capabilities, "save_cache", lambda: asyncio.sleep(0))
        sent: list[dict] = []

        async def fake_stream(endpoint, body, opts, log_line, on_chunk, collect_tool_calls):
            sent.append(dict(body))
            if body.get("tools"):
                raise OllamaError("Ollama error (400): registry.ollama.ai/library/deepseek-v2:16b does not support tools")
            return "the answer", [], {}

        monkeypatch.setattr(oc, "_stream_response", fake_stream)

        async def yes_tools(model):
            return True

        monkeypatch.setattr(oc, "supports_tools", yes_tools)

        async def no_think(model):
            return False

        monkeypatch.setattr(oc, "supports_thinking", no_think)
        result = asyncio.run(
            stream_chat_with_tools("deepseek-v2:16b", [{"role": "user", "content": "hi"}], [{"type": "function"}], None, StreamOptions())
        )
        assert result["content"] == "the answer", "the reply must survive a rejected tool request"
        assert len(sent) == 2 and "tools" in sent[0] and "tools" not in sent[1]
        assert capabilities._caps_cache["deepseek-v2:16b"]["tools"] is False, "the cache must learn from the rejection"

    def test_unrelated_errors_are_not_swallowed(self, monkeypatch, tmp_path):
        _fresh_cache(monkeypatch, tmp_path)
        calls = {"n": 0}

        async def fake_stream(endpoint, body, opts, log_line, on_chunk, collect_tool_calls):
            calls["n"] += 1
            raise OllamaError("Ollama error (500): model runner crashed")

        monkeypatch.setattr(oc, "_stream_response", fake_stream)
        for name, value in (("supports_tools", True), ("supports_thinking", False)):
            async def fn(model, _v=value):
                return _v

            monkeypatch.setattr(oc, name, fn)
        try:
            asyncio.run(
                stream_chat_with_tools("qwen3:8b", [{"role": "user", "content": "hi"}], [{"type": "function"}], None, StreamOptions())
            )
            raise AssertionError("the error should have propagated")
        except OllamaError as e:
            assert "runner crashed" in str(e)
        assert calls["n"] == 1, "a non-capability error must not be retried"


class TestCloudFailureClassification:
    def test_a_local_capability_error_is_not_a_cloud_failure(self):
        message = "Ollama error (400): registry.ollama.ai/library/deepseek-v2:16b does not support tools"
        assert looks_like_cloud_failure(message) is False

    def test_a_plain_local_ollama_error_is_not_a_cloud_failure(self):
        assert looks_like_cloud_failure("Ollama error (500): model runner has crashed") is False

    def test_real_cloud_problems_still_count(self):
        assert looks_like_cloud_failure("cloud auth rejected (401) — API key invalid, expired or revoked") is True
        assert looks_like_cloud_failure("getaddrinfo failed for api.ollama.com") is True
        assert looks_like_cloud_failure("Cloud mode is enabled but no API key is configured") is True
