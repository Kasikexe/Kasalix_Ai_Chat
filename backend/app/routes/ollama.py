"""Ollama process management + routes — mirrors backend/src/routes/ollama.ts."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..config import ollama_base_url
from ..deps import admin_authenticated
from ..logger import info as log_info, warn as log_warn
from ..settings_store import (
    coerce_keep_alive,
    coerce_num_setting,
    load_settings,
)

router = APIRouter()

# ─── Ollama Process State ─────────────────────────────────────
_ollama_process: asyncio.subprocess.Process | None = None
_ollama_pid: int | None = None
_owned_by_us = False
_restarting = False
# Model architectures Ollama reported as incapable of parallel requests
# ("model architecture does not currently support parallel requests").
# Surfaced via /status so the GUI can explain why parallel slots are inert
# for e.g. qwen3.5-family models — upstream limitation, not a settings bug.
_parallel_unsupported_archs: set[str] = set()
# Env the backend itself spawned Ollama with ({} until we own a spawn).
# Exposed via /status so the GUI can show which tuning is ACTUALLY active —
# an externally started Ollama (tray autostart) runs on its own env.
_effective_env: dict[str, str] = {}

OWNERSHIP_FLAG = os.path.join(tempfile.gettempdir(), "kasalix-ollama-owned")

# Seconds to wait for a possibly-still-booting external Ollama before the
# startup hook concludes it is dead and spawns its own. Tests patch to 0.
_STARTUP_GRACE_S = 6.0
# A respawn that fails once used to leave the app with NO model backend at all:
# /api/health kept answering while every chat failed with "All connection
# attempts failed" — clients showed "server reachable" and could not send. The
# usual cause is the previous instance still releasing port 11434, so the
# startup spawn gets a few bounded chances before giving up.
_STARTUP_SPAWN_ATTEMPTS = 3
_STARTUP_SPAWN_RETRY_S = 5.0


def _note_parallel_unsupported(line: str) -> None:
    """Detect Ollama's per-architecture parallel limitation from stderr."""
    marker = "does not currently support parallel requests"
    if marker in line and "architecture=" in line:
        arch = line.split("architecture=", 1)[1].strip().split()[0].strip('"')
        if arch and arch not in _parallel_unsupported_archs:
            _parallel_unsupported_archs.add(arch)
            log_warn(
                f"[ollama] Model architecture '{arch}' does not support parallel "
                "requests — OLLAMA_NUM_PARALLEL has no effect for these models "
                "(upstream limitation)"
            )


async def is_ollama_running() -> bool:
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            res = await client.get(f"{ollama_base_url()}/api/tags")
        return res.status_code < 400
    except Exception:  # noqa: BLE001
        return False


async def get_loaded_models() -> list[dict[str, Any]]:
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            res = await client.get(f"{ollama_base_url()}/api/ps")
        if res.status_code >= 400:
            return []
        return res.json().get("models") or []
    except Exception:  # noqa: BLE001
        return []


async def _wait_for_port_free(max_ms: int = 10_000) -> None:
    import time

    start = time.time() * 1000
    failed_once = False
    while time.time() * 1000 - start < max_ms:
        running = await is_ollama_running()
        if not running:
            failed_once = True
            await asyncio.sleep(0.5)
            if not (await is_ollama_running()):
                return
        await asyncio.sleep(0.3)
    if not failed_once:
        log_warn("[ollama] Port did not free within timeout — proceeding anyway")


async def _wait_for_ollama_up(max_ms: int = 30_000) -> bool:
    import time

    start = time.time() * 1000
    while time.time() * 1000 - start < max_ms:
        if await is_ollama_running():
            return True
        await asyncio.sleep(0.5)
    return False


