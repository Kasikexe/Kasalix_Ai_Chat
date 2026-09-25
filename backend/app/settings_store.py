"""Settings store — mirrors backend/src/routes/settings.ts (storage part).

Reads/writes data/settings.json with a short in-memory cache. Kept separate
from the FastAPI router so services can import it without circular imports
(the TS version had services importing from the route file).
"""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any

from .config import get_data_dir
from .logger import info as log_info

SETTINGS_CACHE_TTL = 2.0  # seconds
_settings_cache: tuple[dict[str, Any], float] | None = None


def settings_file() -> Path:
    return get_data_dir() / "settings.json"


DEFAULT_SETTINGS: dict[str, Any] = {
    "hiddenModels": [],
    "modelAssignments": {},
    "cloudModelAssignments": {},
    "cloudMode": "auto",
    "cloudApiKey": "",
    "cloudEndpoint": "",
    "tavilyApiKey": "",
    "kvCacheOffload": True,
    "kvCacheType": "f16",
    "defaultNumCtx": 0,
    # Ollama concurrency tuning (0 / "" = Auto → env var NOT set)
    "ollamaNumParallel": 0,
    "ollamaMaxLoadedModels": 0,
    "ollamaKeepAlive": "",
    "updatedAt": 0,
}


async def load_settings() -> dict[str, Any]:
    try:
        with open(settings_file(), encoding="utf-8") as f:
            data = json.load(f)
        return {**DEFAULT_SETTINGS, **data}
    except FileNotFoundError:
        return dict(DEFAULT_SETTINGS)
    except Exception:  # noqa: BLE001
        return dict(DEFAULT_SETTINGS)


async def save_settings(settings: dict[str, Any]) -> dict[str, Any]:
    settings_file().parent.mkdir(parents=True, exist_ok=True)
    with open(settings_file(), "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2)
    return settings


def read_settings_cached() -> dict[str, Any]:
    """Synchronous cached read — matches the TS 2s TTL cache semantics."""
    global _settings_cache
    if _settings_cache and time.time() - _settings_cache[1] < SETTINGS_CACHE_TTL:
        return _settings_cache[0]
    try:
        with open(settings_file(), encoding="utf-8") as f:
            parsed = json.load(f)
        _settings_cache = (parsed, time.time())
        return parsed
    except Exception:  # noqa: BLE001
        return {}


def invalidate_settings_cache() -> None:
    global _settings_cache
    _settings_cache = None


async def get_cloud_settings() -> dict[str, str]:
    """Cloud routing settings — used by the pipeline and health checks."""
    parsed = read_settings_cached()
    return {
        "cloudMode": parsed.get("cloudMode") or "auto",
        "cloudApiKey": parsed.get("cloudApiKey") or "",
        "cloudEndpoint": parsed.get("cloudEndpoint") or "",
    }


async def get_tavily_api_key() -> str:
    """Tavily (web search) API key.

    The value saved in Settings wins so the GUI stays authoritative; the
    TAVILY_API_KEY env var is only a fallback for headless/ops setups.
    """
    parsed = read_settings_cached()
    return (parsed.get("tavilyApiKey") or os.environ.get("TAVILY_API_KEY") or "").strip()


def coerce_num_setting(v: Any, maximum: int = 16) -> int:
    """Parse an Ollama parallelism setting. 0/invalid/negative → 0 (Auto)."""
    try:
        n = int(v)
    except (TypeError, ValueError):
        return 0
    return max(0, min(n, maximum)) if n > 0 else 0


def coerce_keep_alive(v: Any) -> str:
    """Validate an OLLAMA_KEEP_ALIVE value ('5m', '30s', '2h', '3600', -1).
    '' / invalid → '' (Auto → env var NOT set)."""
    s = str(v or "").strip()
    if not s:
        return ""
    if re.fullmatch(r"-?\d+(\.\d+)?(ms|s|m|h)?", s):
        return s
    return ""


async def get_ollama_settings() -> dict[str, Any]:
    parsed = read_settings_cached()
    return {
        "kvCacheOffload": parsed.get("kvCacheOffload") is not False,
        "kvCacheType": parsed.get("kvCacheType") or "f16",
        "defaultNumCtx": parsed.get("defaultNumCtx") or 0,
        "ollamaNumParallel": coerce_num_setting(parsed.get("ollamaNumParallel")),
        "ollamaMaxLoadedModels": coerce_num_setting(parsed.get("ollamaMaxLoadedModels")),
        "ollamaKeepAlive": coerce_keep_alive(parsed.get("ollamaKeepAlive")),
    }
