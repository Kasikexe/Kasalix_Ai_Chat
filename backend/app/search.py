"""Web search service — mirrors backend/src/services/search.ts.

DuckDuckGo HTML search, parallel page fetch with text extraction, then AI
summarization by the assigned search model. Refusal-safe: a safety-tuned
summarizer's refusal is treated as "no useful context" instead of being fed
back into chat.
"""

from __future__ import annotations

import asyncio
import html as html_lib
import json
import re
import time
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any, Callable

import httpx

from .attachments import strip_image_markers

from .logger import error as log_error, info as log_info, warn as log_warn
from .model_assignments import get_resolved_model
from .ollama_client import StreamOptions, stream_chat

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
MIN_DELAY_S = 1.5
_last_search_time = 0.0
MAX_REPORTED_SOURCES = 8

# A lookup is not cheap: a provider round-trip, sometimes a second one, plus a
# model summarization — and it is often run twice for one question, because the
# pipeline searches ahead of the answer and the model may then call web_search
# with the same words. Repeats inside this window are served from memory.
# A lookup that found nothing is cached too, for less time, so one dead end is
# not immediately hit again by the other search path.
SEARCH_CACHE_TTL_S = 600.0
EMPTY_CACHE_TTL_S = 120.0
SEARCH_CACHE_MAX_ENTRIES = 64

# Where to report the pages a search actually used, so the clients can show
# them under the answer. A ContextVar (rather than an argument threaded through
# every caller) because searches start from several places — the pipeline's
# freshness heuristic, the agent's `web_search` tool, the tool registry in chat
# mode — and they must all land on the same list without duplicating plumbing.
# The run that owns the request sets the sink; see pipeline.run_pipeline.
_SOURCE_SINK: ContextVar[Callable[[list[dict[str, str]]], None] | None] = ContextVar(
    "web_search_source_sink", default=None
)


def set_source_sink(sink: Callable[[list[dict[str, str]]], None] | None) -> None:
    """Report pages from every search made by the current run to ``sink``.

    Must be called at the start of a run, before any search can happen — child
    tasks (asyncio.gather, create_task) inherit the value set here.
    """
    _SOURCE_SINK.set(sink)


def report_sources(results: list[dict[str, Any]]) -> None:
    """Hand the distinct pages of ``results`` to the run's sink, if any."""
    sink = _SOURCE_SINK.get()
    if sink is None or not results:
        return
    seen: set[str] = set()
    sources: list[dict[str, str]] = []
    for r in results:
        url = str(r.get("url") or "").strip()
        if not url or url in seen:
            continue
        seen.add(url)
        title = str(r.get("title") or "").strip() or url
        sources.append({"title": title, "url": url})
        if len(sources) >= MAX_REPORTED_SOURCES:
            break
    if sources:
        try:
            sink(sources)
        except Exception as e:  # noqa: BLE001
            # Showing sources is a nicety — never let it break the answer.
            log_warn(f"[search] Could not report sources: {e}")


@dataclass
class SearchOutcome:
    """What one lookup produced — including whether it produced anything.

    ``context is None`` used to mean two very different things: "nobody asked
    for a search" and "the search found nothing". The difference matters — a
    model that is not told its lookup came back empty will answer from memory
    as if the search had confirmed it.
    """

    query: str
    context: str | None = None
    sources: list[dict[str, Any]] = field(default_factory=list)
    found: bool = False
    cached: bool = False
    attempts: list[str] = field(default_factory=list)


_SEARCH_CACHE: dict[str, tuple[float, SearchOutcome]] = {}


def clear_search_cache() -> None:
    """Drop every cached lookup — used by tests and when settings change."""
    _SEARCH_CACHE.clear()


def _cache_key(query: str) -> str:
    """Normalized key: casing, spacing and trailing punctuation must not miss."""
    text = " ".join(str(query or "").split()).strip().strip("\"'")
    return text.lower().rstrip(" ?!.,;:")


def _cache_get(key: str) -> SearchOutcome | None:
    entry = _SEARCH_CACHE.get(key)
    if entry is None:
        return None
    expires, outcome = entry
    if expires <= time.monotonic():
        _SEARCH_CACHE.pop(key, None)
        return None
    return outcome


def _cache_put(key: str, outcome: SearchOutcome) -> None:
    ttl = SEARCH_CACHE_TTL_S if outcome.found else EMPTY_CACHE_TTL_S
    _SEARCH_CACHE[key] = (time.monotonic() + ttl, outcome)
    while len(_SEARCH_CACHE) > SEARCH_CACHE_MAX_ENTRIES:
        # Dicts keep insertion order, so this drops the oldest entry first.
        _SEARCH_CACHE.pop(next(iter(_SEARCH_CACHE)), None)