def _kill_ollama_sync() -> None:
    """Kill all Ollama processes (cross-platform)."""
    global _ollama_pid, _ollama_process, _owned_by_us
    if _ollama_pid:
        try:
            if sys.platform == "win32":
                subprocess.run(
                    ["taskkill", "/PID", str(_ollama_pid), "/F", "/T"],
                    capture_output=True,
                    shell=True,
                )
            else:
                os.kill(_ollama_pid, 15)  # SIGTERM
            log_info(f"[ollama] Killed tracked process PID {_ollama_pid}")
        except Exception as e:  # noqa: BLE001
            log_warn(f"[ollama] PID kill failed (may already be dead): {e}")
        _ollama_pid = None
        _ollama_process = None

    try:
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/IM", "ollama.exe", "/F"], capture_output=True, shell=True)
            subprocess.run(["taskkill", "/IM", "Ollama App.exe", "/F"], capture_output=True, shell=True)
            subprocess.run(
                ['wmic process where "name like \\"%ollama%\\"" call terminate'],
                capture_output=True,
                shell=True,
            )
        else:
            subprocess.run(["pkill", "-9", "-f", "ollama"], capture_output=True)
        log_info("[ollama] Killed all Ollama processes by name")
    except Exception as e:  # noqa: BLE001
        log_warn(f"[ollama] Name-based kill completed: {e}")
    try:
        if os.path.exists(OWNERSHIP_FLAG):
            os.remove(OWNERSHIP_FLAG)
    except OSError:  # noqa: S110
        pass
    _owned_by_us = False


