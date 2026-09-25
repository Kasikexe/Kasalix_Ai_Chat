"""Model capability probing — mirrors backend/src/services/model-capabilities.ts.

Auto-detect tool/thinking support by probing Ollama once per model and
persisting the result to data/model-capabilities.json.
"""

from __future__ import annotations

import asyncio
import json
import os

import httpx

from .config import get_data_dir, ollama_base_url
from .logger import error as log_error, info as log_info

# v4: adds "vision" capability (raw-image preview screenshots). Old cache
# entries without "vision" are treated as stale and re-probed.
CACHE_VERSION = 4
PROBE_TIMEOUT_S = 15.0

_caps_cache: dict[str, dict[str, bool]] = {}
_cache_loaded = False
# Single-flight probes: concurrent callers share one in-flight probe task
# instead of each hammering Ollama (3 client polls used to fire 3 identical
# probe requests, blocking /api/models for ~5s).
_inflight: dict[str, "asyncio.Task[dict[str, bool]]"] = {}


def _cache_file() -> str:
    return str(get_data_dir() / "model-capabilities.json")


async def load_cache() -> None:
    global _cache_loaded
    if _cache_loaded:
        return
    _cache_loaded = True
    try:
        with open(_cache_file(), encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return
        models = data.get("models") or data  # v1 compat
        if isinstance(data.get("version"), (int, float)) and data["version"] < CACHE_VERSION:
            log_info(f"[capabilities] Cache version {data['version']} < {CACHE_VERSION} — clearing")
            return
        for model, caps in (models or {}).items():
            if isinstance(caps, dict) and "tools" in caps and "thinking" in caps:
                _caps_cache[model] = {"tools": bool(caps["tools"]), "thinking": bool(caps["thinking"])}
        log_info(f"[capabilities] Loaded {len(_caps_cache)} cached model capabilities")
    except FileNotFoundError:
        pass
    except Exception as e:  # noqa: BLE001
        log_error("[capabilities] Failed to load cache:", e)


async def save_cache() -> None:
    try:
        os.makedirs(get_data_dir(), exist_ok=True)
        with open(_cache_file(), "w", encoding="utf-8") as f:
            json.dump({"version": CACHE_VERSION, "models": _caps_cache}, f, indent=2)
    except Exception as e:  # noqa: BLE001
        log_error("[capabilities] Failed to save cache:", e)


async def _probe_tools(model: str) -> bool | None:
    try:
        async with httpx.AsyncClient(timeout=PROBE_TIMEOUT_S) as client:
            res = await client.post(
                f"{ollama_base_url()}/api/chat",
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": "Say OK"}],
                    "stream": False,
                    "tools": [],
                },
            )
        if res.status_code >= 400:
            return False
        data = res.json()
        return data.get("message", {}).get("content") is not None
    except Exception:  # noqa: BLE001
        return None  # probe failed — caller uses fallback


async def _probe_thinking(model: str) -> bool | None:
    try:
        async with httpx.AsyncClient(timeout=PROBE_TIMEOUT_S) as client:
            res = await client.post(
                f"{ollama_base_url()}/api/chat",
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": "What is 2+2?"}],
                    "stream": False,
                    "think": True,
                },
            )
        if res.status_code >= 400:
            return False
        data = res.json()
        msg = data.get("message", {})
        return bool(msg.get("thinking") or msg.get("reasoning"))
    except Exception:  # noqa: BLE001
        return None


async def _probe_vision(model: str) -> bool | None:
    """True when the model accepts image inputs. Sends a 1x1 red PNG and asks
    what color dominates. Vision models answer about the image; text-only
    models either error (Ollama rejects images for non-multimodal models) or
    answer without seeing any color. Returns None when Ollama is unreachable."""
    # 1x1 fully-red PNG, base64
    red_dot = (
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAE/AF/"
        "mAHDLwAAAABJRU5ErkJggg=="
    )
    try:
        async with httpx.AsyncClient(timeout=PROBE_TIMEOUT_S) as client:
            res = await client.post(
                f"{ollama_base_url()}/api/chat",
                json={
                    "model": model,
                    "messages": [{
                        "role": "user",
                        "content": "What is the dominant color of this image? Answer with a single word.",
                        "images": [red_dot],
                    }],
                    "stream": False,
                },
            )
        if res.status_code == 404:
            return None  # model not installed — unknown, use name fallback
        if res.status_code >= 400:
            return False  # model exists but rejected the image — not vision
        text = str(res.json().get("message", {}).get("content") or "").lower()
        return "red" in text
    except Exception:  # noqa: BLE001
        return None  # probe failed — caller uses fallback


