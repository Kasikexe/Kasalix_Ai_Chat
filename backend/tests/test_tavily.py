"""Tavily web search — client, key verification, and the provider fallback chain.

The fake Tavily server below reproduces the documented contract: a bearer key is
required (401 otherwise), success returns ``results[].content`` snippets plus an
optional ``answer``, and the failure modes are 429 (rate), 432 (monthly credits
exhausted) and 500. It also lets us assert the REQUEST shape, which is the part
a fake cannot otherwise prove.
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
_TMP = tempfile.mkdtemp(prefix="kasalix-tavily-test-")
os.environ["DATA_DIR"] = _TMP
os.environ["OLLAMA_URL"] = "http://127.0.0.1:9"  # unreachable — no accidental Ollama use

from app import search, tavily  # noqa: E402
from app.main import app  # noqa: E402
from app.settings_store import get_tavily_api_key  # noqa: E402

GOOD_KEY = "tvly-good-key"

TAVILY_OK = {
    "query": "who is leo messi",
    "answer": "Lionel Messi is an Argentine footballer.",
    "results": [
        {
            "title": "Lionel Messi Facts",
            "url": "https://example.com/messi",
            "content": "Messi spent most of his career at Barcelona.",
            "score": 0.81,
            "published_date": "Tue, 11 Mar 2025 17:00:00 GMT",
        },
        {
            "title": "Messi profile",
            "url": "https://example.org/messi",
            "content": "He won eight Ballon d'Or awards.",
            "score": 0.72,
            "published_date": "",
        },
    ],
    "response_time": 1.23,
    "usage": {"credits": 1},
}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(autouse=True)
def baseline(client):
    """Keep the shared DATA_DIR clean before and after every test."""
    def _reset():
        r = client.put(
            "/api/settings",
            json={"tavilyApiKey": ""},
            headers={"Cookie": "settings_auth=1"},
        )
        assert r.status_code == 200, r.text

    _reset()
    yield
    _reset()


# ─── Fake Tavily endpoint ───────────────────────────────────────────────────


@contextlib.contextmanager
def serve_tavily(responder, bearer: str = f"Bearer {GOOD_KEY}"):
    """Serve a fake Tavily /search endpoint and record the requests it saw.

    ``responder(body) -> (status, payload)``; return raw bytes as payload to
    simulate a non-JSON response.
    """
    seen: list[dict] = []

    class Handler(BaseHTTPRequestHandler):
        # HTTP/1.1 + drained request bodies: replying while the client is still
        # writing makes Windows reset the connection (see test_cloud_key.py).
        protocol_version = "HTTP/1.1"

        def log_message(self, *args):  # keep pytest output clean
            pass

        def _send_raw(self, status: int, body: bytes, content_type: str = "application/json"):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):  # noqa: N802 — BaseHTTPRequestHandler API
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except (TypeError, ValueError):
                length = 0
            raw = self.rfile.read(length) if length > 0 else b""
            seen.append(
                {
                    "path": self.path,
                    "authorization": self.headers.get("Authorization", ""),
                    "body": json.loads(raw or b"{}"),
                }
            )
            if self.path != "/search":
                self._send_raw(404, b'{"detail":{"error":"not found"}}')
                return
            if self.headers.get("Authorization", "") != bearer:
                self._send_raw(
                    401,
                    b'{"detail":{"error":"Unauthorized: missing or invalid API key."}}',
                )
                return
            status, payload = responder(json.loads(raw or b"{}"))
            if isinstance(payload, (bytes, str)):
                self._send_raw(status, payload if isinstance(payload, bytes) else payload.encode())
            else:
                self._send_raw(status, json.dumps(payload).encode())

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_address[1]}", seen
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def _ok_responder(_body):
    return 200, TAVILY_OK


# ─── Client ─────────────────────────────────────────────────────────────────


class TestTavilyClient:
    def test_request_shape_matches_the_documented_api(self, monkeypatch):
        with serve_tavily(_ok_responder) as (endpoint, seen):
            monkeypatch.setattr(tavily, "TAVILY_SEARCH_URL", f"{endpoint}/search")
            asyncio.run(tavily.search("who is leo messi", GOOD_KEY))
        assert len(seen) == 1
        request = seen[0]
        assert request["path"] == "/search"
        assert request["authorization"] == f"Bearer {GOOD_KEY}"
        body = request["body"]
        assert body["query"] == "who is leo messi"
        assert body["search_depth"] == "basic"
        assert 1 <= body["chunks_per_source"] <= 3
        assert 0 <= body["max_results"] <= 20
        assert body["include_answer"] is True

    def test_parses_results_answer_and_credits(self, monkeypatch):
        with serve_tavily(_ok_responder) as (endpoint, _seen):
            monkeypatch.setattr(tavily, "TAVILY_SEARCH_URL", f"{endpoint}/search")
            data = asyncio.run(tavily.search("who is leo messi", GOOD_KEY))
        assert data["answer"] == "Lionel Messi is an Argentine footballer."
        assert data["credits"] == 1
        assert [r["url"] for r in data["results"]] == [
            "https://example.com/messi",
            "https://example.org/messi",
        ]
        assert data["results"][0]["content"].startswith("Messi spent")
        assert data["results"][0]["publishedDate"].startswith("Tue, 11 Mar 2025")

    def test_results_without_urls_are_dropped(self, monkeypatch):
        def responder(_body):
            return 200, {
                "results": [
                    {"title": "no url", "content": "dropped"},
                    {"title": "kept", "url": "https://example.com/kept", "content": "kept"},
                ]
            }

        with serve_tavily(responder) as (endpoint, _seen):
            monkeypatch.setattr(tavily, "TAVILY_SEARCH_URL", f"{endpoint}/search")
            data = asyncio.run(tavily.search("q", GOOD_KEY))
        assert len(data["results"]) == 1
        assert data["results"][0]["url"] == "https://example.com/kept"

    def test_empty_key_raises_key_error(self):
        with pytest.raises(tavily.TavilyError) as err:
            asyncio.run(tavily.search("q", "   "))
        assert err.value.kind == "key"

    @pytest.mark.parametrize(
        "status,payload,expected_kind",
        [
            (401, {"detail": {"error": "Unauthorized: missing or invalid API key."}}, "auth"),
            (429, {"detail": {"error": "excessive requests"}}, "rate"),
            (432, {"detail": {"error": "This request exceeds your plan's set usage limit."}}, "quota"),
            (500, {"detail": {"error": "Internal Server Error"}}, "service"),
            (400, {"detail": [{"loc": ["body", "query"], "msg": "Input should be a valid string"}]}, "service"),
        ],
    )
    def test_http_errors_are_classified(self, monkeypatch, status, payload, expected_kind):
        def responder(_body):
            return status, payload

        with serve_tavily(responder) as (endpoint, _seen):
            monkeypatch.setattr(tavily, "TAVILY_SEARCH_URL", f"{endpoint}/search")
            with pytest.raises(tavily.TavilyError) as err:
                asyncio.run(tavily.search("q", GOOD_KEY))
        assert err.value.kind == expected_kind
        assert err.value.status == status
        # The detail Tavily sent must reach the user, not a generic message.
        assert str(err.value)

    def test_non_json_error_body_still_classifies(self, monkeypatch):
        def responder(_body):
            return 503, b"<html>service unavailable</html>"

        with serve_tavily(responder) as (endpoint, _seen):
            monkeypatch.setattr(tavily, "TAVILY_SEARCH_URL", f"{endpoint}/search")
            with pytest.raises(tavily.TavilyError) as err:
                asyncio.run(tavily.search("q", GOOD_KEY))
        assert err.value.kind == "service"
        assert err.value.status == 503

    def test_unreachable_endpoint_is_an_endpoint_error(self, monkeypatch):
        monkeypatch.setattr(tavily, "TAVILY_SEARCH_URL", "http://127.0.0.1:9/search")
        with pytest.raises(tavily.TavilyError) as err:
            asyncio.run(tavily.search("q", GOOD_KEY, timeout=2.0))
        assert err.value.kind == "endpoint"
        assert "Cannot reach Tavily" in str(err.value)


# ─── Key verification probe ─────────────────────────────────────────────────


class TestVerifyTavilyKey:
    def test_valid_key(self, monkeypatch):
        with serve_tavily(_ok_responder) as (endpoint, seen):
            monkeypatch.setattr(tavily, "TAVILY_SEARCH_URL", f"{endpoint}/search")
            result = asyncio.run(tavily.verify_api_key(GOOD_KEY))
        assert result["ok"] is True
        assert result["status"] == 200
        assert result["credits"] == 1
        assert result["resultCount"] == 2
        # The probe must be the cheapest search Tavily offers.
        assert seen[0]["body"]["search_depth"] == "ultra-fast"
        assert seen[0]["body"]["max_results"] == 1
        assert seen[0]["body"]["include_answer"] is False

    def test_missing_key_does_not_spend_a_credit(self, monkeypatch):
        with serve_tavily(_ok_responder) as (endpoint, seen):
            monkeypatch.setattr(tavily, "TAVILY_SEARCH_URL", f"{endpoint}/search")
            result = asyncio.run(tavily.verify_api_key("  "))
        assert result["ok"] is False
        assert result["kind"] == "key"
        assert seen == []

    def test_bad_key_reports_auth_failure(self, monkeypatch):
        with serve_tavily(_ok_responder) as (endpoint, _seen):
            monkeypatch.setattr(tavily, "TAVILY_SEARCH_URL", f"{endpoint}/search")
            result = asyncio.run(tavily.verify_api_key("tvly-wrong"))
        assert result["ok"] is False
        assert result["kind"] == "auth"
        assert result["status"] == 401

    def test_quota_exhausted_is_reported_clearly(self, monkeypatch):
        def responder(_body):
            return 432, {"detail": {"error": "This request exceeds your plan's set usage limit."}}

        with serve_tavily(responder) as (endpoint, _seen):
            monkeypatch.setattr(tavily, "TAVILY_SEARCH_URL", f"{endpoint}/search")
            result = asyncio.run(tavily.verify_api_key(GOOD_KEY))
        assert result["ok"] is False
        assert result["kind"] == "quota"
        assert "usage limit" in result["message"]


# ─── Route ──────────────────────────────────────────────────────────────────


class TestTestTavilyKeyRoute:
    def _post(self, client, payload):
        r = client.post(
            "/api/settings/test-tavily-key",
            json=payload,
            headers={"Cookie": "settings_auth=1"},
        )
        assert r.status_code == 200, r.text
        return r.json()

    def test_verifies_the_posted_key(self, client, monkeypatch):
        with serve_tavily(_ok_responder) as (endpoint, _seen):
            monkeypatch.setattr(tavily, "TAVILY_SEARCH_URL", f"{endpoint}/search")
            body = self._post(client, {"tavilyApiKey": GOOD_KEY})
        assert body["ok"] is True, body

    def test_falls_back_to_the_saved_key(self, client, monkeypatch):
        with serve_tavily(_ok_responder) as (endpoint, _seen):
            monkeypatch.setattr(tavily, "TAVILY_SEARCH_URL", f"{endpoint}/search")
            r = client.put(
                "/api/settings",
                json={"tavilyApiKey": GOOD_KEY},
                headers={"Cookie": "settings_auth=1"},
            )
            assert r.json()["tavilyApiKey"] == GOOD_KEY
            body = self._post(client, {})
        assert body["ok"] is True, body

    def test_reports_missing_key(self, client):
        body = self._post(client, {})
        assert body["ok"] is False
        assert body["kind"] == "key"

    def test_testing_does_not_save_the_key(self, client, monkeypatch):
        with serve_tavily(_ok_responder) as (endpoint, _seen):
            monkeypatch.setattr(tavily, "TAVILY_SEARCH_URL", f"{endpoint}/search")
            assert self._post(client, {"tavilyApiKey": GOOD_KEY})["ok"] is True
            saved = client.get("/api/settings").json()
        assert saved["tavilyApiKey"] == ""


# ─── Search provider chain ──────────────────────────────────────────────────


def _stub_duckduckgo(monkeypatch, calls: dict):
    async def fake_duck(query, max_results=5):
        calls["duck"] = query
        return [
            {"title": "DDG result", "url": "https://ddg.example/1", "snippet": "scraped snippet"}
        ]

    async def fake_page(url, max_chars=4000):
        calls.setdefault("pages", []).append(url)
        return "scraped page content"

    monkeypatch.setattr(search, "_duck_search", fake_duck)
    monkeypatch.setattr(search, "_fetch_page_content", fake_page)


class TestProviderChain:
    def test_uses_tavily_and_skips_the_scraper(self, monkeypatch):
        calls: dict = {}
        _stub_duckduckgo(monkeypatch, calls)

        async def fake_key():
            return GOOD_KEY

        monkeypatch.setattr("app.settings_store.get_tavily_api_key", fake_key)
        with serve_tavily(_ok_responder) as (endpoint, _seen):
            monkeypatch.setattr(tavily, "TAVILY_SEARCH_URL", f"{endpoint}/search")
            source, results, answer, pages = asyncio.run(search._gather_web_results("who is leo messi"))

        assert source == "tavily"
        assert len(results) == 2
        assert answer == "Lionel Messi is an Argentine footballer."
        # Tavily snippets already carry page content — no scraping at all.
        assert pages == []
        assert "duck" not in calls

    def test_falls_back_to_the_scraper_without_a_key(self, monkeypatch):
        calls: dict = {}
        _stub_duckduckgo(monkeypatch, calls)

        async def no_key():
            return ""

        monkeypatch.setattr("app.settings_store.get_tavily_api_key", no_key)
        source, results, answer, pages = asyncio.run(search._gather_web_results("q"))

        assert source == "duckduckgo"
        assert results[0]["snippet"] == "scraped snippet"
        assert answer is None
        assert calls["duck"] == "q"
        assert calls["pages"] == ["https://ddg.example/1"]

    @pytest.mark.parametrize(
        "status",
        [401, 429, 432, 500],
    )
    def test_falls_back_when_tavily_fails(self, monkeypatch, status):
        calls: dict = {}
        _stub_duckduckgo(monkeypatch, calls)

        async def fake_key():
            return GOOD_KEY

        def responder(_body):
            return status, {"detail": {"error": "nope"}}

        monkeypatch.setattr("app.settings_store.get_tavily_api_key", fake_key)
        with serve_tavily(responder) as (endpoint, _seen):
            monkeypatch.setattr(tavily, "TAVILY_SEARCH_URL", f"{endpoint}/search")
            source, results, _answer, _pages = asyncio.run(
                search._gather_web_results("q")
            )

        assert source == "duckduckgo"
        assert results

    def test_falls_back_when_tavily_returns_nothing(self, monkeypatch):
        calls: dict = {}
        _stub_duckduckgo(monkeypatch, calls)

        async def fake_key():
            return GOOD_KEY

        def responder(_body):
            return 200, {"results": [], "answer": None}

        monkeypatch.setattr("app.settings_store.get_tavily_api_key", fake_key)
        with serve_tavily(responder) as (endpoint, _seen):
            monkeypatch.setattr(tavily, "TAVILY_SEARCH_URL", f"{endpoint}/search")
            source, results, _answer, _pages = asyncio.run(search._gather_web_results("q"))

        assert source == "duckduckgo"
        assert results

    def test_unreachable_tavily_falls_back(self, monkeypatch):
        calls: dict = {}
        _stub_duckduckgo(monkeypatch, calls)

        async def fake_key():
            return GOOD_KEY

        monkeypatch.setattr("app.settings_store.get_tavily_api_key", fake_key)
        monkeypatch.setattr(tavily, "TAVILY_SEARCH_URL", "http://127.0.0.1:9/search")
        source, results, _answer, _pages = asyncio.run(search._gather_web_results("q"))

        assert source == "duckduckgo"
        assert results


class TestGetWebContext:
    def _stub_summarizer(self, monkeypatch, summary: str = "SUMMARY"):
        captured: dict = {}

        async def fake_resolved(category):
            return {"model": "test-model", "source": "local"}

        async def fake_stream(model, messages, on_chunk, options):
            # stream_chat is awaited, so the stub must be a coroutine function.
            captured["prompt"] = messages[0]["content"]
            on_chunk(summary)
            return None

        monkeypatch.setattr(search, "get_resolved_model", fake_resolved)
        monkeypatch.setattr(search, "stream_chat", fake_stream)
        return captured

    def test_tavily_answer_reaches_the_summarizer(self, monkeypatch):
        captured = self._stub_summarizer(monkeypatch)

        async def fake_key():
            return GOOD_KEY

        monkeypatch.setattr("app.settings_store.get_tavily_api_key", fake_key)
        with serve_tavily(_ok_responder) as (endpoint, _seen):
            monkeypatch.setattr(tavily, "TAVILY_SEARCH_URL", f"{endpoint}/search")
            context = asyncio.run(search.get_web_context("who is leo messi"))

        assert context is not None
        prompt = captured["prompt"]
        # Tavily's synthesized answer is offered to the summarizer, labelled.
        assert "## Answer Summary" in prompt
        assert "Lionel Messi is an Argentine footballer." in prompt
        assert "https://example.com/messi" in prompt
        assert 'Web search results for "who is leo messi"' in context

    def test_refusal_is_still_treated_as_no_context(self, monkeypatch):
        self._stub_summarizer(monkeypatch, summary="I'm sorry, I can't help with that.")

        async def fake_key():
            return GOOD_KEY

        monkeypatch.setattr("app.settings_store.get_tavily_api_key", fake_key)
        with serve_tavily(_ok_responder) as (endpoint, _seen):
            monkeypatch.setattr(tavily, "TAVILY_SEARCH_URL", f"{endpoint}/search")
            assert asyncio.run(search.get_web_context("q")) is None

    def test_returns_none_when_every_provider_fails(self, monkeypatch):
        async def no_results(query, max_results=5):
            return []

        async def no_key():
            return ""

        monkeypatch.setattr(search, "_duck_search", no_results)
        monkeypatch.setattr("app.settings_store.get_tavily_api_key", no_key)
        assert asyncio.run(search.get_web_context("q")) is None


class TestAgentWebSearchUsesTavily:
    """End-to-end: the model asks to search, Tavily answers, the model sees it.

    This is the wiring that matters in practice — the agent's web_search tool
    goes through get_web_context, so this proves Tavily results actually reach
    the model rather than just that the client returns data.
    """

    def test_model_receives_tavily_results(self, tmp_path, monkeypatch):
        import app.agent as agent

        rounds: list[list[dict]] = []

        async def fake_model(opts, messages, on_chunk, on_thinking_chunk, **kw):
            rounds.append(messages)
            reply = (
                '{"tool": "web_search", "args": {"query": "who is leo messi"}}'
                if len(rounds) == 1
                else "Lionel Messi is an Argentine footballer (verified)."
            )
            on_chunk(reply)
            return reply

        async def fake_summary(model, messages, on_chunk, options):
            on_chunk("SUMMARY-MARKER: Messi spent most of his career at Barcelona.")
            return None

        async def fake_key():
            return GOOD_KEY

        async def ddg_must_not_run(query, max_results=5):
            raise AssertionError("DuckDuckGo was used even though Tavily is configured")

        monkeypatch.setattr(agent, "stream_chat_with_retry", fake_model)
        monkeypatch.setattr(search, "stream_chat", fake_summary)
        monkeypatch.setattr(search, "_duck_search", ddg_must_not_run)
        monkeypatch.setattr("app.settings_store.get_tavily_api_key", fake_key)

        with serve_tavily(_ok_responder) as (endpoint, seen):
            monkeypatch.setattr(tavily, "TAVILY_SEARCH_URL", f"{endpoint}/search")
            asyncio.run(
                agent.run_agent_loop(
                    {
                        "model": "fake-model",
                        "workspacePath": str(tmp_path),
                        "autoApply": False,
                        "messages": [
                            {"role": "user", "content": "who is leo messi? search the web"}
                        ],
                        "callbacks": {"onChunk": lambda *_: None},
                    }
                )
            )

        assert seen, "the agent never reached Tavily"
        assert seen[0]["body"]["query"] == "who is leo messi"
        assert len(rounds) >= 2, "the search result was never fed back to the model"
        fed_back = json.dumps(rounds[-1])
        # The summarised Tavily context must be what the model now sees.
        assert "SUMMARY-MARKER" in fed_back, fed_back[:2000]
        assert "WEB SEARCH RESULTS" in fed_back


# ─── Source reporting ───────────────────────────────────────────────────────
# The clients show the pages a search actually used underneath the answer.
# Searches start from several places (the pipeline's freshness heuristic, the
# agent's web_search tool, the chat-mode tool registry), so they all report to
# one per-run sink instead of each call site carrying the list itself.


class TestSourceReporting:
    def teardown_method(self):
        # A leaked sink would make an unrelated test look like it reported.
        search.set_source_sink(None)

    def test_reports_distinct_pages_with_titles(self):
        seen: list[list[dict[str, str]]] = []
        search.set_source_sink(seen.append)
        search.report_sources(
            [
                {"title": "A", "url": "https://a.example/one", "snippet": "s"},
                {"title": "A copy", "url": "https://a.example/one", "snippet": "s"},
                {"title": "no url", "url": ""},
                {"title": "B", "url": "https://b.example/two", "snippet": "s"},
            ]
        )
        assert seen == [
            [
                {"title": "A", "url": "https://a.example/one"},
                {"title": "B", "url": "https://b.example/two"},
            ]
        ]

    def test_missing_title_falls_back_to_the_url(self):
        seen: list[list[dict[str, str]]] = []
        search.set_source_sink(seen.append)
        search.report_sources([{"url": "https://a.example/one"}])
        assert seen[0][0]["title"] == "https://a.example/one"

    def test_caps_the_list_so_one_search_cannot_flood_the_ui(self):
        seen: list[list[dict[str, str]]] = []
        search.set_source_sink(seen.append)
        search.report_sources(
            [{"title": f"S{i}", "url": f"https://s{i}.example"} for i in range(30)]
        )
        assert len(seen[0]) == search.MAX_REPORTED_SOURCES

    def test_no_sink_is_a_no_op(self):
        search.set_source_sink(None)
        search.report_sources([{"title": "A", "url": "https://a.example"}])  # must not raise

    def test_a_failing_sink_never_breaks_the_search(self):
        def boom(_sources):
            raise RuntimeError("client went away")

        search.set_source_sink(boom)
        search.report_sources([{"title": "A", "url": "https://a.example"}])

    def test_nested_tasks_inherit_the_sink_set_by_the_run(self):
        """The pipeline sets the sink inside its own task; the searches run in
        child tasks (asyncio.gather / create_task), which must inherit it."""
        seen: list[list[dict[str, str]]] = []

        async def run():
            search.set_source_sink(seen.append)

            async def search_once():
                search.report_sources([{"title": "T", "url": "https://a.example"}])

            await asyncio.gather(search_once(), asyncio.create_task(search_once()))

        asyncio.run(run())
        assert len(seen) == 2


class TestSourcesReachTheClient:
    def _stub_summarizer(self, monkeypatch, summary: str = "SUMMARY", fail: bool = False):
        async def fake_resolved(category):
            return {"model": "test-model", "source": "local"}

        async def fake_stream(model, messages, on_chunk, options):
            if fail:
                raise RuntimeError("model exploded")
            on_chunk(summary)
            return None

        monkeypatch.setattr(search, "get_resolved_model", fake_resolved)
        monkeypatch.setattr(search, "stream_chat", fake_stream)

    def test_tavily_pages_are_reported(self, monkeypatch):
        self._stub_summarizer(monkeypatch)
        seen: list[list[dict[str, str]]] = []
        search.set_source_sink(seen.append)
        try:
            async def fake_key():
                return GOOD_KEY

            monkeypatch.setattr("app.settings_store.get_tavily_api_key", fake_key)
            with serve_tavily(_ok_responder) as (endpoint, _seen):
                monkeypatch.setattr(tavily, "TAVILY_SEARCH_URL", f"{endpoint}/search")
                assert asyncio.run(search.get_web_context("who is leo messi")) is not None
        finally:
            search.set_source_sink(None)

        assert [s["url"] for s in seen[0]] == [
            "https://example.com/messi",
            "https://example.org/messi",
        ]
        assert seen[0][0]["title"] == "Lionel Messi Facts"

    def test_a_dropped_search_reports_no_pages(self, monkeypatch):
        """A refusal drops the search context from the prompt — the answer
        must not then list pages it never saw."""
        self._stub_summarizer(monkeypatch, summary="I'm sorry, I can't help with that.")
        seen: list[list[dict[str, str]]] = []
        search.set_source_sink(seen.append)
        try:
            async def fake_key():
                return GOOD_KEY

            monkeypatch.setattr("app.settings_store.get_tavily_api_key", fake_key)
            with serve_tavily(_ok_responder) as (endpoint, _seen):
                monkeypatch.setattr(tavily, "TAVILY_SEARCH_URL", f"{endpoint}/search")
                assert asyncio.run(search.get_web_context("who is leo messi")) is None
        finally:
            search.set_source_sink(None)
        assert seen == []

    def test_pages_are_still_reported_when_the_summarizer_fails(self, monkeypatch):
        self._stub_summarizer(monkeypatch, fail=True)
        seen: list[list[dict[str, str]]] = []
        search.set_source_sink(seen.append)
        try:
            calls: dict = {}
            _stub_duckduckgo(monkeypatch, calls)

            async def no_key():
                return ""

            monkeypatch.setattr("app.settings_store.get_tavily_api_key", no_key)
            assert asyncio.run(search.get_web_context("who is leo messi")) is not None
        finally:
            search.set_source_sink(None)

        # The raw scraped content was used instead of the summary, so the page
        # must still be listed.
        assert [s["url"] for s in seen[0]] == ["https://ddg.example/1"]

    def test_pipeline_registers_the_sink_for_its_run(self, monkeypatch):
        """End-to-end wiring: a chat turn that triggers a search hands the
        pages to the route's onSources, which is what the clients receive."""
        import app.pipeline as pipeline

        self._stub_summarizer(monkeypatch, summary="Czechia has about 10.9M people.")

        async def fake_model(model, messages, tools, on_chunk, options):
            on_chunk("About 10.9 million.")
            return {"content": "About 10.9 million.", "toolCalls": [], "metrics": {}}

        monkeypatch.setattr(pipeline, "stream_chat_with_tools", fake_model)

        async def fake_key():
            return GOOD_KEY

        monkeypatch.setattr("app.settings_store.get_tavily_api_key", fake_key)
        collected: list[list[dict[str, str]]] = []
        with serve_tavily(_ok_responder) as (endpoint, _seen):
            monkeypatch.setattr(tavily, "TAVILY_SEARCH_URL", f"{endpoint}/search")
            asyncio.run(
                pipeline.run_pipeline(
                    {
                        "model": "test-model",
                        "messages": [
                            {
                                "role": "user",
                                "content": "What is the current population of Czechia",
                            }
                        ],
                        "mode": "chat",
                        "onChunk": lambda *_: None,
                        "onStage": lambda *_: None,
                        "onSources": collected.append,
                    }
                )
            )

        assert collected, "the pipeline never reported its search sources"
        assert [s["url"] for s in collected[0]] == [
            "https://example.com/messi",
            "https://example.org/messi",
        ]

    def test_pipeline_without_the_callback_still_runs(self, monkeypatch):
        """Older clients / other callers pass no onSources — a search must not
        blow up on the missing callback."""
        import app.pipeline as pipeline

        self._stub_summarizer(monkeypatch, summary="Czechia has about 10.9M people.")

        async def fake_model(model, messages, tools, on_chunk, options):
            on_chunk("About 10.9 million.")
            return {"content": "About 10.9 million.", "toolCalls": [], "metrics": {}}

        monkeypatch.setattr(pipeline, "stream_chat_with_tools", fake_model)

        async def fake_key():
            return GOOD_KEY

        monkeypatch.setattr("app.settings_store.get_tavily_api_key", fake_key)
        with serve_tavily(_ok_responder) as (endpoint, _seen):
            monkeypatch.setattr(tavily, "TAVILY_SEARCH_URL", f"{endpoint}/search")
            reply = asyncio.run(
                pipeline.run_pipeline(
                    {
                        "model": "test-model",
                        "messages": [
                            {
                                "role": "user",
                                "content": "What is the current population of Czechia",
                            }
                        ],
                        "mode": "chat",
                        "onChunk": lambda *_: None,
                    }
                )
            )

        assert "10.9 million" in reply


class TestEnvFallback:
    def test_env_var_is_used_when_settings_are_empty(self, monkeypatch):
        monkeypatch.setenv("TAVILY_API_KEY", "tvly-from-env")
        assert asyncio.run(get_tavily_api_key()) == "tvly-from-env"

    def test_saved_key_wins_over_the_env_var(self, monkeypatch, client):
        monkeypatch.setenv("TAVILY_API_KEY", "tvly-from-env")
        client.put(
            "/api/settings",
            json={"tavilyApiKey": "tvly-from-settings"},
            headers={"Cookie": "settings_auth=1"},
        )
        assert asyncio.run(get_tavily_api_key()) == "tvly-from-settings"