def _query_tokens(query: str) -> frozenset[str]:
    """The concrete terms of a query — stopwords and punctuation dropped."""
    tokens = {
        word.strip("?!.,;:\"'()[]{}").lower()
        for word in str(query or "").split()
    }
    return frozenset(t for t in tokens if len(t) > 1 and t not in _STOPWORDS)


# The query that reaches the engine is often rewritten slightly between two
# asks of the SAME question — "Czechia population 2024 2026" then "Czechia
# population 2026" is the deciding model's wording, not the user's. A repeat
# that only differs by a word or two still counts as the same lookup.
_NEAR_MATCH_MIN_TOKENS = 2
_NEAR_MATCH_CONTAINMENT = 0.8


def _cache_lookup(query: str) -> tuple[SearchOutcome, str] | None:
    """A cached outcome for ``query`` — the exact key first, then a near match.

    Returns ``(outcome, matched_key)`` so the caller can tell the two apart in
    the log. Near matching compares the queries' content words: one side must
    cover at least 80% of the other's, which catches "...2024 2026" vs "...2026"
    but not "... 2024" vs "... 2025" (two different answers).
    """
    key = _cache_key(query)
    exact = _cache_get(key)
    if exact is not None:
        return exact, key

    tokens = _query_tokens(query)
    if len(tokens) < _NEAR_MATCH_MIN_TOKENS:
        return None

    best: tuple[float, SearchOutcome, str] | None = None
    for cached_key, (expires, outcome) in list(_SEARCH_CACHE.items()):
        if expires <= time.monotonic():
            _SEARCH_CACHE.pop(cached_key, None)
            continue
        cached_tokens = _query_tokens(cached_key)
        if len(cached_tokens) < _NEAR_MATCH_MIN_TOKENS:
            continue
        overlap = len(tokens & cached_tokens)
        smaller = min(len(tokens), len(cached_tokens))
        if overlap / smaller < _NEAR_MATCH_CONTAINMENT:
            continue
        # Among several candidates prefer the closest wording.
        score = overlap / len(tokens | cached_tokens)
        if best is None or score > best[0]:
            best = (score, outcome, cached_key)
    if best is None:
        return None
    return best[1], best[2]


# ─── Recency-aware queries ──────────────────────────────────────────────────
# "latest", "today", "this week" change what the right answer is. When a query
# says so, both providers accept a window: Tavily takes topic=news with days=N,
# and DuckDuckGo takes its df= date filter.
_RECENCY_WINDOWS: list[tuple[re.Pattern[str], int]] = [
    (
        re.compile(
            r"\b(today|tonight|right now|just now|this (?:morning|afternoon|evening)|breaking)\b",
            re.IGNORECASE,
        ),
        1,
    ),
    (re.compile(r"\b(this|last|past) week\b|\bweekly\b", re.IGNORECASE), 7),
    (
        re.compile(
            r"\b(latest|newest|most recent|recent|recently|current|currently|"
            r"news|up[- ]to[- ]date|this (?:month|quarter)|last (?:month|quarter)|"
            r"just (?:released|launched|announced|updated)|release notes)\b",
            re.IGNORECASE,
        ),
        30,
    ),
    (re.compile(r"\b(this|last|past) year\b|\bannually\b|\b20\d{2}\b", re.IGNORECASE), 365),
]


def recency_days(query: str) -> int | None:
    """The look-back window a time-sensitive query implies, or None."""
    for pattern, days in _RECENCY_WINDOWS:
        if pattern.search(str(query or "")):
            return days
    return None


def duckduckgo_df(days: int | None) -> str | None:
    """DuckDuckGo's date filter for a recency window: d / w / m / y."""
    if not days:
        return None
    if days <= 1:
        return "d"
    if days <= 7:
        return "w"
    if days <= 30:
        return "m"
    return "y"


# ─── Recovery: rewriting a query that found nothing ─
# A failed lookup is usually a wording problem, not a knowledge problem: engines
# do badly with "what is the latest version of X?" and better with "X latest
# version". One deterministic rewrite, then the caller is told plainly that
# nothing was found.
_QUESTION_FRAMING_RE = re.compile(
    r"^(?:"
    r"what(?:'s| is| are| was| were)|who(?:'s| is| are| was| were)|"
    r"when (?:is|was|were|did|does|do)|where (?:is|are|was|were)|"
    r"how (?:to|do|does|did|can|much|many|long|old)|"
    r"why (?:is|are|was|were|does|do|did)|which (?:is|are|was|were)|"
    r"(?:is|are|was|were|does|do|did|can|could|should|would|will)"
    r")\s+(?:(?:the|a|an)\s+)?",
    re.IGNORECASE,
)

