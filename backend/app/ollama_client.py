"""Ollama client — mirrors backend/src/services/ollama.ts.

Async streaming chat with thinking/tool-call support, non-streaming chat, and
a 30s model-list cache. Keep log line prefixes identical to the TS backend so
the server-gui log colorizer keeps working.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Any, AsyncIterator, Awaitable, Callable

import httpx

from .capabilities import (
    mark_thinking_unsupported,
    mark_tools_unsupported,
    supports_thinking,
    supports_tools,
)
from .config import get_data_dir, ollama_base_url
from .logger import error as log_error, info as log_info, warn as log_warn
from .models import Message, ToolLoopMessage


# ─── Default num_ctx from settings ───────────────────────────
_num_ctx_cache: float | None = None


def _num_ctx_file() -> str:
    return str(get_data_dir() / "settings.json")


async def _get_default_num_ctx() -> float:
    global _num_ctx_cache
    if _num_ctx_cache is not None:
        return _num_ctx_cache
    try:
        with open(_num_ctx_file(), encoding="utf-8") as f:
            parsed = json.load(f)
        _num_ctx_cache = parsed.get("defaultNumCtx") or 0
    except FileNotFoundError:
        _num_ctx_cache = 0
    except Exception:  # noqa: BLE001
        _num_ctx_cache = 0
    return _num_ctx_cache


def invalidate_num_ctx_cache() -> None:
    global _num_ctx_cache
    _num_ctx_cache = None


async def model_supports_thinking(model_name: str) -> bool:
    return await supports_thinking(model_name)


async def model_supports_tools(model_name: str) -> bool:
    from .capabilities import supports_tools

    return await supports_tools(model_name)


# ─── Model List Cache (30s TTL) ────────────────────────────
MODEL_CACHE_TTL = 30.0
_model_cache: tuple[list[dict[str, Any]], float] | None = None


async def get_models() -> list[dict[str, Any]]:
    global _model_cache
    if _model_cache and time.time() * 1000 - _model_cache[1] < MODEL_CACHE_TTL * 1000:
        return _model_cache[0]

    async with httpx.AsyncClient(timeout=30) as client:
        res = await client.get(f"{ollama_base_url()}/api/tags")
    if res.status_code >= 400:
        raise RuntimeError(f"Failed to fetch models from Ollama: {res.reason_phrase}")
    models = res.json().get("models") or []
    _model_cache = (models, time.time() * 1000)
    return models


def clear_model_cache() -> None:
    global _model_cache
    _model_cache = None


def convert_messages_for_ollama(messages: list[Message | ToolLoopMessage]) -> list[dict[str, Any]]:
    import re

    valid_roles = {"user", "assistant", "system", "tool"}
    out: list[dict[str, Any]] = []
    image_re = re.compile(r"\[image:(data:image\/[a-z]+;base64,([A-Za-z0-9+/=]+))\]")
    for msg in messages:
        role = msg.get("role")
        if role not in valid_roles:
            continue
        content = msg.get("content", "")
        m = image_re.search(content)
        if m:
            text_content = image_re.sub("", content).strip()
            out.append(
                {
                    "role": role,
                    "content": text_content or "Describe this image.",
                    "images": [m.group(2)],
                }
            )
            continue
        base: dict[str, Any] = {"role": role, "content": content}
        tool_calls = msg.get("tool_calls") if "tool_calls" in msg else None
        if tool_calls:
            base["tool_calls"] = tool_calls
        out.append(base)
    return out


class StreamOptions:
    __slots__ = (
        "signal", "temperature", "top_p", "max_tokens", "think",
        "on_thinking", "base_url", "api_key", "on_metrics",
    )

    def __init__(
        self,
        signal: asyncio.Event | None = None,
        temperature: float | None = None,
        top_p: float | None = None,
        max_tokens: int | None = None,
        think: bool | None = None,
        on_thinking: Callable[[str], None] | None = None,
        base_url: str | None = None,
        api_key: str | None = None,
        on_metrics: Callable[[dict[str, int]], None] | None = None,
    ) -> None:
        self.signal = signal
        self.temperature = temperature
        self.top_p = top_p
        self.max_tokens = max_tokens
        self.think = think
        self.on_thinking = on_thinking
        self.base_url = base_url
        self.api_key = api_key
        self.on_metrics = on_metrics


def _build_options(opts: StreamOptions, body: dict[str, Any]) -> None:
    options = body.setdefault("options", {})
    if opts.temperature is not None:
        options["temperature"] = opts.temperature
    if opts.top_p is not None:
        options["top_p"] = opts.top_p
    if opts.max_tokens is not None:
        options["num_predict"] = opts.max_tokens
    return None


class OllamaError(Exception):
    """Ollama API error — message matches the TS `Ollama error (status): text`."""


def _unsupported_tools_error(message: str) -> bool:
    return bool(re.search(r"does not support tools|no tool support|tools are not supported", message, re.I))


def _unsupported_thinking_error(message: str) -> bool:
    return bool(re.search(r"does not support thinking|thinking is not supported", message, re.I))


async def _request_with_capability_heal(
    model: str,
    body: dict[str, Any],
    call: Callable[[], Awaitable[Any]],
) -> Any:
    """Run one chat request, healing an over-eager capability guess.

    Ollama REJECTS THE WHOLE REQUEST when a model's template has no tool or
    thinking support: `400 ... does not support tools`. One wrong guess about a
    model's capabilities therefore cost the user the entire reply (empty answer
    plus a misleading "cloud provider unavailable" toast). Now the offending
    optional field is dropped, remembered for next time, and the request is
    retried — the answer always wins over the metadata.
    """
    for _ in range(3):
        try:
            return await call()
        except OllamaError as e:
            message = str(e)
            dropped = ""
            if body.get("tools") and _unsupported_tools_error(message):
                body.pop("tools", None)
                dropped = "tool definitions"
                await mark_tools_unsupported(model)
            elif body.get("think") and _unsupported_thinking_error(message):
                body.pop("think", None)
                dropped = "thinking"
                await mark_thinking_unsupported(model)
            if not dropped:
                raise
            log_warn(f"[ollama] {model} rejected {dropped} — retrying without them ({message[:120]})")
    return await call()


class GenerationRepetitionError(OllamaError):
    """The model degenerated into a repetition loop mid-stream (thinking or
    content). Small local models sometimes re-emit the same phrase forever —
    without this guard the stream burns the whole context window at tok/s
    speed (minutes of GPU time producing nothing). Kill it early."""


# ─── Stream degeneration guard ─────────────────────────────────────────
# Windows over this window → the model is stuck re-emitting the same text.
# Defaults: ~3000-char tail / 40 lines / 14+ repeats of one line /
# an exactly periodic tail (period 10–400 chars).
REPETITION_CHECK_WINDOW = 3000
REPETITION_MIN_LINES = 40
REPETITION_MIN_REPEATS = 14


def _looks_degenerate(text: str) -> bool:
    """True when the tail of a stream is a repetition loop. Three detectors
    (any one trips it): a single line repeated ≥14×, the same short phrase
    starting ≥32 of the last 40 lines, or an exactly periodic tail (the
    classic degenerate-loop signature, works with or without newlines)."""
    if not text or len(text) < 400:
        return False
    tail = text[-REPETITION_CHECK_WINDOW:]
    lines = [l.strip() for l in tail.split("\n") if l.strip()]
    if len(lines) >= REPETITION_MIN_LINES:
        # (a) one identical line many times
        from collections import Counter
        _, top = Counter(lines).most_common(1)[0]
        if top >= REPETITION_MIN_REPEATS:
            return True
        # (b) same first-6-words phrase starting most of the last 40 lines
        prefs = [" ".join(l.split()[:6]).lower() for l in lines]
        tail40 = prefs[-REPETITION_MIN_LINES:]
        same = sum(1 for p in tail40 if p == tail40[-1] and p)
        if same >= REPETITION_MIN_LINES - 8:
            return True
    # (c) exactly periodic tail — the model re-emits the same span forever
    tail600 = text[-600:]
    for period in range(10, 401):
        if tail600[period:] == tail600[:-period]:
            return True
    return False


async def _stream_response(
    endpoint: str,
    body: dict[str, Any],
    opts: StreamOptions,
    log_line: str,
    on_chunk: Callable[[str], None] | None,
    collect_tool_calls: bool,
) -> tuple[str, list[dict[str, Any]], dict[str, int]]:
    """Shared NDJSON stream reader for both streaming chat variants.
    Returns (content, tool_calls, metrics) — metrics carries Ollama's
    eval_count / eval_duration_ns from the final chunk for tok/s display."""
    headers = {"Content-Type": "application/json"}
    if opts.api_key:
        headers["Authorization"] = f"Bearer {opts.api_key}"

    log_info(log_line)

    content = ""
    tool_calls: list[dict[str, Any]] = []
    total_chunks = 0
    thinking_skipped = 0
    # Degeneration guard: tail of the stream (content AND thinking separately
    # — a thinking loop must not be masked by normal content, and vice versa).
    thinking_tail = ""
    last_thinking_check = 0  # only re-run the (cheap) check on new material
    last_content_check = 0
    # Ollama reports real generation stats on the final chunk: eval_count =
    # tokens generated, eval_duration = ns spent generating (prompt processing
    # excluded). These give an honest tokens/s for the client UI.
    eval_count = 0
    eval_duration_ns = 0

    timeout = httpx.Timeout(120.0 if opts.api_key else None, read=120.0 if opts.api_key else None)
    async with httpx.AsyncClient(timeout=timeout) as client:
        # Stop must work even when the stream is STALLED (no chunks arriving —
        # the model silently thinking, a wedged connection). The per-chunk
        # signal check inside the read loop can't fire without data, so a
        # watcher task closes the client on stop; httpx raises immediately.
        stop_task: asyncio.Task | None = None

        async def _watch_stop() -> None:
            assert opts.signal is not None
            await opts.signal.wait()
            await client.aclose()

        if opts.signal is not None:
            stop_task = asyncio.create_task(_watch_stop())
        try:
            async with client.stream(
                "POST", f"{endpoint}/api/chat", json=body, headers=headers
            ) as res:
                if res.status_code >= 400:
                    error_text = (await res.aread()).decode("utf-8", "replace")
                    log_error(f"[ollama] Error {res.status_code}: {error_text}")
                    if res.status_code in (401, 403):
                        is_cloud = endpoint.startswith("https") and "localhost" not in endpoint and "127.0.0.1" not in endpoint
                        hint = " — your cloud API key is invalid, expired or revoked. Check it in Settings → Cloud." if is_cloud else ""
                        raise OllamaError(f"Ollama error ({res.status_code}): Authentication failed{hint}")
                    raise OllamaError(f"Ollama error ({res.status_code}): {error_text or res.reason_phrase}")

                buffer = ""
                async for raw in res.aiter_text():
                    if opts.signal is not None and opts.signal.is_set():
                        raise asyncio.CancelledError()
                    buffer += raw
                    lines = buffer.split("\n")
                    buffer = lines.pop() or ""
                    for line in lines:
                        trimmed = line.strip()
                        if not trimmed:
                            continue
                        try:
                            data = json.loads(trimmed)
                        except json.JSONDecodeError:
                            continue
                        if data.get("error"):
                            log_error("[ollama] Stream error:", data["error"])
                            raise OllamaError(data["error"])

                        msg = data.get("message") or {}
                        thinking_text = msg.get("reasoning") or msg.get("thinking")
                        if thinking_text:
                            thinking_skipped += 1
                            thinking_tail += thinking_text
                            if len(thinking_tail) - last_thinking_check >= 500:
                                last_thinking_check = len(thinking_tail)
                                if _looks_degenerate(thinking_tail):
                                    log_error("[ollama] Stream degenerated into a repetition loop (thinking) — aborting to save GPU time")
                                    raise GenerationRepetitionError("The model got stuck repeating itself in its thinking stream (degeneration). The run was aborted early — try rephrasing, lower the temperature, or switch to a stronger model.")
                            if opts.on_thinking:
                                opts.on_thinking(thinking_text)
                            continue

                        if msg.get("content"):
                            total_chunks += 1
                            content += msg["content"]
                            if len(content) - last_content_check >= 500:
                                last_content_check = len(content)
                                if _looks_degenerate(content):
                                    log_error("[ollama] Stream degenerated into a repetition loop (content) — aborting to save GPU time")
                                    raise GenerationRepetitionError("The model got stuck repeating itself (degeneration). The run was aborted early — try rephrasing, lower the temperature, or switch to a stronger model.")
                            if on_chunk:
                                on_chunk(msg["content"])
                        if collect_tool_calls and isinstance(msg.get("tool_calls"), list):
                            for tc in msg["tool_calls"]:
                                if tc and tc.get("function", {}).get("name"):
                                    tool_calls.append(tc)
                        if data.get("done"):
                            eval_count = int(data.get("eval_count") or 0)
                            eval_duration_ns = int(data.get("eval_duration") or 0)
                            if opts.on_metrics and eval_count > 0:
                                try:
                                    opts.on_metrics({"eval_count": eval_count, "eval_duration_ns": eval_duration_ns})
                                except Exception:  # noqa: BLE001
                                    pass
                            return content, tool_calls, {"eval_count": eval_count, "eval_duration_ns": eval_duration_ns}
        except RuntimeError:
            # Closing the client mid-stream from the stop watcher surfaces as
            # "Event loop is closed"/"client has been closed" RuntimeError —
            # that IS the stop signal arriving.
            if opts.signal is not None and opts.signal.is_set():
                raise asyncio.CancelledError()
            raise
        except httpx.StreamError:
            if opts.signal is not None and opts.signal.is_set():
                raise asyncio.CancelledError()
            raise
        finally:
            if stop_task is not None and not stop_task.done():
                stop_task.cancel()
    return content, tool_calls, {"eval_count": eval_count, "eval_duration_ns": eval_duration_ns}



async def stream_chat(
    model: str,
    messages: list[Message | ToolLoopMessage],
    on_chunk: Callable[[str], None],
    options: StreamOptions | None = None,
) -> None:
    """Stream a chat completion; forwards chunks to on_chunk. Returns nothing,
    matching the TS signature (thinking goes to on_thinking)."""
    opts = options or StreamOptions()
    body: dict[str, Any] = {
        "model": model,
        "messages": convert_messages_for_ollama(messages),
        "stream": True,
    }
    _build_options(opts, body)
    num_ctx = await _get_default_num_ctx()
    if num_ctx and not body["options"].get("num_ctx"):
        body["options"]["num_ctx"] = num_ctx
    if await supports_thinking(model):
        body["think"] = opts.think is True

    endpoint = opts.base_url or ollama_base_url()
    log_line = (
        f"[ollama] Model: {model}, think: {body.get('think', 'n/a')}, "
        f"temp: {opts.temperature if opts.temperature is not None else 'default'}, endpoint: {endpoint}"
    )

    async def _run() -> tuple[str, list[dict[str, Any]], dict[str, int]]:
        return await _stream_response(endpoint, body, opts, log_line, on_chunk, collect_tool_calls=False)

    await _request_with_capability_heal(model, body, _run)


async def stream_chat_with_tools(
    model: str,
    messages: list[Message | ToolLoopMessage],
    tools: list[dict[str, Any]],
    on_chunk: Callable[[str], None] | None,
    options: StreamOptions | None = None,
) -> dict[str, Any]:
    """One round of model-driven tool calling. Returns {content, toolCalls}."""
    opts = options or StreamOptions()
    body: dict[str, Any] = {
        "model": model,
        "messages": convert_messages_for_ollama(messages),
        "stream": True,
    }
    # Only hand tool definitions to a model that accepts them — Ollama 400s the
    # ENTIRE request for a model whose template has no tool support, and that
    # used to wipe out the answer. The local capability probe describes THIS
    # machine's Ollama, so a custom (cloud) endpoint keeps its tools: a model
    # hosted remotely may not be installed here, and a wrong guess is healed
    # below anyway.
    if tools:
        # Local Ollama: consult the probe. Custom (cloud) endpoint: keep the
        # tools — the probe describes THIS machine's models, and a model hosted
        # remotely may not be installed here at all. The heal below catches a
        # wrong guess either way.
        if opts.base_url or await supports_tools(model):
            body["tools"] = tools
        else:
            log_info(f"[ollama] {model} has no tool support — this round runs without tool definitions")
    _build_options(opts, body)
    num_ctx = await _get_default_num_ctx()
    if num_ctx and not body["options"].get("num_ctx"):
        body["options"]["num_ctx"] = num_ctx
    if await supports_thinking(model):
        body["think"] = opts.think is True

    endpoint = opts.base_url or ollama_base_url()
    log_line = (
        f"[ollama] Tool round — model: {model}, tools: {len(body.get('tools') or [])}, "
        f"think: {body.get('think', 'n/a')}, endpoint: {endpoint}"
    )

    async def _run_round() -> tuple[str, list[dict[str, Any]], dict[str, int]]:
        return await _stream_response(
            endpoint, body, opts, log_line, on_chunk, collect_tool_calls=True
        )

    content, tool_calls, metrics = await _request_with_capability_heal(model, body, _run_round)
    tps = 0.0
    if metrics.get("eval_count") and metrics.get("eval_duration_ns"):
        tps = metrics["eval_count"] / (metrics["eval_duration_ns"] / 1e9)
        log_info(f"[ollama] Tool round done. content: {len(content)} chars, tool_calls: {len(tool_calls)}, {metrics['eval_count']} tok @ {tps:.1f} tok/s")
    else:
        log_info(f"[ollama] Tool round done. content: {len(content)} chars, tool_calls: {len(tool_calls)}")
    return {"content": content, "toolCalls": tool_calls, "metrics": metrics, "tokensPerSecond": round(tps, 1)}


async def chat(
    model: str,
    messages: list[Message | ToolLoopMessage],
    options: StreamOptions | None = None,
) -> str:
    """Non-streaming chat — full response at once (fast for titles etc.)."""
    opts = options or StreamOptions()
    body: dict[str, Any] = {
        "model": model,
        "messages": convert_messages_for_ollama(messages),
        "stream": False,
    }
    _build_options(opts, body)
    num_ctx = await _get_default_num_ctx()
    if num_ctx and not body["options"].get("num_ctx"):
        body["options"]["num_ctx"] = num_ctx
    if await supports_thinking(model):
        body["think"] = opts.think is True

    endpoint = opts.base_url or ollama_base_url()
    headers = {"Content-Type": "application/json"}
    if opts.api_key:
        headers["Authorization"] = f"Bearer {opts.api_key}"
    log_info(
        f"[ollama] Non-streaming — model: {model}, "
        f"temp: {opts.temperature if opts.temperature is not None else 'default'}, endpoint: {endpoint}"
    )

    async def _post() -> dict[str, Any]:
        timeout = 120.0 if opts.api_key else None
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.post(f"{endpoint}/api/chat", json=body, headers=headers)
        if res.status_code >= 400:
            if res.status_code in (401, 403):
                is_cloud = endpoint.startswith("https") and "localhost" not in endpoint and "127.0.0.1" not in endpoint
                hint = " — your cloud API key is invalid, expired or revoked. Check it in Settings → Cloud." if is_cloud else ""
                raise OllamaError(f"Ollama error ({res.status_code}): Authentication failed{hint}")
            raise OllamaError(f"Ollama error ({res.status_code}): {res.text[:500] or res.reason_phrase}")
        data = res.json()
        if data.get("error"):
            raise OllamaError(data["error"])
        return data

    data = await _request_with_capability_heal(model, body, _post)
    return (data.get("message") or {}).get("content") or ""
