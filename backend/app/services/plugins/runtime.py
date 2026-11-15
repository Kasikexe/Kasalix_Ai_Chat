"""Host-mediated plugin actions and per-user plugin storage."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from ...config import get_data_dir
from . import manager, sandbox

MAX_STORAGE = 64_000
MAX_PAYLOAD = 32_000
_locks: dict[str, asyncio.Lock] = {}


def _scope(plugin_id: str, owner_id: str) -> str:
    return hashlib.sha256(json.dumps([plugin_id, owner_id], separators=(",", ":")).encode()).hexdigest()


def _path(scope: str) -> Path:
    return get_data_dir() / "plugin-storage" / (scope + ".json")


def _read_storage(scope: str) -> dict[str, Any]:
    path = _path(scope)
    if not path.exists():
        return {}
    if path.stat().st_size > MAX_STORAGE:
        raise sandbox.SandboxError("Plugin storage exceeds the limit")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, RecursionError) as error:
        raise sandbox.SandboxError("Could not read plugin storage") from error
    if not isinstance(value, dict):
        raise sandbox.SandboxError("Invalid plugin storage")
    return value


def _write_storage(scope: str, data: dict[str, Any]) -> None:
    try:
        raw = json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, RecursionError) as error:
        raise sandbox.SandboxError("Plugin returned invalid storage data") from error
    if len(raw) > MAX_STORAGE:
        raise sandbox.SandboxError("Plugin storage exceeds the limit")
    path = _path(scope)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as file:
            temp = file.name
            file.write(raw)
        os.replace(temp, path)
    finally:
        if temp and os.path.exists(temp):
            os.unlink(temp)


async def invoke(plugin_id: str, action: str, payload: dict[str, Any], owner_id: str) -> Any:
    try:
        if len(json.dumps(payload, allow_nan=False).encode("utf-8")) > MAX_PAYLOAD:
            raise ValueError("Action payload is too large")
    except (TypeError, ValueError, RecursionError) as error:
        raise ValueError("Invalid action payload") from error
    scope = _scope(plugin_id, owner_id)
    async with _locks.setdefault(scope, asyncio.Lock()):
        plugin = next((p for p in await manager.list_plugins() if p.get("id") == plugin_id), None)
        if not plugin or not plugin.get("enabled"):
            raise ValueError("Plugin is unavailable")
        backend = plugin.get("manifest", {}).get("backend")
        if not backend or action not in backend.get("actions", []):
            raise ValueError("Plugin action is unavailable")
        try:
            source = manager.backend_source(plugin.get("localPath") or manager.get_plugin_dir(plugin_id), plugin["manifest"])
        except (OSError, ValueError) as error:
            raise sandbox.SandboxError("Plugin code is unavailable; reload the plugin") from error
        fingerprint = plugin.get("backendFingerprint")
        if not source or not fingerprint or source[1] != fingerprint or plugin.get("approvedFingerprint") != fingerprint:
            raise PermissionError("Plugin code requires review and approval in the Server App")
        grants = plugin.get("grantedPermissions") or []
        declared = backend.get("permissions", [])
        if not isinstance(grants, list) or any(item not in declared for item in grants):
            raise PermissionError("Plugin permissions are invalid")
        if "storage.write" in grants and "storage.read" not in grants:
            raise PermissionError("Plugin permissions are invalid")
        current = _read_storage(scope) if "storage.read" in grants else {}
        result = await sandbox.run_action(source[0], action, payload, grants, current.copy())
        writes, deletes = result.get("writes"), result.get("deletes")
        if not isinstance(writes, dict) or not isinstance(deletes, list) or any(
            not isinstance(key, str) or not key or len(key) > 128 for key in [*writes, *deletes]
        ):
            raise sandbox.SandboxError("Plugin returned invalid storage changes")
        if (writes or deletes) and "storage.write" not in grants:
            raise PermissionError("Plugin was not granted storage.write")
        # Do not return results or commit writes from a run whose permissions,
        # enabled state, or source changed while the container was running.
        async with manager._lock:
            latest = next((p for p in await manager.list_plugins() if p.get("id") == plugin_id), None)
            if (not latest or not latest.get("enabled") or latest.get("approvedFingerprint") != fingerprint
                    or latest.get("backendFingerprint") != fingerprint or (latest.get("grantedPermissions") or []) != grants):
                raise PermissionError("Plugin permissions changed during the action")
            try:
                latest_source = manager.backend_source(latest.get("localPath") or manager.get_plugin_dir(plugin_id), latest["manifest"])
            except (OSError, ValueError) as error:
                raise PermissionError("Plugin code changed during the action") from error
            if not latest_source or latest_source[1] != fingerprint:
                raise PermissionError("Plugin code changed during the action")
            if writes or deletes:
                for key in deletes:
                    current.pop(key, None)
                current.update(writes)
                _write_storage(scope, current)
        return result.get("result")


async def clear_storage(plugin_id: str, owner_id: str) -> None:
    scope = _scope(plugin_id, owner_id)
    async with _locks.setdefault(scope, asyncio.Lock()):
        _path(scope).unlink(missing_ok=True)