_STOPWORDS = frozenset(
    {
        "a", "an", "about", "and", "are", "as", "at", "be", "been", "being", "by",
        "can", "could", "did", "do", "does", "for", "from", "he", "her", "i", "in",
        "is", "it", "its", "me", "my", "of", "on", "or", "please", "she", "should",
        "tell", "that", "the", "these", "they", "this", "those", "to", "was", "we",
        "were", "what", "when", "where", "which", "who", "why", "will", "with", "would",
        "you", "your",
    }
)


def rewrite_search_query(query: str) -> str | None:
    """A shorter, plainer version of ``query``, or None if nothing is left.

    Deterministic on purpose: a failed lookup must not depend on another model
    call succeeding before it can be retried.
    """
    text = " ".join(str(query or "").split()).strip().strip("\"'")
    if not text:
        return None
    # 1. Drop question framing: "what is the latest version of X" → "latest version of X".
    stripped = _QUESTION_FRAMING_RE.sub("", text, count=1).strip(" ?!.,;:")
    if stripped and _cache_key(stripped) != _cache_key(text):
        return stripped
    # 2. Drop stopwords, keeping the concrete terms: "population of Czechia" → "population Czechia".
    words = [
        w.strip("?!.,;:")
        for w in (stripped or text).split()
        if w.strip("?!.,;:").lower() not in _STOPWORDS
    ]
    keyword = " ".join(w for w in words if w).strip()
    if len(words) >= 2 and len(keyword) >= 3 and _cache_key(keyword) != _cache_key(text):
        return keyword
    return None


_SKIP_EXTENSIONS = [".pdf", ".zip", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".mp4", ".mp3", ".doc", ".docx"]

_BOILERPLATE = [
    "cookie", "privacy policy", "terms of service", "terms and conditions",
    "all rights reserved", "copyright", "\u00a9", "subscribe", "newsletter",
    "advertisement", "sponsored", "sign up", "log in", "sign in",
    "create account", "forgot password", "share this", "tweet", "facebook",
    "click here", "read more", "related articles", "you might also like",
    "your browser", "enable javascript", "skip to", "menu", "navigation",
]

_ENTITY_MAP = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&#x27;": "'",
    "&quot;": '"', "&#x2F;": "/", "&#39;": "'",
    "&ndash;": "\u2013", "&mdash;": "\u2014", "&nbsp;": " ",
}

_REFUSAL_RE = re.compile(
    r"\b(can'?t help|can'?t answer|can'?t provide|cannot help|cannot answer|cannot provide|"
    r"won'?t help|won'?t answer|not able to|unable to|i'?m (?:sorry|afraid)|i am (?:sorry|afraid)|"
    r"as an ai|not appropriate|inappropriate|against (?:my|our) (?:policy|guidelines|ethics|principles|values)|"
    r"don'?t feel comfortable|not comfortable|is there something else)\b",
    re.IGNORECASE,
)


def _clean_entities(s: str) -> str:
    for k, v in _ENTITY_MAP.items():
        s = s.replace(k, v)
    return re.sub(r"&#(\d+);", lambda m: chr(int(m.group(1))), s)


def _is_useful_line(line: str) -> bool:
    trimmed = line.strip()
    if len(trimmed) < 25:
        return False
    lower = trimmed.lower()
    if any(b in lower for b in _BOILERPLATE):
        return False
    if sum(1 for c in trimmed if c.isalpha()) < 10:
        return False
    return True