FALLBACK_TOOL_MODELS = [
    "qwen3", "qwen2.5", "qwen2.5-coder", "llama3.1", "llama3.2", "llama3.3",
    "mistral", "mixtral", "gemma3", "phi4", "phi-4", "gpt-oss",
    "command-r", "aya-expanse", "minicpm-v", "nemotron", "molmo",
    "minimax", "deepseek", "glm", "internlm",
]

FALLBACK_THINKING_MODELS = [
    "qwen3", "qwen", "deepseek-r1", "qwq", "magpie", "kimi", "glm", "internlm",
]


def _fallback_vision(model: str) -> bool:
    """Name-based vision detection — Ollama vision models ship a text+vision
    projector under these family names. Cheap and offline; the probe below
    is the authoritative check."""
    lower = model.lower()
    families = (
        "llava", "minicpm-v", "moondream", "bakllava", "llama3.2-vision",
        "granite3.1-vision", "qwen2.5vl", "qwen2-vl", "qwen2vl", "qwen3-vl",
        "qwen-vl", "gemma3", "pixtral", "mistral-small3.1", "glm-4v", "molmo",
    )
    return any(f in lower for f in families)


def _fallback_tools(model: str) -> bool:
    lower = model.lower()
    return any(m in lower for m in FALLBACK_TOOL_MODELS)


def _fallback_thinking(model: str) -> bool:
    lower = model.lower()
    return any(m in lower for m in FALLBACK_THINKING_MODELS)


async def get_model_capabilities(model: str) -> dict[str, bool]:
    cached = _caps_cache.get(model)
    if cached:
        return cached

    existing = _inflight.get(model)
    if existing is not None and not existing.done():
        return await existing

    async def _do_probe() -> dict[str, bool]:
        log_info(f"[capabilities] Probing model: {model}")
        # Both probes hit the same model — run them concurrently (on a cold
        # model each probe pays the model load; serial = double that).
        probe_tools_res, probe_thinking_res = await asyncio.gather(
            _probe_tools(model), _probe_thinking(model)
        )
        tools = probe_tools_res if probe_tools_res is not None else _fallback_tools(model)
        # Trust the name-based fallback over the probe for known thinking models.
        # Probes can miss thinking that comes via <think> tags instead of a field.
        thinking = probe_thinking_res is True or _fallback_thinking(model)
        vision = await _probe_vision(model)
        if vision is None:
            vision = _fallback_vision(model)

        log_info(f"[capabilities] {model}: tools={tools}, thinking={thinking}, vision={vision}")
        cache_entry = {"tools": tools, "thinking": thinking, "vision": vision}
        _caps_cache[model] = cache_entry
        await save_cache()
        return cache_entry

    task = asyncio.ensure_future(_do_probe())
    _inflight[model] = task
    try:
        return await task
    finally:
        _inflight.pop(model, None)


async def supports_thinking_fast(model: str) -> bool:
    """Cached or name-fallback only — NEVER blocks on a probe. Used by
    /api/models so listing models stays instant; a background probe fills
    the cache for next time."""
    await load_cache()
    cached = _caps_cache.get(model)
    if cached:
        return cached["thinking"]
    asyncio.ensure_future(get_model_capabilities(model))
    return _fallback_thinking(model)


async def supports_tools(model: str) -> bool:
    try:
        return (await get_model_capabilities(model))["tools"]
    except Exception:  # noqa: BLE001
        return _fallback_tools(model)


async def supports_thinking(model: str) -> bool:
    try:
        return (await get_model_capabilities(model))["thinking"]
    except Exception:  # noqa: BLE001
        return _fallback_thinking(model)


async def probe_all_models() -> None:
    """Probe all installed models at startup (non-blocking background task)."""
    try:
        await load_cache()
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.get(f"{ollama_base_url()}/api/tags")
        if res.status_code >= 400:
            return
        models = res.json().get("models") or []
        uncached = [m for m in models if m.get("name") not in _caps_cache]
        if not uncached:
            log_info(f"[capabilities] All {len(models)} models already cached — skipping probe")
            return
        log_info(f"[capabilities] {len(uncached)} new model(s) to probe ({len(_caps_cache)} cached)...")
        # Probe in batches to avoid overwhelming Ollama
        BATCH = 3
        for i in range(0, len(uncached), BATCH):
            await asyncio.gather(
                *(get_model_capabilities(m["name"]) for m in uncached[i : i + BATCH]),
                return_exceptions=True,
            )
        log_info(f"[capabilities] Probe complete — {len(_caps_cache)} models total")
    except Exception as e:  # noqa: BLE001
        log_error("[capabilities] Startup probe failed:", e)


async def clear_capabilities_cache() -> None:
    _caps_cache.clear()
    try:
        os.remove(_cache_file())
    except FileNotFoundError:
        pass
