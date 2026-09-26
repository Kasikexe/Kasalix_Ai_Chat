"""Stream degeneration guard tests.

Covers the "thinking repeats the same phrase forever" failure mode on small
local models (e.g. qwen3-abliterated:8b planning out loud in a loop): the
stream reader must detect the repetition and abort early instead of burning
the full context window at tok/s speed.
"""

import asyncio
import json

import pytest

from app.ollama_client import (
    GenerationRepetitionError,
    StreamOptions,
    _looks_degenerate,
    _stream_response,
)


# ─── Detector accuracy ──────────────────────────────────────────────────
class TestLooksDegenerate:
    def test_identical_line_repeated_many_times(self):
        text = "so Lets do the index.html\n" * 60
        assert _looks_degenerate(text) is True

    def test_same_phrase_prefix_repeated_many_times(self):
        # Varying suffix, same opening — the "user wants game in html so
        # Lets do the index.html" pattern.
        text = "\n".join(
            f"user wants game in html so Lets do the index.html step {i}" for i in range(60)
        )
        assert _looks_degenerate(text) is True

    def test_duplicated_block_back_to_back(self):
        block = "We need to create three files: index.html, style.css and script.js. " * 20
        assert len(block) >= 1200
        assert _looks_degenerate(block + block) is True

    def test_normal_thinking_is_not_flagged(self):
        # Varied, coherent reasoning of similar length — must NOT trip.
        parts = []
        for i in range(60):
            parts.append(
                f"Step {i}: first I check the file structure, then I decide whether the "
                f"movement logic belongs in script.js or index.html, and whether the "
                f"grid should be drawn with CSS or canvas elements instead."
            )
        assert _looks_degenerate("\n".join(parts)) is False

    def test_normal_code_output_is_not_flagged(self):
        code = "\n".join(f"const item{i} = document.createElement('div');" for i in range(60))
        assert _looks_degenerate(code) is False

    def test_short_text_never_flagged(self):
        assert _looks_degenerate("hello world " * 10) is False

    def test_one_repeated_word_but_varied_lines_is_fine(self):
        # A common word on every line but different sentences — not a loop.
        lines = [
            f"the function number {i} handles input edge case {i} with validation {i}"
            for i in range(60)
        ]
        assert _looks_degenerate("\n".join(lines)) is False


# ─── End-to-end: degenerating stream aborts ─────────────────────────────
def _fake_stream_body(lines: list[str]) -> dict:
    """Build an Ollama NDJSON body with the given thinking lines."""
    return {
        "model": "m",
        "messages": [{"role": "user", "content": "hi"}],
        "stream": True,
    }, None  # body unused by the monkeypatched transport below


class TestStreamAbort:
    def test_degenerating_thinking_stream_raises(self, monkeypatch):
        """A stream whose thinking repeats one phrase forever must raise
        GenerationRepetitionError quickly instead of consuming the whole
        context window."""
        import app.ollama_client as oc

        phrase = "user wants game in html so Lets do the index.html"
        chunks = [json.dumps({"message": {"role": "assistant", "thinking": phrase}, "done": False})] * 300
        chunks.append(json.dumps({"message": {"role": "assistant", "content": ""}, "done": True}))

        class FakeRes:
            status_code = 200
            reason_phrase = "OK"

            async def aread(self):
                return b""

            async def aiter_text(self):
                for c in chunks:
                    yield c + "\n"

        class FakeClientCtx:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

            def stream(self, *a, **kw):
                return FakeStreamCtx()

        class FakeStreamCtx:
            async def __aenter__(self):
                return FakeRes()

            async def __aexit__(self, *a):
                return False

        class FakeAsyncClient:
            def __init__(self, *a, **kw):
                pass

            async def __aenter__(self):
                return self

            async def __aexit__(self, *a):
                return False

            def stream(self, *a, **kw):
                return FakeStreamCtx()

        monkeypatch.setattr(oc.httpx, "AsyncClient", FakeAsyncClient)

        got: list[str] = []
        with pytest.raises(GenerationRepetitionError):
            asyncio.run(
                _stream_response(
                    "http://localhost:11434",
                    {"model": "m", "messages": [], "stream": True},
                    StreamOptions(),
                    "[ollama] test",
                    got.append,
                    False,
                )
            )
        # Aborted early — far fewer thinking chunks than the 300 fed in.
        assert len(got) < 120

    def test_is_transient_error_rejects_degeneration(self):
        from app.agent import is_transient_error

        err = GenerationRepetitionError("The model got stuck repeating itself (degeneration).")
        assert is_transient_error(err) is False


# ─── Local model backend unreachable ────────────────────────────────────
class TestLocalBackendUnreachable:
    """The "server reachable but sends fail" state after a server restart:
    the backend answers /api/health while Ollama is down, and httpx's raw
    "All connection attempts failed" told the user nothing about what broke."""

    def test_local_connect_failure_names_the_model_backend(self):
        from app.ollama_client import OllamaError

        with pytest.raises(OllamaError) as err:
            asyncio.run(
                _stream_response(
                    "http://127.0.0.1:9",
                    {"model": "m", "messages": [], "stream": True},
                    StreamOptions(),
                    "[ollama] test",
                    None,
                    False,
                )
            )
        message = str(err.value)
        assert "model backend (Ollama) is not answering" in message
        assert "127.0.0.1:9" in message
        assert "starting after a server restart" in message

    def test_a_custom_endpoint_keeps_its_own_transport_error(self):
        """A cloud endpoint's own error is more useful than our wording."""
        import httpx

        with pytest.raises(httpx.TransportError):
            asyncio.run(
                _stream_response(
                    "http://127.0.0.1:9",
                    {"model": "m", "messages": [], "stream": True},
                    StreamOptions(base_url="http://127.0.0.1:9"),
                    "[ollama] test",
                    None,
                    False,
                )
            )