async def _fetch_page_content(url: str, max_chars: int = 4000) -> str | None:
    url_lower = url.lower()
    if any(ext in url_lower for ext in _SKIP_EXTENSIONS):
        return None
    if not url.startswith("http://") and not url.startswith("https://"):
        return None

    try:
        headers = {
            "User-Agent": BROWSER_UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        }
        async with httpx.AsyncClient(timeout=5.0, follow_redirects=True) as client:
            res = await client.get(url, headers=headers)
        if res.status_code >= 400:
            return None
        if res.headers.get("content-length") and int(res.headers["content-length"]) > 500000:
            return None
        page = res.text
        if len(page) > 200000:
            return None

        # Remove script/style/svg blocks FIRST
        page = re.sub(r"<script[^>]*>[\s\S]*?</script>", " ", page, flags=re.IGNORECASE)
        page = re.sub(r"<style[^>]*>[\s\S]*?</style>", " ", page, flags=re.IGNORECASE)
        page = re.sub(r"<svg[^>]*>[\s\S]*?</svg>", " ", page, flags=re.IGNORECASE)

        # Focus on main/article content areas
        m = re.search(r"<main[^>]*>([\s\S]*?)</main>", page, re.IGNORECASE)
        a = re.search(r"<article[^>]*>([\s\S]*?)</article>", page, re.IGNORECASE)
        b = re.search(r"<body[^>]*>([\s\S]*?)</body>", page, re.IGNORECASE)
        scope = (a.group(1) if a else None) or (m.group(1) if m else None) or (b.group(1) if b else None) or page

        # Extract text ONLY from paragraph/heading/list tags
        lines: list[str] = []
        for match in re.finditer(r"<(p|h[1-6]|li)[^>]*>([\s\S]*?)</\1>", scope, re.IGNORECASE):
            text = re.sub(r"<[^>]+>", " ", match.group(2))
            text = re.sub(r"\s+", " ", text).strip()
            text = _clean_entities(text)
            if _is_useful_line(text):
                lines.append(text)

        # Deduplicate near-identical consecutive lines
        unique: list[str] = []
        for line in lines:
            prev = unique[-1] if unique else None
            if prev and len(line) > 20 and line[:20] in prev:
                continue
            unique.append(line)

        result = "\n\n".join(unique)

        # HYBRID FALLBACK: body-level text when semantic tags yielded little
        if len(result) < 500:
            boundary = " ||| "
            prepped = re.sub(
                r"</(div|p|section|article|li|td|th|tr|span|h[1-6])>", boundary, scope, flags=re.IGNORECASE
            )
            prepped = re.sub(r"<(br|hr)[^>]*>", boundary, prepped, flags=re.IGNORECASE)
            stripped = re.sub(r"<[^>]+>", " ", prepped)
            stripped = re.sub(r"&nbsp;", " ", stripped, flags=re.IGNORECASE)
            stripped = re.sub(r"\s+", " ", stripped).strip()
            raw_text = _clean_entities(stripped)
            raw_lines = [s.strip() for s in raw_text.split(boundary) if s.strip()]
            filtered = [s for s in raw_lines if _is_useful_line(s)]
            raw_unique: list[str] = []
            for line in filtered:
                prev = raw_unique[-1] if raw_unique else None
                if prev and len(line) > 20 and line[:20] in prev:
                    continue
                raw_unique.append(line)
            fallback = "\n".join(raw_unique)
            if len(fallback) > len(result):
                result = fallback
                log_info(f"[search] Used body fallback for {url[:60]} ({len(result)} chars)")

        if len(result) <= 100:
            return None
        return result[:max_chars]
    except Exception:  # noqa: BLE001
        return None


def _decode_ddg_url(url: str) -> str:
    """Decode a DuckDuckGo redirect (//duckduckgo.com/l/?uddg=<encoded>) to the real URL."""
    if "uddg=" not in url:
        return url
    try:
        from urllib.parse import urlparse, parse_qs

        parsed = urlparse(url if url.startswith("http") else "https:" + url)
        real = parse_qs(parsed.query).get("uddg", [""])[0]
        return real or url
    except Exception:  # noqa: BLE001
        return url


async def _duck_search_html(
    query: str, max_results: int = 5, *, df: str | None = None
) -> list[dict[str, str]]:
    """Primary: html.duckduckgo.com POST endpoint."""
    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        "Origin": "https://html.duckduckgo.com",
        "Referer": "https://html.duckduckgo.com/",
    }
    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        data = {"q": query}
        if df:
            data["df"] = df
        res = await client.post("https://html.duckduckgo.com/html/", headers=headers, data=data)
    if res.status_code >= 400:
        raise RuntimeError(f"DuckDuckGo HTML returned {res.status_code}")
    page = res.text

    results: list[dict[str, str]] = []
    blocks = page.split('<div class="result results_links results_links_deep web-result ">')
    for block in blocks[1:]:
        if len(results) >= max_results:
            break
        url_m = re.search(r'<a[^>]+rel="nofollow"[^>]+class="result__a"[^>]+href="([^"]+)"', block)
        url = url_m.group(1) if url_m else ""
        title_m = re.search(r'class="result__a"[^>]*>([\s\S]*?)</a>', block)
        title = re.sub(r"<[^>]+>", "", title_m.group(1)).strip() if title_m else ""
        snippet_m = re.search(r'<a class="result__snippet"[^>]*>([\s\S]*?)</a>', block)
        snippet = re.sub(r"<[^>]+>", "", snippet_m.group(1)).strip() if snippet_m else ""
        title = html_lib.unescape(_clean_entities(title))
        snippet = html_lib.unescape(_clean_entities(snippet))
        if title or url:
            results.append({"title": title, "url": _decode_ddg_url(url), "snippet": snippet})
    if not results:
        raise RuntimeError("DuckDuckGo HTML returned no parseable results (layout change or bot check)")
    return results


