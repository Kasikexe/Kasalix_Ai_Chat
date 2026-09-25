"""Authentication service — mirrors backend/src/services/auth.ts.

Password hashing (argon2id — same PHC format Bun.password produces, so the
existing users.json stays compatible), session tokens, per-IP rate limiting,
file-based storage.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, InvalidHashError

from .config import get_data_dir, generate_id
from .logger import debug as log_debug, info as log_info, warn as log_warn

SESSION_TTL_MS = int(os.environ.get("SESSION_TTL_MS") or 86_400_000)  # 24h
REMEMBER_ME_TTL_MS = int(os.environ.get("REMEMBER_ME_TTL_MS") or 2_592_000_000)  # 30 days
MAX_LOGIN_ATTEMPTS = int(os.environ.get("MAX_LOGIN_ATTEMPTS") or 5)
LOCKOUT_DURATION_MS = int(os.environ.get("LOCKOUT_DURATION_MS") or 900_000)  # 15 min
CLEANUP_INTERVAL_S = 600

_hasher = PasswordHasher()  # argon2id, m=65536 t=2 p=1 defaults in PHC string

_users: dict[str, dict[str, Any]] = {}  # key: username (lowercase)
_user_id_index: dict[str, str] = {}  # userId -> username
_sessions: dict[str, dict[str, Any]] = {}  # token -> session
_rate_limit: dict[str, dict[str, Any]] = {}  # ip -> entry
_initialized = False
_sessions_dirty = asyncio.Event()
_cleanup_task: asyncio.Task | None = None


def _users_file() -> Path:
    return get_data_dir() / "users.json"


def _sessions_file() -> Path:
    return get_data_dir() / "sessions.json"


async def load_users() -> None:
    global _initialized
    if _initialized:
        return
    try:
        with open(_users_file(), encoding="utf-8") as f:
            parsed = json.load(f)
        _users.clear()
        _user_id_index.clear()
        for key, user in parsed.items():
            _users[key] = user
            _user_id_index[user["id"]] = key
        log_info(f"[auth] Loaded {len(_users)} user(s)")
    except FileNotFoundError:
        log_info("[auth] No existing users — starting fresh")
    except Exception as e:  # noqa: BLE001
        log_warn("[auth] Users load failed:", e)
    _initialized = True


def _save_users_sync() -> None:
    _users_file().parent.mkdir(parents=True, exist_ok=True)
    with open(_users_file(), "w", encoding="utf-8") as f:
        json.dump(_users, f, indent=2)


async def load_sessions() -> None:
    try:
        with open(_sessions_file(), encoding="utf-8") as f:
            parsed = json.load(f)
        for s in parsed:
            _sessions[s["token"]] = s
        log_info(f"[auth] Loaded {len(_sessions)} persisted session(s)")
    except FileNotFoundError:
        pass
    except Exception as e:  # noqa: BLE001
        log_warn("[auth] Sessions load failed:", e)


def _save_sessions_sync() -> None:
    try:
        _sessions_file().parent.mkdir(parents=True, exist_ok=True)
        with open(_sessions_file(), "w", encoding="utf-8") as f:
            json.dump(list(_sessions.values()), f, indent=2)
    except Exception as e:  # noqa: BLE001
        log_warn("[auth] Failed to persist sessions:", e)


async def _session_persist_loop() -> None:
    while True:
        await _sessions_dirty.wait()
        _sessions_dirty.clear()
        await asyncio.to_thread(_save_sessions_sync)


def queue_session_save() -> None:
    _sessions_dirty.set()


def shutdown() -> None:
    """Persist any pending session writes before the process exits."""
    try:
        if _sessions_dirty.is_set():
            _save_sessions_sync()
            _sessions_dirty.clear()
    except Exception as e:  # noqa: BLE001
        log_warn("[auth] Shutdown persist failed:", e)


async def start_auth() -> None:
    """Boot-time init: load persisted data and start the cleanup loop."""
    global _cleanup_task
    await load_users()
    await load_sessions()
    if _cleanup_task is None:
        _cleanup_task = asyncio.create_task(_session_persist_loop())
        asyncio.create_task(_periodic_cleanup())


async def _periodic_cleanup() -> None:
    while True:
        await asyncio.sleep(CLEANUP_INTERVAL_S)
        now = time.time() * 1000
        expired = [t for t, s in _sessions.items() if s["expiresAt"] <= now]
        if expired:
            for t in expired:
                del _sessions[t]
            log_debug(f"[auth] Cleaned up {len(expired)} expired session(s)")
            queue_session_save()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, pw_hash: str) -> bool:
    try:
        return _hasher.verify(pw_hash, password)
    except (VerifyMismatchError, InvalidHashError, Exception):  # noqa: BLE001
        return False


async def create_session(user_id: str, remember_me: bool = False) -> str:
    token = str(uuid.uuid4())
    now = time.time() * 1000
    ttl = REMEMBER_ME_TTL_MS if remember_me else SESSION_TTL_MS
    _sessions[token] = {
        "token": token,
        "userId": user_id,
        "createdAt": now,
        "expiresAt": now + ttl,
    }
    queue_session_save()
    log_info(f"[auth] Session created for user {user_id} ({'remember me · 30 days' if remember_me else '24h'})")
    return token


def validate_session(token: str) -> dict[str, Any]:
    session = _sessions.get(token)
    if not session:
        return {"valid": False}
    if session["expiresAt"] <= time.time() * 1000:
        del _sessions[token]
        return {"valid": False}
    return {"valid": True, "userId": session["userId"]}


def destroy_session(token: str) -> None:
    _sessions.pop(token, None)
    queue_session_save()


def destroy_all_user_sessions(user_id: str) -> None:
    for token in [t for t, s in _sessions.items() if s["userId"] == user_id]:
        del _sessions[token]
    queue_session_save()


DEFAULT_COLORS = [
    "#ef4444", "#f97316", "#eab308", "#22c55e",
    "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899",
]


def _pick_color(username: str) -> str:
    h = 0
    for ch in username:
        h = ord(ch) + ((h << 5) - h)
    return DEFAULT_COLORS[abs(h) % len(DEFAULT_COLORS)]


def _hash_name(username: str) -> str:
    h = 0
    for ch in username:
        h = ((h << 5) - h) + ord(ch)
        h &= 0xFFFFFFFF
        if h >= 0x80000000:
            h -= 0x100000000  # int32 overflow like JS |= 0
    b36 = _to_base36(abs(h))
    return "user_" + b36 + "_" + re.sub(r"[^a-z0-9]", "", username.lower())


def _to_base36(n: int) -> str:
    if n == 0:
        return "0"
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = digits[r] + out
    return out


async def register_user(username: str, password: str) -> dict[str, Any]:
    await load_users()
    normalized = username.strip().lower()

    if not normalized or len(normalized) < 2:
        return {"success": False, "error": "Username must be at least 2 characters"}
    if len(normalized) > 24:
        return {"success": False, "error": "Username must be 24 characters or fewer"}
    if len(password) < 6:
        return {"success": False, "error": "Password must be at least 6 characters"}
    if normalized in _users:
        # Don't reveal whether the username exists — generic message
        return {"success": False, "error": "Registration failed"}

    user_id = _hash_name(normalized)
    password_hash = await asyncio.to_thread(hash_password, password)
    now = time.time() * 1000
    _users[normalized] = {
        "id": user_id,
        "username": normalized,
        "passwordHash": password_hash,
        "color": _pick_color(normalized),
        "createdAt": now,
        "updatedAt": now,
    }
    _user_id_index[user_id] = normalized
    await asyncio.to_thread(_save_users_sync)
    log_info(f"[auth] User registered: {normalized}")
    return {"success": True, "userId": user_id}


def _check_rate_limit(ip: str) -> bool:
    entry = _rate_limit.get(ip)
    if not entry:
        return True
    now = time.time() * 1000
    if entry["lockedUntil"] and entry["lockedUntil"] > now:
        return False
    if entry["lockedUntil"] and entry["lockedUntil"] <= now:
        del _rate_limit[ip]
        return True
    return True


def _record_failed_attempt(ip: str) -> None:
    now = time.time() * 1000
    entry = _rate_limit.get(ip)
    if not entry:
        _rate_limit[ip] = {"count": 1, "firstAttempt": now, "lockedUntil": None}
        return
    if now - entry["firstAttempt"] > LOCKOUT_DURATION_MS:
        _rate_limit[ip] = {"count": 1, "firstAttempt": now, "lockedUntil": None}
        return
    entry["count"] += 1
    if entry["count"] >= MAX_LOGIN_ATTEMPTS:
        entry["lockedUntil"] = now + LOCKOUT_DURATION_MS
        log_warn(f"[auth] Rate limit exceeded for IP: {ip} — locked out for {LOCKOUT_DURATION_MS // 60000} min")


async def login_user(username: str, password: str, ip: str, remember_me: bool = False) -> dict[str, Any]:
    await load_users()

    if not _check_rate_limit(ip):
        return {"success": False, "error": "Invalid username or password"}

    normalized = username.strip().lower()
    user = _users.get(normalized)
    if not user:
        _record_failed_attempt(ip)
        return {"success": False, "error": "Invalid username or password"}

    valid = await asyncio.to_thread(verify_password, password, user["passwordHash"])
    if not valid:
        _record_failed_attempt(ip)
        log_warn(f"[auth] Failed login attempt for user: {normalized} (IP: {ip})")
        return {"success": False, "error": "Invalid username or password"}

    _rate_limit.pop(ip, None)
    token = await create_session(user["id"], remember_me)
    log_info(f"[auth] User logged in: {normalized}")
    return {"success": True, "userId": user["id"], "token": token}


async def get_current_user(user_id: str) -> dict[str, Any] | None:
    await load_users()
    key = _user_id_index.get(user_id)
    if not key:
        return None
    user = _users.get(key)
    if not user:
        return None
    return {"id": user["id"], "username": user["username"], "color": user["color"]}


async def get_all_users() -> list[dict[str, Any]]:
    await load_users()
    result = [
        {"id": u["id"], "username": u["username"], "color": u["color"], "createdAt": u["createdAt"]}
        for u in _users.values()
    ]
    result.sort(key=lambda u: u["createdAt"], reverse=True)
    return result
