"""Memory service — mirrors backend/src/services/memory.ts.

Per-user memory stored in data/memory/<user>.json, 5s cache, serialized
writes per user to prevent race conditions between concurrent extractions.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from pathlib import Path
from typing import Any

from .config import get_data_dir
from .logger import error as log_error

MEMORY_CACHE_TTL = 5.0
_memory_cache: dict[str, tuple[dict[str, Any], float]] = {}
_write_locks: dict[str, asyncio.Lock] = {}

DEFAULT_MEMORY: dict[str, Any] = {"enabled": False, "categories": {}, "updatedAt": 0}


def _memory_dir() -> Path:
    return get_data_dir() / "memory"


def _memory_file_path(user_id: str) -> Path:
    safe = re.sub(r"[^a-zA-Z0-9_\-]", "_", user_id)
    return _memory_dir() / f"{safe}.json"


def _get_cached(user_id: str) -> dict[str, Any] | None:
    entry = _memory_cache.get(user_id)
    if entry and time.time() * 1000 - entry[1] < MEMORY_CACHE_TTL * 1000:
        return entry[0]
    return None


def _lock_for(user_id: str) -> asyncio.Lock:
    if user_id not in _write_locks:
        _write_locks[user_id] = asyncio.Lock()
    return _write_locks[user_id]


async def get_memory(user_id: str) -> dict[str, Any]:
    cached = _get_cached(user_id)
    if cached is not None:
        return cached
    try:
        with open(_memory_file_path(user_id), encoding="utf-8") as f:
            data = json.load(f)
        result = {**DEFAULT_MEMORY, **data}
    except FileNotFoundError:
        return dict(DEFAULT_MEMORY)
    except Exception as e:  # noqa: BLE001
        log_error("[memory] Load failed:", e)
        return dict(DEFAULT_MEMORY)
    _memory_cache[user_id] = (result, time.time() * 1000)
    return result


async def save_memory(user_id: str, memory: dict[str, Any]) -> dict[str, Any]:
    _memory_dir().mkdir(parents=True, exist_ok=True)
    nxt = {**memory, "updatedAt": int(time.time() * 1000)}
    try:
        with open(_memory_file_path(user_id), "w", encoding="utf-8") as f:
            json.dump(nxt, f, indent=2)
    except Exception as e:  # noqa: BLE001
        log_error("[memory] Save failed:", e)
        raise
    _memory_cache[user_id] = (nxt, time.time() * 1000)
    return nxt


async def update_memory(user_id: str, updates: dict[str, Any]) -> dict[str, Any]:
    async with _lock_for(user_id):
        current = await get_memory(user_id)
        nxt = {**current, **updates}
        nxt["categories"] = updates.get("categories", current.get("categories", {}))
        return await save_memory(user_id, nxt)


async def merge_memory_entries(
    user_id: str, extracted: dict[str, dict[str, str]]
) -> dict[str, Any] | None:
    async with _lock_for(user_id):
        current = await get_memory(user_id)
        if not current.get("enabled"):
            return None

        merged: dict[str, dict[str, str]] = dict(current.get("categories", {}))

        for category, entries in extracted.items():
            if category not in merged:
                non_empty = {k: v for k, v in entries.items() if v != ""}
                if non_empty:
                    merged[category] = non_empty
                continue

            category_entries = dict(merged[category])
            for key, value in entries.items():
                if value == "":
                    category_entries.pop(key, None)
                else:
                    category_entries[key] = value
            if not category_entries:
                del merged[category]
            else:
                merged[category] = category_entries

        nxt = {
            **current,
            "enabled": True if merged else current.get("enabled", False),
            "categories": merged,
            "updatedAt": int(time.time() * 1000),
        }
        return await save_memory(user_id, nxt)