async def _duck_search_lite(
    query: str, max_results: int = 5, *, df: str | None = None
) -> list[dict[str, str]]:
    """Fallback: lite.duckduckgo.com GET endpoint — different markup, often
    still up when the HTML endpoint is rate-limiting. Links use uddg= redirects
    and single-quoted class attributes."""
    headers = {
        "User-Agent": BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://lite.duckduckgo.com/",
    }
    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        params = {"q": query}
        if df:
            params["df"] = df
        res = await client.get("https://lite.duckduckgo.com/lite/", params=params, headers=headers)
    if res.status_code >= 400:
        raise RuntimeError(f"DuckDuckGo Lite returned {res.status_code}")
    page = res.text

    results: list[dict[str, str]] = []
    # Order-agnostic: grab all <a> tags, filter by class + href separately.
    for attrs, inner in re.findall(r"<a([^>]*)>([\s\S]*?)</a>", page):
        if len(results) >= max_results:
            break
        if "result-link" not in attrs:
            continue
        href_m = re.search(r'href="([^"]+)"', attrs) or re.search(r"href='([^']+)'", attrs)
        if not href_m:
            continue
        url = _decode_ddg_url(html_lib.unescape(href_m.group(1)))
        title = re.sub(r"<[^>]+>", "", inner).strip()
        title = html_lib.unescape(_clean_entities(title))
        if title or url:
            results.append({"title": title, "url": url, "snippet": ""})
    if not results:
        raise RuntimeError("DuckDuckGo Lite returned no parseable results")

    # Snippets live in a parallel table column — best effort, matched by index.
    snippets = [
        re.sub(r"<[^>]+>", "", s).strip()
        for s in re.findall(r"class=['\"]result-snippet['\"][^>]*>([\s\S]*?)</td>", page)
    ]
    for i, snippet in enumerate(snippets):
        if i < len(results) and snippet:
            results[i]["snippet"] = html_lib.unescape(_clean_entities(snippet))
    return results


async def _ddgs_library_search(
    query: str, max_results: int = 5, *, timelimit: str | None = None
) -> list[dict[str, str]]:
    """Primary: the ddgs library. It rotates search backends and handles
    DuckDuckGo's anti-bot challenges (browser impersonation) — the raw HTML
    endpoints below get 202-challenged after a few requests from server IPs.
    Runs in a thread: ddgs is sync-only."""
    from ddgs import DDGS  # lazy import — keeps startup fast if unused

    def run() -> list[dict[str, str]]:
        out: list[dict[str, str]] = []

        def collect(iterator: Any) -> None:
            for r in iterator:
                out.append({
                    "title": str(r.get("title") or "").strip(),
                    "url": str(r.get("href") or "").strip(),
                    "snippet": str(r.get("body") or "").strip(),
                })

        with DDGS() as ddgs:
            if timelimit:
                try:
                    collect(ddgs.text(query, max_results=max_results, timelimit=timelimit))
                except TypeError:
                    # Older ddgs builds take no timelimit — a wide search beats none.
                    out.clear()
                    collect(ddgs.text(query, max_results=max_results))
            else:
                collect(ddgs.text(query, max_results=max_results))
        return out

    results = await asyncio.to_thread(run)
    if not results:
        raise RuntimeError("ddgs library returned no results")
    return results


async def _duck_search(
    query: str, max_results: int = 5, *, days: int | None = None
) -> list[dict[str, str]]:
    """Search DuckDuckGo with rate limiting, engine fallback, and retry.

    Order: ddgs library (challenge-proof) → raw HTML endpoint → raw Lite
    endpoint, then one full retry pass. Failures are logged WITH the exception
    type so outages are diagnosable instead of silently returning nothing.
    ``days`` narrows the results to that look-back window on every engine.
    """
    global _last_search_time
    now = time.monotonic()
    elapsed = now - _last_search_time
    if elapsed < MIN_DELAY_S:
        await asyncio.sleep(MIN_DELAY_S - elapsed)
    _last_search_time = time.monotonic()

    df = duckduckgo_df(days)
    engines: list[tuple[str, Any]] = [
        ("ddgs", lambda: _ddgs_library_search(query, max_results, timelimit=df)),
        ("html", lambda: _duck_search_html(query, max_results, df=df)),
        ("lite", lambda: _duck_search_lite(query, max_results, df=df)),
    ]
    last_err: Exception | None = None
    for pass_num in (1, 2):  # one full chain, then one retry of the chain
        for name, fn in engines:
            try:
                results = await fn()
                if results:
                    if pass_num > 1 or name != "ddgs":
                        log_info(f"[search] Served via {name} engine (pass {pass_num})")
                    return results
            except Exception as e:  # noqa: BLE001
                last_err = e
                log_error(f"[search] DuckDuckGo {name} attempt {pass_num} failed: {type(e).__name__}: {e}")
        if pass_num == 1 and last_err is not None:
            await asyncio.sleep(1.0)  # brief cool-down before the retry pass
    log_error(f"[search] All search engines failed for query: {query[:80]}")
    return []


