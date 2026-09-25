"""Web search service — mirrors backend/src/services/search.ts.

DuckDuckGo HTML search, parallel page fetch with text extraction, then AI
summarization by the assigned search model. Refusal-safe: a safety-tuned
summarizer's refusal is treated as "no useful context" instead of being fed
back into chat.
"""

from __future__ import annotations

import asyncio
import html as html_lib
import re
import time
from typing import Any

import httpx

from .logger import error as log_error, info as log_info
from .model_assignments import get_resolved_model
from .ollama_client import StreamOptions, stream_chat

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
MIN_DELAY_S = 1.5
_last_search_time = 0.0

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


async def _duck_search_html(query: str, max_results: int = 5) -> list[dict[str, str]]:
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
        res = await client.post("https://html.duckduckgo.com/html/", headers=headers, data={"q": query})
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


async def _duck_search_lite(query: str, max_results: int = 5) -> list[dict[str, str]]:
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
        res = await client.get("https://lite.duckduckgo.com/lite/", params={"q": query}, headers=headers)
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


async def _ddgs_library_search(query: str, max_results: int = 5) -> list[dict[str, str]]:
    """Primary: the ddgs library. It rotates search backends and handles
    DuckDuckGo's anti-bot challenges (browser impersonation) — the raw HTML
    endpoints below get 202-challenged after a few requests from server IPs.
    Runs in a thread: ddgs is sync-only."""
    from ddgs import DDGS  # lazy import — keeps startup fast if unused

    def run() -> list[dict[str, str]]:
        out: list[dict[str, str]] = []
        with DDGS() as ddgs:
            for r in ddgs.text(query, max_results=max_results):
                out.append({
                    "title": str(r.get("title") or "").strip(),
                    "url": str(r.get("href") or "").strip(),
                    "snippet": str(r.get("body") or "").strip(),
                })
        return out

    results = await asyncio.to_thread(run)
    if not results:
        raise RuntimeError("ddgs library returned no results")
    return results


async def _duck_search(query: str, max_results: int = 5) -> list[dict[str, str]]:
    """Search DuckDuckGo with rate limiting, engine fallback, and retry.

    Order: ddgs library (challenge-proof) → raw HTML endpoint → raw Lite
    endpoint, then one full retry pass. Failures are logged WITH the exception
    type so outages are diagnosable instead of silently returning nothing.
    """
    global _last_search_time
    now = time.monotonic()
    elapsed = now - _last_search_time
    if elapsed < MIN_DELAY_S:
        await asyncio.sleep(MIN_DELAY_S - elapsed)
    _last_search_time = time.monotonic()

    engines: list[tuple[str, Any]] = [
        ("ddgs", _ddgs_library_search),
        ("html", _duck_search_html),
        ("lite", _duck_search_lite),
    ]
    last_err: Exception | None = None
    for pass_num in (1, 2):  # one full chain, then one retry of the chain
        for name, fn in engines:
            try:
                results = await fn(query, max_results)
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


async def get_web_context(query: str) -> str | None:
    """Search the web and return AI-summarized context with page content."""
    trimmed = query.strip()
    if not trimmed:
        return None

    log_info(f'[search] Searching for: "{trimmed}"')

    results = await _duck_search(trimmed)
    if not results:
        return None
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

    context_parts: list[str] = ["## Search Result Snippets\n"]
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

User's question: "{trimmed}"

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
        return f'Recent web search results for "{trimmed}":\n\n{full_context}'

    if _REFUSAL_RE.search(summary):
        log_info("[search] Search model refused to summarize — dropping search context for this query")
        return None

    return f'\U0001f4e1 Web search results for "{trimmed}":\n\n{summary or full_context}'
