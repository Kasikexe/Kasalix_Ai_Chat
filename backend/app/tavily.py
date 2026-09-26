"""Tavily web search client.

Tavily's ``POST /search`` returns ready-made page snippets in
``results[].content`` plus an optional synthesized ``answer``, which replaces
both the DuckDuckGo HTML scraping and the per-page content fetching the old
search path relied on.

Credits (from the Tavily docs): ``basic`` / ``fast`` / ``ultra-fast`` cost 1
credit per request, ``advanced`` costs 2. The free tier is a monthly allowance,
so the interactive key check uses the cheapest possible probe.

Docs: https://docs.tavily.com/documentation/api-reference/endpoint/search
"""

from __future__ import annotations

import time

import httpx

from .logger import info as log_info, warn as log_warn

TAVILY_SEARCH_URL = "https://api.tavily.com/search"
SEARCH_TIMEOUT = 20.0

# Tavily accepts 0..20 results and 1..3 chunks per source (each <= 500 chars).
DEFAULT_MAX_RESULTS = 8
DEFAULT_CHUNKS_PER_SOURCE = 2
DEFAULT_SEARCH_DEPTH = "basic"

# ``topic="news"`` narrows the index to news articles and is the only topic
# that honours ``days``. Used for queries that ask about now ("latest", "today").
TOPIC_NEWS = "news"
TOPIC_GENERAL = "general"

# Cheapest possible probe for the "Test Connection" button: 1 credit.
TEST_SEARCH_DEPTH = "ultra-fast"
TEST_MAX_RESULTS = 1
TEST_QUERY = "connectivity test"


class TavilyError(Exception):
    """A Tavily request that did not produce usable results.

    ``kind`` is one of:
      ``key``      — no API key configured
      ``auth``     — Tavily rejected the key (401)
      ``quota``    — the monthly/plan allowance is exhausted
      ``rate``     — rate limited (429)
      ``service``  — Tavily (or the request) failed some other way
      ``endpoint`` — the request never reached Tavily
    """

    def __init__(self, message: str, *, kind: str = "service", status: int | None = None):
        super().__init__(message)
        self.kind = kind
        self.status = status


def _error_detail(payload: object) -> str:
    """Pull a readable message out of Tavily's `{"detail": ...}` error shapes.

    Tavily returns either ``{"detail": {"error": "..."}}`` or a FastAPI-style
    validation list ``{"detail": [{...}]}``.
    """
    if not isinstance(payload, dict):
        return ""
    detail = payload.get("detail")
    if isinstance(detail, dict):
        return str(detail.get("error") or detail.get("message") or "").strip()
    if isinstance(detail, list) and detail:
        first = detail[0]
        if isinstance(first, dict):
            return str(first.get("msg") or "").strip()
    if isinstance(detail, str):
        return detail.strip()
    return ""


def _classify(status: int, detail: str) -> str:
    """Map a Tavily HTTP status onto our error kinds."""
    lowered = detail.lower()
    if status in (401, 403):
        return "auth"
    if status == 429:
        return "rate"
    if status in (432, 433) or "usage limit" in lowered or "exceeds your" in lowered:
        return "quota"
    return "service"


def _message_for(kind: str, status: int, detail: str) -> str:
    if kind == "auth":
        return f"Tavily rejected the API key ({status}) — it may be invalid or revoked."
    if kind == "quota":
        return detail or f"Tavily search credits exhausted ({status})."
    if kind == "rate":
        return detail or "Tavily is rate limiting requests — try again shortly."
    return detail or f"Tavily returned {status}."