async def _gather_web_results(
    trimmed: str, *, days: int | None = None
) -> tuple[str, list[dict[str, str]], str | None, list[dict[str, str]]]:
    """Collect search results, preferring Tavily over the DuckDuckGo scraper.

    Tavily's snippets already carry the page content, so its path needs no page
    fetching at all. The scraper stays as a safety net so search keeps working
    when no key is configured, the monthly credits run out, or Tavily errors.

    ``days`` is the look-back window for a time-sensitive query (None for a
    timeless one) — it reaches both providers as their own date filter.

    Returns ``(source, snippets, answer, page_pairs)``.
    """
    from . import tavily
    from .settings_store import get_tavily_api_key

    api_key = await get_tavily_api_key()
    if api_key:
        topic = tavily.TOPIC_NEWS if days else None
        try:
            data = await tavily.search(trimmed, api_key, topic=topic, days=days)
            snippets = [
                {"title": r["title"], "url": r["url"], "snippet": r["content"]}
                for r in data["results"]
            ]
            if snippets:
                log_info(
                    f"[search] Tavily returned {len(snippets)} results"
                    + (" (+answer)" if data.get("answer") else "")
                )
                return "tavily", snippets, data.get("answer"), []
            log_warn("[search] Tavily returned no results — falling back to DuckDuckGo")
        except tavily.TavilyError as e:
            suffix = f" {e.status}" if e.status is not None else ""
            log_warn(
                f"[search] Tavily unavailable ({e.kind}{suffix}): {e} — "
                "falling back to DuckDuckGo"
            )
    else:
        log_info("[search] No Tavily API key configured — using the DuckDuckGo scraper")

    results = await _duck_search(trimmed, days=days)
    if not results:
        return "", [], None, []
    log_info(f"[search] DuckDuckGo returned {len(results)} results")

    # Fetch actual content from top result pages in PARALLEL
    top_urls = results[:2]
    page_results = await asyncio.gather(
        *(_fetch_page_content(r["url"]) for r in top_urls), return_exceptions=True
    )
    page_pairs = [{"url": r["url"], "content": pr if isinstance(pr, str) else None} for r, pr in zip(top_urls, page_results)]
    fetched = sum(1 for p in page_pairs if p["content"])
    log_info(f"[search] Fetched {fetched}/{len(top_urls)} pages successfully")
    for p in page_pairs:
        if p["content"]:
            log_info(f"[search]   {p['url'][:80]} ({len(p['content'])} chars)")
    return "duckduckgo", results, None, page_pairs


# ─── Search decision (model-driven) ─────────────────────────────────────────
# Whether to look something up, and what to look for, is a judgement about
# meaning — "and its population?" needs a lookup, "and its colour?" does not.
# A keyword list cannot do that, so a model decides: it sees the recent
# conversation and returns the QUERY it would search for, or nothing. It runs
# on the conversation's own model, which is already loaded and about to run
# anyway, so this costs one short round-trip instead of a second model load.
#
# Any failure below (model gone, too slow, output that is not the agreed JSON)
# returns None and the caller falls back to the keyword heuristic — a chat turn
# must never depend on this decision succeeding.

SEARCH_DECISION_TIMEOUT_S = 20.0
_DECISION_MAX_TURNS = 8
_DECISION_MAX_CHARS = 700
_DECISION_MAX_OUTPUT_TOKENS = 120

SEARCH_DECISION_INSTRUCTIONS = """You decide whether an assistant should look something up on the web before answering the user's newest message.

Search when the answer depends on facts outside the assistant's own knowledge, or on facts that change over time: news and current events, prices, statistics, releases, schedules, weather, who currently holds a position, whether something is still true, anything that happened after its training data, or any time the user asks it to look something up.

Do NOT search for: greetings and small talk, opinions, advice, writing or coding help, arithmetic, questions about this conversation itself, or things that are settled and do not change (definitions, history, well-known facts).

If the newest message refers back to something said earlier — "search it up", "look that up", "and its population?" — the query must name THAT topic, never the words of the request.

Reply with ONLY a JSON object and nothing else:
{"search": true, "query": "short search-engine keywords"}
{"search": false, "query": ""}

The query is short keywords for a search engine — not a sentence, not a question, no "please" — in the language of the conversation."""


