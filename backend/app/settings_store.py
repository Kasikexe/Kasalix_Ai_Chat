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
    # ALC (Advanced Learning Cycle) — see docs/ALC_DESIGN.md
    "alcDocsPaths": [],
    "alcMaxCycles": 3,
    "alcMaxToolCalls": 12,
    "alcMaxTokens": 4000,
    "alcWebEnabled": True,
    "alcWriteKnowledge": True,
    "alcStudyMaxTopics": 2,
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


# ─── ALC (Advanced Learning Cycle) ──────────────────────────────────────
# Budgets are clamped here, not in the UI: a hand-edited settings.json must not
# be able to turn the gather loop unbounded.
ALC_MAX_CYCLES_LIMIT = 6
ALC_MAX_TOOL_CALLS_LIMIT = 20
ALC_MAX_TOKENS_LIMIT = 6000
ALC_MAX_DOC_PATHS = 20
# One study per topic is one internal model call, so this is a spend limit.
ALC_MAX_STUDY_TOPICS = 5


def coerce_limit(value: Any, default: int, low: int, high: int) -> int:
    """Clamp an ALC budget setting; junk falls back to the default."""
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(parsed, high))


def coerce_alc_paths(value: Any) -> list[str]:
    """Documentation folders: list of non-empty strings, de-duplicated and capped."""
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, (list, tuple)):
        return []
    paths: list[str] = []
    for entry in value:
        if not isinstance(entry, str):
            continue
        path = entry.strip()
        if path and path not in paths:
            paths.append(path)
    return paths[:ALC_MAX_DOC_PATHS]


async def get_alc_settings() -> dict[str, Any]:
    """ALC settings — used by the ALC controller for every cycle."""
    parsed = read_settings_cached()
    return {
        "alcDocsPaths": coerce_alc_paths(parsed.get("alcDocsPaths")),
        "alcMaxCycles": coerce_limit(parsed.get("alcMaxCycles"), 3, 1, ALC_MAX_CYCLES_LIMIT),
        "alcMaxToolCalls": coerce_limit(parsed.get("alcMaxToolCalls"), 12, 1, ALC_MAX_TOOL_CALLS_LIMIT),
        "alcMaxTokens": coerce_limit(parsed.get("alcMaxTokens"), 4000, 500, ALC_MAX_TOKENS_LIMIT),
        "alcWebEnabled": parsed.get("alcWebEnabled") is not False,
        "alcWriteKnowledge": parsed.get("alcWriteKnowledge") is not False,
        "alcStudyMaxTopics": coerce_limit(parsed.get("alcStudyMaxTopics"), 2, 0, ALC_MAX_STUDY_TOPICS),
    }
