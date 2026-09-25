#!/usr/bin/env python3
"""Parity harness — diffs the TypeScript backend against the Python port.

Starts both backends on separate ports against separate scratch DATA_DIRs,
then issues the same requests to both and reports differences. The TS backend
is the reference; the Python backend must match it field-for-field.

Usage (from backend/):
    uv run python tests/parity/parity_check.py

Requirements:
    - bun available on PATH (for the TS backend)
    - the TS backend can start with `PORT=3102 DATA_DIR=... bun run src/index.ts`
    - a running Ollama is optional — endpoints that need it will 503 on both
      sides and that is reported as a match.
"""

from __future__ import annotations

import json
import os
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]          # repo root
TS_DIR = ROOT / "backend-legacy"
PY_DIR = ROOT / "backend"

TS_PORT = 3102
PY_PORT = 3103
# The TS backend serves HTTPS with a self-signed cert by default; the Python
# port does too. Use an unverified SSL context so the harness can talk to both.
_SSL = ssl.create_default_context()
_SSL.check_hostname = False
_SSL.verify_mode = ssl.CERT_NONE
TS_URL = f"https://127.0.0.1:{TS_PORT}"
PY_URL = f"https://127.0.0.1:{PY_PORT}"

# (method, path, body_or_None, label, needs_admin, needs_session)
# Paths mirror what the frontend actually calls (no trailing slash).
CASES: list[tuple[str, str, dict | None, str, bool, bool]] = [
    ("GET", "/api/health", None, "health", False, False),
    ("GET", "/api/models", None, "models", False, False),
    ("GET", "/api/settings", None, "settings", False, False),
    ("GET", "/api/settings/cloud-models", None, "settings-cloud-models", False, False),
    ("GET", "/api/planned", None, "planned", True, False),
    ("GET", "/api/changelog", None, "changelog", True, False),
    ("GET", "/api/cloud-usage", None, "cloud-usage", True, False),
    ("GET", "/api/session-logs", None, "session-logs", True, False),
    ("GET", "/api/speedtest/results", None, "speedtest-results", True, False),
    ("GET", "/api/plugins", None, "plugins", True, False),
    ("GET", "/api/conversations", None, "conversations", False, True),
    ("GET", "/api/memory", None, "memory", False, True),
]


def wait_for(url: str, timeout: float = 30.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url + "/api/health", timeout=2, context=_SSL) as r:
                if r.status == 200:
                    return True
        except Exception:  # noqa: BLE001
            time.sleep(0.4)
    return False


def request(base: str, method: str, path: str, body: dict | None, headers: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        base + path, data=data, method=method,
        headers={**({"Content-Type": "application/json"} if data else {}), **(headers or {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=15, context=_SSL) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return -1, str(e)


def setup_auth(base: str) -> tuple[dict, dict]:
    """Register a user + log into settings on one backend.

    Returns (bearer_headers, cookie_headers).
    """
    status, body = request(base, "POST", "/api/auth/register", {"username": "parity", "password": "parity-pass"})
    if status not in (200, 201):
        status, body = request(base, "POST", "/api/auth/login", {"username": "parity", "password": "parity-pass"})
    try:
        token = json.loads(body)["token"]
    except Exception:  # noqa: BLE001
        token = ""
    bearer = {"Authorization": f"Bearer {token}"} if token else {}
    # Admin: POST /api/settings/auth with the default password sets the cookie.
    status, _ = request(base, "POST", "/api/settings/auth", {"password": "letmein"})
    cookie = {"Cookie": "settings_auth=1"} if status in (200, 201) else {}
    return bearer, cookie


def normalize(body: str) -> str:
    """Drop volatile fields (timestamps, ids, digests) before diffing."""
    try:
        obj = json.loads(body)
    except Exception:  # noqa: BLE001
        return body

    def scrub(o):
        if isinstance(o, dict):
            return {
                k: ("<volatile>" if k in ("updatedAt", "createdAt", "timestamp", "id", "digest", "modified_at", "sessionLogId", "color", "lastReset") else scrub(v))
                for k, v in o.items()
            }
        if isinstance(o, list):
            return [scrub(i) for i in o]
        return o

    return json.dumps(scrub(obj), indent=1, sort_keys=True)


def main() -> int:
    ts_proc = py_proc = None
    ts_dir = tempfile.mkdtemp(prefix="kasalix-parity-ts-")
    py_dir = tempfile.mkdtemp(prefix="kasalix-parity-py-")

    try:
        print("Starting TypeScript backend...")
        ts_env = {
            **os.environ,
            "PORT": str(TS_PORT),
            "DATA_DIR": ts_dir,
            "SSL_CERT": str(ROOT / "certs" / "localhost.crt"),
            "SSL_KEY": str(ROOT / "certs" / "localhost.key"),
        }
        ts_proc = subprocess.Popen(
            ["bun", "run", "src/index.ts"], cwd=str(TS_DIR), env=ts_env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        print("Starting Python backend...")
        py_env = {
            **os.environ,
            "PORT": str(PY_PORT),
            "DATA_DIR": py_dir,
            "SSL_CERT": str(ROOT / "certs" / "localhost.crt"),
            "SSL_KEY": str(ROOT / "certs" / "localhost.key"),
        }
        py_proc = subprocess.Popen(
            [
                sys.executable, "-m", "uvicorn", "app.main:app",
                "--host", "127.0.0.1", "--port", str(PY_PORT),
                "--ssl-keyfile", str(ROOT / "certs" / "localhost.key"),
                "--ssl-certfile", str(ROOT / "certs" / "localhost.crt"),
            ],
            cwd=str(PY_DIR), env=py_env,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )

        if not wait_for(TS_URL):
            print("FAIL: TypeScript backend never became healthy")
            return 1
        if not wait_for(PY_URL):
            print("FAIL: Python backend never became healthy")
            return 1
        print("Both backends healthy.\n")

        ts_bearer, ts_cookie = setup_auth(TS_URL)
        py_bearer, py_cookie = setup_auth(PY_URL)

        failures = 0
        for method, path, body, label, needs_admin, needs_session in CASES:
            ts_headers = {**ts_cookie, **ts_bearer}
            py_headers = {**py_cookie, **py_bearer}
            ts_status, ts_body = request(TS_URL, method, path, body, ts_headers)
            py_status, py_body = request(PY_URL, method, path, body, py_headers)
            status_ok = ts_status == py_status
            body_ok = normalize(ts_body) == normalize(py_body)
            if status_ok and body_ok:
                print(f"  PASS  {label}  ({ts_status})")
            else:
                failures += 1
                print(f"  FAIL  {label}  TS={ts_status} PY={py_status}")
                if not status_ok:
                    print(f"        TS body: {ts_body[:200]}")
                    print(f"        PY body: {py_body[:200]}")
                elif not body_ok:
                    print(f"        TS: {normalize(ts_body)[:300]}")
                    print(f"        PY: {normalize(py_body)[:300]}")

        print(f"\n{len(CASES) - failures}/{len(CASES)} endpoints in parity.")
        return 1 if failures else 0
    finally:
        for proc in (ts_proc, py_proc):
            if proc:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()


if __name__ == "__main__":
    sys.exit(main())