def _decision_transcript(messages: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for message in list(messages or [])[-_DECISION_MAX_TURNS:]:
        role = message.get("role")
        if role not in ("user", "assistant"):
            continue
        text = strip_image_markers(str(message.get("content") or "")).strip()
        if not text:
            continue
        text = " ".join(text.split())[:_DECISION_MAX_CHARS]
        lines.append(f"{'User' if role == 'user' else 'Assistant'}: {text}")
    return "\n".join(lines)


def parse_search_decision(raw: str) -> dict[str, Any] | None:
    """The decision inside a model reply, or None if there isn't a usable one.

    Tolerant on purpose: models wrap JSON in prose and fences, and some emit
    "true" as a string. Anything that still isn't a clear yes/no is rejected so
    the caller falls back rather than guessing.
    """
    match = re.search(r"\{.*?\}", raw or "", re.DOTALL)
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
    except (TypeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    wants = data.get("search")
    if isinstance(wants, str):
        lowered = wants.strip().lower()
        if lowered in ("true", "yes", "1"):
            wants = True
        elif lowered in ("false", "no", "0"):
            wants = False
        else:
            # "maybe"/"unknown" is not a decision — reject it so the caller
            # falls back instead of silently treating it as "do not search".
            return None
    if not isinstance(wants, bool):
        return None
    return {"search": wants, "query": str(data.get("query") or "").strip()}


async def decide_search(
    messages: list[dict[str, Any]],
    model: str,
    base_url: str | None = None,
    api_key: str | None = None,
) -> dict[str, Any] | None:
    """Ask ``model`` whether to search, and what for.

    Returns ``{"search": bool, "query": str}``, or None when the model could not
    answer usefully — the caller then decides with the keyword heuristic.
    """
    transcript = _decision_transcript(messages)
    if not transcript:
        return None
    prompt = (
        f"{SEARCH_DECISION_INSTRUCTIONS}\n\n"
        f"Conversation so far (oldest first; the last line is the newest message):\n{transcript}"
    )
    chunks: list[str] = []
    started = time.monotonic()
    try:
        await asyncio.wait_for(
            stream_chat(
                model,
                [{"role": "system", "content": prompt}],
                chunks.append,
                StreamOptions(
                    think=False,
                    max_tokens=_DECISION_MAX_OUTPUT_TOKENS,
                    base_url=base_url,
                    api_key=api_key,
                ),
            ),
            timeout=SEARCH_DECISION_TIMEOUT_S,
        )
    except Exception as e:  # noqa: BLE001
        log_warn(
            f"[search] Search decision unavailable ({type(e).__name__}: {e}) — "
            "deciding with keywords"
        )
        return None
    reply = "".join(chunks)
    decision = parse_search_decision(reply)
    elapsed_ms = round((time.monotonic() - started) * 1000)
    if decision is None:
        log_warn(
            f"[search] Search decision was not usable ({reply.strip()[:80]!r}) — "
            "deciding with keywords"
        )
        return None
    log_info(
        f"[search] Decision: search={decision['search']} "
        f"query={decision['query']!r} ({elapsed_ms} ms, {model})"
    )
    return decision


async def _summarize_web_results(
    query: str,
    source: str,
    results: list[dict[str, str]],
    answer: str | None,
    page_pairs: list[dict[str, Any]],
) -> str | None:
    """Turn raw results into what the answering model sees, or None.

    None means nothing usable reached the model: the summarizer either refused
    (a refusal is dropped, never fed back into chat) or produced nothing. Pages
    are reported only once the content actually did reach the model — after the
    refusal guard, so the clients never list a source the answer never saw.
    """
    def emit_sources() -> None:
        report_sources(results)

    context_parts: list[str] = ["## Search Result Snippets\n"]
    if answer:
        context_parts.append(f"## Answer Summary\n{answer}")
    for r in results:
        context_parts.append(f"**{r['title']}**\nURL: {r['url']}\n{r['snippet']}")
    for pc in page_pairs:
        if pc["content"]:
            context_parts.append(f"\n## Page Content from: {pc['url']}\n{pc['content']}")

    full_context = "\n\n".join(context_parts)

    # Use the search assignment model to summarize everything
    resolved = await get_resolved_model("search")
    search_model = resolved["model"]
    from .settings_store import get_cloud_settings

    cloud = await get_cloud_settings() if resolved["source"] == "cloud" else {"cloudEndpoint": "", "cloudApiKey": ""}
    log_info(f"[search] Model: {search_model} (source: {resolved['source']})")

    summarize_prompt = f"""You are a precise web search summarizer. Your job is to extract and report ONLY facts that are EXPLICITLY stated in the text below.

User's question: "{query}"

Information gathered from web search:
{full_context}

CRITICAL RULES:
- ONLY report facts, numbers, and data that are DIRECTLY stated in the text above
- DO NOT guess, estimate, or fill in missing numbers
- DO NOT use your own knowledge to add data not in the text
- If a number appears in the text, report it exactly as stated
- If the text does not contain the requested data, say "The search results do not contain this specific information"
- Include ALL specific factual data found: temperatures, prices, statistics, names, dates, etc.
- Keep it under 500 words but include every specific fact you find"""

    summary = ""
    try:
        chunks: list[str] = []
        await stream_chat(
            search_model,
            [{"role": "system", "content": summarize_prompt}],
            lambda chunk: chunks.append(chunk),
            StreamOptions(
                think=False,
                base_url=cloud.get("cloudEndpoint") or None,
                api_key=cloud.get("cloudApiKey") or None,
            ),
        )
        summary = "".join(chunks)
    except Exception as e:  # noqa: BLE001
        log_error("[search] Summarization failed, using raw content:", e)
        emit_sources()
        return f'Recent web search results for "{query}":\n\n{full_context}'

    if _REFUSAL_RE.search(summary):
        log_info("[search] Search model refused to summarize — dropping search context for this query")
        return None

    final_context = summary or full_context
    emit_sources()
    # One line that answers "did the search actually reach the model?" — the
    # provider used, the source result count and the injected context size.
    log_info(
        f"[search] Context ready via {source}: {len(final_context)} chars "
        f"from {len(results)} results (answer={'yes' if answer else 'no'})"
    )
    return f'\U0001f4e1 Web search results for "{query}":\n\n{final_context}'


async def _run_web_search(query: str, *, days: int | None) -> SearchOutcome:
    """One provider round-trip plus summarization, honestly reported."""
    if days:
        log_info(f'[search] Time-sensitive query — looking back {days} day(s) for "{query}"')
    source, results, answer, page_pairs = await _gather_web_results(query, days=days)
    if not results:
        return SearchOutcome(query=query, attempts=[query])
    log_info(f"[search] Served by {source} ({len(results)} results)")
    context = await _summarize_web_results(query, source, results, answer, page_pairs)
    return SearchOutcome(
        query=query,
        context=context,
        sources=results if context else [],
        found=bool(context),
        attempts=[query],
    )


async def search_web(query: str) -> SearchOutcome:
    """Search the web for ``query`` and say honestly whether anything came back.

    One lookup, cached for repeats: the pipeline decides to search before the
    answer is composed, and the model may then call web_search with the same
    words — which would otherwise be a second provider round-trip. A failed
    lookup is retried once with a rewritten query before giving up, and the
    recency window is dropped on that retry so a date filter cannot be the only
    reason nothing matched.
    """
    trimmed = " ".join(str(query or "").split()).strip()
    if not trimmed:
        return SearchOutcome(query="")

    key = _cache_key(trimmed)
    cached = _cache_lookup(trimmed)
    if cached is not None:
        outcome, matched_key = cached
        report_sources(outcome.sources)
        if matched_key == key:
            log_info(
                f'[search] Cache hit for "{trimmed}" '
                f'({len(outcome.sources)} sources, found={outcome.found})'
            )
        else:
            log_info(
                f'[search] Cache near-hit for "{trimmed}" (matched "{matched_key}", '
                f'{len(outcome.sources)} sources) — the model reworded the same lookup'
            )
        # Remember the new wording too, so an identical repeat is an exact hit.
        _cache_put(key, outcome)
        return SearchOutcome(
            query=outcome.query,
            context=outcome.context,
            sources=outcome.sources,
            found=outcome.found,
            cached=True,
            attempts=list(outcome.attempts),
        )

    log_info(f'[search] Searching for: "{trimmed}"')
    outcome = await _run_web_search(trimmed, days=recency_days(trimmed))
    attempts = list(outcome.attempts)
    if not outcome.found:
        rewritten = rewrite_search_query(trimmed)
        if rewritten:
            log_info(f'[search] Nothing for "{trimmed}" — retrying as "{rewritten}"')
            outcome = await _run_web_search(rewritten, days=None)
            attempts.extend(outcome.attempts)
    result = SearchOutcome(
        query=outcome.query,
        context=outcome.context,
        sources=outcome.sources,
        found=outcome.found,
        attempts=attempts,
    )
    _cache_put(key, result)
    if result.found:
        # One line that answers "did the search actually reach the model?" —
        # the attempt count, the source count and the injected context size.
        log_info(
            f'[search] Context ready for "{trimmed}": {len(result.context or "")} chars '
            f"from {len(result.sources)} results (attempts={len(attempts)})"
        )
    else:
        log_info(f'[search] No usable results for "{trimmed}" (tried: {", ".join(attempts)})')
    return result


async def get_web_context(query: str) -> str | None:
    """The summarized context for ``query``, or None when nothing was usable.

    Thin wrapper for callers that only need the text; use :func:`search_web`
    when it also matters THAT a search ran and found nothing, or which pages it
    used.
    """
    return (await search_web(query)).context
