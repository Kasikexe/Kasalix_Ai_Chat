"""Conversations storage — mirrors backend/src/services/storage.ts.

Same JSON file (data/conversations.json), same shapes, debounced writes so
rapid messages trigger a single disk write.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from .config import get_data_dir, generate_id, truncate
from .logger import error as log_error
from .models import Conversation, Message

DEBOUNCE_MS = 500

_conversations: dict[str, Conversation] = {}
_initialized = False
_lock = asyncio.Lock()
_save_handle: asyncio.TimerHandle | None = None
_loop: asyncio.AbstractEventLoop | None = None


def _storage_file() -> str:
    return str(get_data_dir() / "conversations.json")


def _migrate(conv: dict[str, Any]) -> Conversation | None:
    # The video editor mode was removed — drop any leftover editor conversations
    mode = conv.get("mode")
    if mode and mode not in ("chat", "agent"):
        return None
    conv.setdefault("mode", "chat")
    conv.setdefault("workspacePath", None)
    return conv  # type: ignore[return-value]


def _do_save() -> None:
    try:
        import os

        path = _storage_file()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(_conversations, f, indent=2)
    except Exception as e:  # noqa: BLE001
        log_error("Failed to flush conversations:", e)


def _debounced_save() -> None:
    """Schedule a save on the running loop; last call wins."""
    global _save_handle, _loop
    import asyncio

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        _do_save()  # no loop (startup/shutdown) — save synchronously
        return
    _loop = loop
    if _save_handle is not None:
        _save_handle.cancel()
    _save_handle = loop.call_later(DEBOUNCE_MS / 1000.0, _do_save)


def flush_save() -> None:
    """Force an immediate save (used before shutdown or critical operations)."""
    global _save_handle
    if _save_handle is not None:
        _save_handle.cancel()
        _save_handle = None
    _do_save()


async def _load() -> None:
    global _initialized
    if _initialized:
        return
    async with _lock:
        if _initialized:
            return
        try:
            import os

            path = _storage_file()
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, encoding="utf-8") as f:
                parsed = json.load(f)
            cleaned: dict[str, Conversation] = {}
            for k, v in parsed.items():
                conv = _migrate(v)
                if conv is not None:
                    cleaned[k] = conv
            _conversations.clear()
            _conversations.update(cleaned)
        except FileNotFoundError:
            pass
        except Exception as e:  # noqa: BLE001
            log_error("Failed to load conversations:", e)
        _initialized = True


async def get_all_conversations(owner_id: str | None = None) -> list[Conversation]:
    await _load()
    all_convs = list(_conversations.values())
    if owner_id:
        all_convs = [c for c in all_convs if c.get("ownerId") == owner_id]
    return sorted(all_convs, key=lambda c: c.get("updatedAt", 0), reverse=True)


async def get_conversation(id: str, owner_id: str | None = None) -> Conversation | None:
    await _load()
    conv = _conversations.get(id)
    if conv is None:
        return None
    if owner_id and conv.get("ownerId") != owner_id:
        return None
    return conv


async def create_conversation(
    model: str,
    owner_id: str,
    title: str | None = None,
    mode: str | None = None,
    workspace_path: str | None = None,
) -> Conversation:
    # TS parity: the route passes body.get("mode") which is None when absent.
    # In JS an explicit `undefined` argument triggers the `= 'chat'` default;
    # Python's None would override it, so normalize here.
    mode = mode or "chat"
    await _load()
    now = time.time() * 1000
    conv: Conversation = {
        "id": generate_id(),
        "title": title or ("New Agent Session" if mode == "agent" else "New Chat"),
        "messages": [],
        "model": model,
        "ownerId": owner_id,
        "mode": mode,  # type: ignore[typeddict-unknown-key]
        "workspacePath": workspace_path,
        "agentState": None,
        "createdAt": now,
        "updatedAt": now,
    }
    _conversations[conv["id"]] = conv
    _debounced_save()
    return conv


async def update_conversation(
    id: str,
    owner_id: str,
    updates: dict[str, Any],
) -> Conversation | None:
    await _load()
    conv = _conversations.get(id)
    if conv is None or conv.get("ownerId") != owner_id:
        return None
    conv.update(updates)
    conv["updatedAt"] = time.time() * 1000
    _debounced_save()
    return conv


async def delete_conversation(id: str, owner_id: str) -> bool:
    await _load()
    conv = _conversations.get(id)
    if conv is None or conv.get("ownerId") != owner_id:
        return False
    del _conversations[id]
    flush_save()  # Flush immediately on delete — data safety
    return True


async def add_message(conversation_id: str, owner_id: str, message: Message) -> Conversation | None:
    await _load()
    conv = _conversations.get(conversation_id)
    if conv is None or conv.get("ownerId") != owner_id:
        return None

    message = {**message, "timestamp": time.time() * 1000}
    conv["messages"].append(message)
    conv["updatedAt"] = time.time() * 1000

    if (
        conv.get("title") in ("New Chat", "New Agent Session")
        and message.get("role") == "user"
        and len(conv["messages"]) == 1
    ):
        conv["title"] = truncate(message.get("content", ""), 50)

    _debounced_save()
    return conv


async def delete_message(conversation_id: str, owner_id: str, message_index: int) -> Conversation | None:
    await _load()
    conv = _conversations.get(conversation_id)
    if conv is None or conv.get("ownerId") != owner_id:
        return None
    messages = conv["messages"]
    if message_index < 0 or message_index >= len(messages):
        return None
    messages.pop(message_index)
    conv["updatedAt"] = time.time() * 1000
    _debounced_save()
    return conv
