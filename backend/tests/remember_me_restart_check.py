"""Live verification: Remember me must survive a backend restart.

Reproduces the user's bug: login with rememberMe=true, kill the backend,
start it again, and call /api/auth/me with the same token. Before the fix
(main.py never called start_auth()), the restarted server had zero sessions
and the client was logged out every restart.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error

PORT = "3991"
BASE = f"http://127.0.0.1:{PORT}"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

data_dir = tempfile.mkdtemp(prefix="kasalix_remember_")


def req(method: str, path: str, body: dict | None = None, token: str | None = None) -> tuple[int, dict]:
    url = f"{BASE}{path}"
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}


def start_server() -> subprocess.Popen:
    env = dict(os.environ, DATA_DIR=data_dir, HTTPS="false", PORT=PORT)
    return subprocess.Popen(
        [sys.executable, "-m", "app.main"],
        cwd=ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def wait_up(proc: subprocess.Popen, timeout: float = 30.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            out = proc.stdout.read().decode(errors="replace") if proc.stdout else ""
            print(f"server exited early:\n{out[-2000:]}")
            return False
        try:
            with urllib.request.urlopen(f"{BASE}/api/health", timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.4)
    return False


def main() -> int:
    ok = True
    # ── Boot 1: register + login with rememberMe ──
    p = start_server()
    if not wait_up(p):
        print("FAIL: server did not start")
        return 1
    try:
        s, body = req("POST", "/api/auth/register", {"username": "remuser", "password": "secret123", "rememberMe": True})
        assert s == 201 and body.get("token"), f"register failed: {s} {body}"
        short_s, short = req("POST", "/api/auth/login", {"username": "remuser", "password": "secret123", "rememberMe": False})
        assert short_s == 200 and short.get("token"), f"login failed: {short_s} {short}"
        remember_token = body["token"]
        short_token = short["token"]

        # Give the debounced session persist loop a moment to write sessions.json
        time.sleep(1.0)
        sess_file = os.path.join(data_dir, "sessions.json")
        print(f"sessions.json exists after persist: {os.path.exists(sess_file)}")
        if not os.path.exists(sess_file):
            print("FAIL: sessions.json was never written")
            ok = False
    finally:
        p.terminate()
        try:
            p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            p.kill()

    if not ok:
        return 1

    # ── Boot 2: same DATA_DIR — both tokens must still validate ──
    p = start_server()
    if not wait_up(p):
        print("FAIL: server did not restart")
        return 1
    try:
        s, me = req("GET", "/api/auth/me", token=remember_token)
        remembered = s == 200 and me.get("authenticated") is True
        print(f"remember-me token after restart: authenticated={me.get('authenticated')} (expect True)")
        s2, me2 = req("GET", "/api/auth/me", token=short_token)
        short_lived = s2 == 200 and me2.get("authenticated") is True
        print(f"24h session token after restart: authenticated={me2.get('authenticated')} (expect True)")
        if not remembered or not short_lived:
            ok = False
    finally:
        p.terminate()
        try:
            p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            p.kill()

    print("PASS: Remember me survives backend restart" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