async def search(
    query: str,
    api_key: str,
    *,
    max_results: int = DEFAULT_MAX_RESULTS,
    search_depth: str = DEFAULT_SEARCH_DEPTH,
    chunks_per_source: int = DEFAULT_CHUNKS_PER_SOURCE,
    include_answer: bool = True,
    topic: str | None = None,
    days: int | None = None,
    timeout: float = SEARCH_TIMEOUT,
) -> dict:
    """Run a Tavily search.

    ``topic`` (``general`` / ``news``) and ``days`` narrow a time-sensitive
    lookup to the last N days. Tavily only honours ``days`` on the news topic,
    so a stray ``days`` without a news topic is dropped rather than sent.

    Returns ``{"answer": str | None, "results": [...], "credits": int | None,
    "responseTime": float | None}``. Raises :class:`TavilyError` on failure.
    """
    key = (api_key or "").strip()
    if not key:
        raise TavilyError("No Tavily API key configured.", kind="key")

    body = {
        "query": query,
        "search_depth": search_depth,
        "chunks_per_source": chunks_per_source,
        "max_results": max_results,
        "include_answer": include_answer,
        "include_usage": True,
    }
    if topic:
        body["topic"] = topic
    if days and topic == TOPIC_NEWS:
        body["days"] = days
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.post(TAVILY_SEARCH_URL, headers=headers, json=body)
    except Exception as e:  # noqa: BLE001 — any transport failure is "endpoint"
        # httpx connect errors stringify to "", so fall back to the type name.
        detail = str(e).strip() or type(e).__name__
        raise TavilyError(f"Cannot reach Tavily ({detail})", kind="endpoint") from e

    payload: object = {}
    try:
        payload = res.json()
    except Exception:  # noqa: BLE001 — non-JSON error page
        payload = {}

    if res.status_code >= 400:
        detail = _error_detail(payload)
        kind = _classify(res.status_code, detail)
        message = _message_for(kind, res.status_code, detail)
        raise TavilyError(message, kind=kind, status=res.status_code)

    if not isinstance(payload, dict):
        raise TavilyError("Tavily returned an unexpected response body.", kind="service")

    raw_results = payload.get("results")
    results: list[dict[str, str]] = []
    if isinstance(raw_results, list):
        for item in raw_results:
            if not isinstance(item, dict):
                continue
            url = str(item.get("url") or "").strip()
            if not url:
                continue
            results.append(
                {
                    "title": str(item.get("title") or url).strip(),
                    "url": url,
                    "content": str(item.get("content") or "").strip(),
                    "publishedDate": str(item.get("published_date") or "").strip(),
                }
            )

    answer = payload.get("answer")
    usage = payload.get("usage")
    credits = usage.get("credits") if isinstance(usage, dict) else None

    return {
        "answer": str(answer).strip() if isinstance(answer, str) and answer.strip() else None,
        "results": results,
        "credits": credits if isinstance(credits, int) else None,
        "responseTime": payload.get("response_time"),
    }


async def verify_api_key(api_key: str) -> dict:
    """Probe a Tavily key for the "Test Connection" button.

    Deliberately the cheapest request Tavily offers (``ultra-fast``, one
    result) — it still costs 1 credit, so the UI says so. Never raises.
    """
    key = (api_key or "").strip()
    if not key:
        return {"ok": False, "kind": "key", "message": "No Tavily API key entered."}

    started = time.monotonic()
    try:
        data = await search(
            TEST_QUERY,
            key,
            max_results=TEST_MAX_RESULTS,
            search_depth=TEST_SEARCH_DEPTH,
            chunks_per_source=1,
            include_answer=False,
        )
    except TavilyError as e:
        log_warn(f"[tavily] Key check failed ({e.kind} {e.status}): {e}")
        return {
            "ok": False,
            "kind": e.kind,
            "status": e.status,
            "message": str(e),
        }

    latency_ms = int((time.monotonic() - started) * 1000)
    result = {
        "ok": True,
        "status": 200,
        "latencyMs": latency_ms,
        "credits": data.get("credits"),
        "resultCount": len(data.get("results") or []),
        "message": "Tavily API key works — web search is ready.",
    }
    log_info(f"[tavily] Key verified in {latency_ms}ms (credits={result.get('credits')})")
    return result