async def _spawn_ollama(env_overrides: dict[str, str] | None = None) -> None:
    global _ollama_process, _ollama_pid, _owned_by_us, _effective_env
    env = {**os.environ, **(env_overrides or {})}
    _effective_env = dict(env_overrides or {})
    ollama_exe = await _find_ollama_exe()
    if not ollama_exe:
        log_warn("[ollama] Could not find 'ollama' executable on PATH or default install dirs")
        _ollama_process = None
        _ollama_pid = None
        _owned_by_us = False
        return
    try:
        proc = await asyncio.create_subprocess_exec(
            ollama_exe, "serve",
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        log_warn("[ollama] Could not find 'ollama' executable on PATH")
        _ollama_process = None
        _ollama_pid = None
        _owned_by_us = False
        return

    _ollama_process = proc
    _ollama_pid = proc.pid
    _owned_by_us = True
    # Persist ownership across backend restarts: the flag is how a fresh
    # backend process recognizes an Ollama that THIS app spawned earlier
    # (still running with the settings this app applied). The env rides
    # along so /status can report the ACTIVE tuning after any restart —
    # without it the GUI showed "auto · auto · auto(5m) · f16" defaults
    # for an Ollama that was actually running with the saved tuning.
    _write_ownership_flag(proc.pid, _effective_env)

    async def _pump(stream: Any, prefix: str) -> None:
        while True:
            line = await stream.readline()
            if not line:
                break
            text = line.decode("utf-8", "replace").rstrip()
            if text:
                log_info(f"[ollama:{prefix}] {text}")
                _note_parallel_unsupported(text)

    if proc.stdout:
        asyncio.create_task(_pump(proc.stdout, "stdout"))
    if proc.stderr:
        asyncio.create_task(_pump(proc.stderr, "stderr"))

    async def _on_exit() -> None:
        nonlocal proc
        global _ollama_process, _ollama_pid, _owned_by_us, _effective_env
        code = await proc.wait()
        log_info(f"[ollama] Process exited with code {code}")
        if _ollama_process is proc:
            _ollama_process = None
            _ollama_pid = None
            _owned_by_us = False
            _effective_env = {}

    asyncio.create_task(_on_exit())


def _build_ollama_env(
    kv_cache_offload: bool,
    kv_cache_type: str = "f16",
    num_parallel: int = 0,
    max_loaded_models: int = 0,
    keep_alive: str = "",
) -> dict[str, str]:
    env: dict[str, str] = {}
    if not kv_cache_offload:
        env["LLAMA_ARG_KV_OFFLOAD"] = "0"
    if kv_cache_type and kv_cache_type != "f32":
        env["LLAMA_ARG_CACHE_TYPE_K"] = kv_cache_type
        env["LLAMA_ARG_CACHE_TYPE_V"] = kv_cache_type
        # KV-cache quantization is only applied by llama.cpp when flash
        # attention is enabled — without this the q8_0/q4_0 choice is
        # silently ignored and the cache stays f16.
        if kv_cache_type != "f16":
            env["OLLAMA_FLASH_ATTENTION"] = "1"
    # Concurrency tuning — only set what the host configured (0 / "" = Auto).
    # More parallel slots serve more users at once but each pays VRAM for the
    # larger KV cache; see Ollama's FAQ for the exact numbers.
    np = coerce_num_setting(num_parallel)
    if np:
        env["OLLAMA_NUM_PARALLEL"] = str(np)
    mlm = coerce_num_setting(max_loaded_models)
    if mlm:
        env["OLLAMA_MAX_LOADED_MODELS"] = str(mlm)
    ka = coerce_keep_alive(keep_alive)
    if ka:
        env["OLLAMA_KEEP_ALIVE"] = ka
    return env


def _read_ownership_flag() -> dict[str, Any] | None:
    """Parse the ownership flag: {"pid": <int>, "env": {<overrides>}}.
    Plain-integer files are the legacy format (pid only — env unknown)."""
    try:
        with open(OWNERSHIP_FLAG, encoding="utf-8") as f:
            raw = f.read().strip()
    except OSError:
        return None
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        data = None
    if isinstance(data, dict) and isinstance(data.get("pid"), int):
        env = data.get("env")
        return {"pid": data["pid"], "env": dict(env) if isinstance(env, dict) else None}
    try:
        return {"pid": int(raw), "env": None}
    except ValueError:
        return None


def _write_ownership_flag(pid: int, env: dict[str, str] | None = None) -> None:
    try:
        with open(OWNERSHIP_FLAG, "w", encoding="utf-8") as f:
            json.dump({"pid": pid, "env": dict(env or {})}, f)
    except OSError:
        pass


def _ownership_pid_alive() -> bool:
    """True when the PID recorded in the ownership flag is still a live
    process. A stale flag (dead PID — e.g. left by yesterday's backend)
    must NOT count as ownership: it would suppress the startup hooks and
    leave an externally-started Ollama running on its old env forever."""
    data = _read_ownership_flag()
    if not data or data["pid"] <= 0:
        return False
    pid = data["pid"]
    if sys.platform == "win32":
        out = subprocess.run(
            ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
            capture_output=True,
            text=True,
            shell=True,
        )
        return str(pid) in (out.stdout or "")
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


async def detect_ollama_ownership() -> None:
    global _owned_by_us, _effective_env
    running = await is_ollama_running()
    if running:
        if os.path.exists(OWNERSHIP_FLAG):
            if _ownership_pid_alive():
                flag = _read_ownership_flag() or {}
                if flag.get("env") is not None:
                    _owned_by_us = True
                    # Restore the env the app originally spawned Ollama
                    # with. Without this a fresh backend reported
                    # ownedByUs with an empty effectiveEnv and the GUI
                    # displayed Auto defaults for tuning that WAS active.
                    _effective_env = dict(flag["env"])
                    log_info("[ollama] Detected running Ollama instance (owned by app — env restored)")
                else:
                    # Legacy plain-pid flag: the spawning process predates
                    # env persistence, so whether the saved tuning is
                    # active is UNKNOWN. Treat as external — auto-apply
                    # then restarts with saved tuning once and writes an
                    # upgraded (JSON) flag.
                    _owned_by_us = False
                    log_info("[ollama] Legacy ownership flag (no env recorded) — treating running Ollama as external")
            else:
                _owned_by_us = False
                try:
                    os.remove(OWNERSHIP_FLAG)
                except OSError:  # noqa: S110
                    pass
                log_info(
                    "[ollama] Stale ownership flag (recorded PID is dead) — "
                    "treating running Ollama as external"
                )
        else:
            _owned_by_us = False
            log_info("[ollama] Detected running Ollama instance (not owned by us)")
    else:
        # No Ollama running: a stale flag would also block the startup
        # spawn hook from firing — clear it so ensure_ollama can act.
        if os.path.exists(OWNERSHIP_FLAG) and not _ownership_pid_alive():
            try:
                os.remove(OWNERSHIP_FLAG)
            except OSError:  # noqa: S110
                pass
        log_info("[ollama] No running Ollama instance detected")


async def auto_apply_settings_if_external() -> None:
    """Startup hook: if Ollama is running but was started OUTSIDE the app
    (e.g. its own tray autostart at PC boot), it is serving on whatever env
    the tray gave it — the host's saved tuning (parallel slots, keep-alive,
    KV cache type…) is NOT active. Restart it with the saved settings.

    Guards:
    - skipped when Ollama isn't running (the app's start-ollama flow applies
      settings when it spawns Ollama itself)
    - skipped when the ownership flag exists (the app spawned it — env is
      already correct)
    - skipped when all settings are Auto (nothing to apply)
    - skipped when models are loaded in the external instance (something is
      actively using it — the GUI banner tells the host to apply manually)
    """
    try:
        if not await is_ollama_running():
            return
        flag = _read_ownership_flag() if os.path.exists(OWNERSHIP_FLAG) else None
        # Only a flag WITH env proves the app spawned Ollama with its saved
        # tuning. A legacy env-less flag proves nothing — let auto-apply run
        # (its models-loaded guard protects anything actively generating).
        flag_owned = bool(flag and flag.get("env") is not None and _ownership_pid_alive())
        if _owned_by_us or flag_owned:
            return  # app-spawned — env already matches the saved settings
        settings = await load_settings()
        np = coerce_num_setting(settings.get("ollamaNumParallel") or 0)
        mlm = coerce_num_setting(settings.get("ollamaMaxLoadedModels") or 0)
        ka = coerce_keep_alive(settings.get("ollamaKeepAlive") or "")
        kv_type = settings.get("kvCacheType") or "f16"
        kv_offload = settings.get("kvCacheOffload") is not False
        has_intent = bool(np or mlm or ka) or kv_type not in ("f16", "", None) or not kv_offload
        if not has_intent:
            log_info("[ollama] External Ollama running; saved settings are all Auto — nothing to apply")
            return
        loaded = await get_loaded_models()
        if loaded:
            names = ", ".join(m.get("name") or m.get("model") or "?" for m in loaded)
            log_info(f"[ollama] External Ollama has models loaded ({names}) — skipping auto-apply; host can use Save & Restart")
            return
        log_info(
            f"[ollama] External Ollama detected — auto-applying saved tuning "
            f"(parallel={np or 'auto'}, maxLoaded={mlm or 'auto'}, keepAlive={ka or 'auto'}, kv={kv_type})"
        )
        result = await restart_ollama(
            kv_offload,
            kv_type,
            confirm=True,
            num_parallel=np,
            max_loaded_models=mlm,
            keep_alive=ka,
        )
        if result.get("success"):
            log_info("[ollama] Auto-apply successful — Ollama restarted with saved tuning")
        else:
            log_warn(f"[ollama] Auto-apply restart failed: {result.get('error')}")
    except Exception as e:  # noqa: BLE001
        log_warn(f"[ollama] Auto-apply failed: {e}")


async def _find_ollama_exe() -> str | None:
    """Locate the Ollama executable without relying on the inherited PATH.

    When the backend runs as a child of the Server GUI it usually has a sane
    PATH, but the bare backend.exe may not — and after a server restart
    Ollama is dead, so spawning it back up is exactly when this matters.
    Order: PATH → Windows install dirs → Linux/macOS defaults.
    """
    exe = "ollama.exe" if sys.platform == "win32" else "ollama"
    found = shutil.which("ollama")
    if found:
        return found
    candidates: list[str] = []
    local_appdata = os.environ.get("LOCALAPPDATA")
    if sys.platform == "win32":
        if local_appdata:
            candidates += [
                os.path.join(local_appdata, "Programs", "Ollama", exe),
                os.path.join(local_appdata, "Ollama", exe),
            ]
        program_files = os.environ.get("ProgramFiles")
        if program_files:
            candidates.append(os.path.join(program_files, "Ollama", exe))
    else:
        candidates += ["/usr/local/bin/ollama", "/usr/bin/ollama", "/opt/homebrew/bin/ollama"]
    for cand in candidates:
        if os.path.isfile(cand):
            return cand
    return None


async def ensure_ollama_running_at_startup() -> None:
    """Startup hook: if Ollama is NOT running, spawn it with the saved tuning.

    Complements auto_apply_settings_if_external (which fixes an external
    Ollama that IS running). Without this, a Server-app restart leaves every
    client with 502s on /api/models and "All connection attempts failed" on
    chat — the GUI's tree-kill of the backend takes its child Ollama down,
    and the fresh backend never respawned it.

    Guards:
    - skipped when Ollama is already running (any owner)
    - skipped when no Ollama executable can be found
    - failures are logged, never raised — startup must not crash over this
    """
    try:
        if await is_ollama_running():
            return  # someone (tray, GUI, previous backend) already has it up
        # Grace window: a tray-autostarted Ollama may still be booting when
        # we get here — spawning a second instance now would just fight it
        # for the port. Give a slow starter a few seconds before concluding
        # it is really dead.
        deadline = time.time() + _STARTUP_GRACE_S
        while time.time() < deadline:
            await asyncio.sleep(min(1.5, max(0.05, _STARTUP_GRACE_S)))
            if await is_ollama_running():
                log_info("[ollama] Startup spawn skipped — Ollama came up on its own (slow starter)")
                return
        settings = await load_settings()
        np = coerce_num_setting(settings.get("ollamaNumParallel") or 0)
        mlm = coerce_num_setting(settings.get("ollamaMaxLoadedModels") or 0)
        ka = coerce_keep_alive(settings.get("ollamaKeepAlive") or "")
        kv_type = settings.get("kvCacheType") or "f16"
        kv_offload = settings.get("kvCacheOffload") is not False
        log_info(
            f"[ollama] Not running at startup — spawning with saved tuning "
            f"(parallel={np or 'auto'}, maxLoaded={mlm or 'auto'}, keepAlive={ka or 'auto'}, kv={kv_type})"
        )
        last_error: Any = None
        for attempt in range(1, _STARTUP_SPAWN_ATTEMPTS + 1):
            result = await restart_ollama(
                kv_offload,
                kv_type,
                confirm=True,
                num_parallel=np,
                max_loaded_models=mlm,
                keep_alive=ka,
            )
            if result.get("success"):
                log_info(
                    "[ollama] Startup spawn successful — Ollama is up with saved tuning"
                    + (f" (attempt {attempt})" if attempt > 1 else "")
                )
                return
            last_error = result.get("error")
            if attempt < _STARTUP_SPAWN_ATTEMPTS:
                delay = _STARTUP_SPAWN_RETRY_S * attempt
                log_warn(
                    f"[ollama] Startup spawn attempt {attempt}/{_STARTUP_SPAWN_ATTEMPTS} "
                    f"failed ({last_error}) — retrying in {delay:.0f}s"
                )
                await asyncio.sleep(delay)
                if await is_ollama_running():
                    log_info("[ollama] Ollama came up on its own — no further spawn attempts")
                    return
        log_warn(
            f"[ollama] Startup spawn failed after {_STARTUP_SPAWN_ATTEMPTS} attempts: {last_error}"
        )
    except FileNotFoundError:
        log_warn("[ollama] Startup spawn skipped — 'ollama' executable not found on this machine")
    except Exception as e:  # noqa: BLE001
        log_warn(f"[ollama] Startup spawn failed: {e}")


async def restart_ollama(
    kv_cache_offload: bool,
    kv_cache_type: str = "f16",
    confirm: bool = False,
    num_parallel: int = 0,
    max_loaded_models: int = 0,
    keep_alive: str = "",
) -> dict[str, Any]:
    global _restarting, _owned_by_us
    if _restarting:
        return {
            "success": False,
            "wasRunning": False,
            "modelsInterrupted": False,
            "ownedByUs": _owned_by_us,
            "error": "Restart already in progress",
        }
    _restarting = True
    try:
        was_running = await is_ollama_running()
        loaded_models = await get_loaded_models() if was_running else []
        models_interrupted = len(loaded_models) > 0

        if models_interrupted and not confirm:
            names = ", ".join(m.get("name") or m.get("model") for m in loaded_models)
            return {
                "success": False,
                "wasRunning": was_running,
                "modelsInterrupted": True,
                "ownedByUs": _owned_by_us,
                "error": f"Model(s) currently loaded: {names}. Pass confirm=true to force restart.",
            }

        if was_running:
            _kill_ollama_sync()
            await _wait_for_port_free()

        env_overrides = _build_ollama_env(
            kv_cache_offload,
            kv_cache_type,
            num_parallel=num_parallel,
            max_loaded_models=max_loaded_models,
            keep_alive=keep_alive,
        )
        log_info(f"[ollama] Restarting with env: {env_overrides}")
        await _spawn_ollama(env_overrides)

        up = await _wait_for_ollama_up()
        if not up:
            # `ollama serve` exits immediately when the previous instance is
            # still releasing port 11434 — the most common restart failure.
            # Clear whatever is left and try once more before declaring the
            # model backend dead.
            log_warn("[ollama] Did not answer within 30s — clearing leftovers and retrying once")
            _kill_ollama_sync()
            await _wait_for_port_free()
            await _spawn_ollama(env_overrides)
            up = await _wait_for_ollama_up()
        if not up:
            return {
                "success": False,
                "wasRunning": was_running,
                "modelsInterrupted": models_interrupted,
                "ownedByUs": True,
                "error": "Ollama did not come back up within 30 seconds (two spawn attempts)",
            }
        log_info("[ollama] Restart successful — Ollama is back up")
        return {"success": True, "wasRunning": was_running, "modelsInterrupted": models_interrupted, "ownedByUs": True}
    except Exception as e:  # noqa: BLE001
        return {"success": False, "wasRunning": False, "modelsInterrupted": False, "ownedByUs": _owned_by_us, "error": str(e)}
    finally:
        _restarting = False


def get_ollama_status() -> dict[str, Any]:
    running = _ollama_process is not None and _ollama_process.returncode is None
    return {
        "running": running,
        "ownedByUs": _owned_by_us,
        "pid": _ollama_pid,
        "restarting": _restarting,
        # Only meaningful when ownedByUs — an external Ollama's env is unknown.
        "effectiveEnv": dict(_effective_env) if _owned_by_us else None,
        # Architectures Ollama itself flagged as parallel-incapable (e.g.
        # qwen3.5) — lets the GUI explain inert parallel slots honestly.
        "parallelUnsupportedArchs": sorted(_parallel_unsupported_archs),
    }


@router.get("/status")
async def status() -> dict:
    status_info = get_ollama_status()
    running = await is_ollama_running()
    loaded_models = await get_loaded_models() if running else []
    return {**status_info, "running": running, "loadedModels": loaded_models}


@router.post("/restart")
async def restart(request: Request) -> dict:
    if not admin_authenticated(request):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    try:
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            body = {}
        confirm = body.get("confirm") is True
        settings = await load_settings()
        kv_cache_offload = settings.get("kvCacheOffload") is not False
        kv_cache_type = settings.get("kvCacheType") or "f16"
        return await restart_ollama(
            kv_cache_offload,
            kv_cache_type,
            confirm,
            num_parallel=settings.get("ollamaNumParallel") or 0,
            max_loaded_models=settings.get("ollamaMaxLoadedModels") or 0,
            keep_alive=settings.get("ollamaKeepAlive") or "",
        )
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e)}, status_code=500)


@router.post("/apply")
async def apply(request: Request) -> dict:
    if not admin_authenticated(request):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    try:
        body = await request.json()
        confirm = body.get("confirm") is True
        kv_cache_offload = body.get("kvCacheOffload") is not False
        kv_cache_type = body.get("kvCacheType") or "f16"
        return await restart_ollama(
            kv_cache_offload,
            kv_cache_type,
            confirm,
            num_parallel=coerce_num_setting(body.get("ollamaNumParallel")),
            max_loaded_models=coerce_num_setting(body.get("ollamaMaxLoadedModels")),
            keep_alive=coerce_keep_alive(body.get("ollamaKeepAlive")),
        )
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e)}, status_code=500)