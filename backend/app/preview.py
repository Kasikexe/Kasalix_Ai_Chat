"""Koding preview — lets the agent SEE its web work.

A tiny static HTTP server serves the workspace (or a subfolder of it) on
localhost. The Electron client opens a real browser window pointed at that
server; the window self-registers with the backend over HTTP (window ID +
callback URL), which lets the agent:

- ``preview_start``  — start serving and tell the client to open the window
- ``preview_stop``   — close the window and stop serving
- ``preview_screenshot`` — capture a PNG of the live page via Electron
  ``webContents.capturePage()`` (real pixels, then read_image-able)
- ``preview_eval``   — run JS in the page and return its value
- ``preview_console``— read the page's console messages (errors/warns/logs)

Only ONE preview session exists at a time (the workspace is the user's
machine; a second run replaces the first). Screenshot capture REQUIRES the
Electron window — in a headless environment the tools return a clear error
instead of pretending to work.
"""
from __future__ import annotations

import asyncio
import functools
import http.server
import json
import os
import re
import socket
import threading
import time
import uuid
from typing import Any, Callable

from .logger import info as log_info, warn as log_warn

# ─── Bridge script injected into served HTML pages ─────────────────────
# The static server appends this to every .html response. It registers the
# page with the session (window_registered), streams console output and
# uncaught errors back via /__bridge, and connects the /__reload SSE channel
# so the page refreshes the moment a file changes. Only runs when the URL
# carries the session's __kxid param — a human opening the base URL in a
# normal browser tab gets the plain page (plus live reload), no capture.
BRIDGE_JS = """
(function () {
  try {
    if (window.__kasalixPreviewLoaded) return;
    window.__kasalixPreviewLoaded = true;
    var params = new URLSearchParams(location.search);
    var id = params.get('__kxid') || '';
    if (!id) return;
    function post(payload) {
      try {
        payload.id = id;
        return fetch('/__bridge', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload), keepalive: true }).catch(function () {});
      } catch (e) { return Promise.resolve(); }
    }
    post({ type: 'register' });
    function fmt(a) {
      if (a instanceof Error) return a.message;
      if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
      return String(a);
    }
    ['log', 'warn', 'error', 'info'].forEach(function (level) {
      var orig = console[level].bind(console);
      console[level] = function () {
        try { post({ type: 'console', level: level, text: Array.from(arguments).map(fmt).join(' ').slice(0, 500) }); } catch (e) {}
        orig.apply(console, arguments);
      };
    });
    window.addEventListener('error', function (e) {
      post({ type: 'console', level: 'error',
        text: ('Uncaught: ' + e.message + ' (' + (e.filename || '') + ':' + e.lineno + ')').slice(0, 500) });
    });
    window.addEventListener('unhandledrejection', function (e) {
      var r = e.reason instanceof Error ? e.reason.message : String(e.reason);
      post({ type: 'console', level: 'error', text: ('Unhandled rejection: ' + r).slice(0, 500) });
    });
    try {
      var es = new EventSource('/__reload');
      es.onmessage = function () { location.reload(); };
    } catch (e) { /* very old browser — no live reload */ }
    function bar() {
      if (document.getElementById('kasalix-preview-bar')) return;
      var style = document.createElement('style');
      style.textContent =
        'html{height:100%}body{margin:0;min-height:100%;padding-bottom:44px;box-sizing:border-box}' +
        '#kasalix-preview-bar{position:fixed;left:0;right:0;bottom:0;height:40px;z-index:2147483647;' +
        'display:flex;align-items:center;gap:8px;padding:0 12px;background:rgba(17,24,39,.97);color:#9ca3af;' +
        'font:12px/1.4 system-ui,sans-serif;border-top:1px solid rgba(255,255,255,.08)}' +
        '#kasalix-preview-bar b{color:#34d399;font-weight:600}' +
        '#kasalix-preview-bar .spacer{flex:1}';
      document.documentElement.appendChild(style);
      var el = document.createElement('div');
      el.id = 'kasalix-preview-bar';
      el.innerHTML = '<b>Koding Preview</b><span> — live view; reloads automatically when files change.</span><span class="spacer"></span><span id=\"kasalix-preview-status\">live</span>';
      (document.body || document.documentElement).appendChild(el);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bar);
    else bar();
  } catch (e) { /* never break the page */ }
})();
"""


def _is_loopback(host: str) -> bool:
    return host in ("127.0.0.1", "localhost", "::1")


class _PreviewFileHandler(http.server.SimpleHTTPRequestHandler):
    """Serves files from a fixed root, workspace-jail style."""

    def __init__(self, *args: Any, root: str = "", **kwargs: Any) -> None:
        self.root = root
        super().__init__(*args, directory=root, **kwargs)

    # Silence per-request stderr noise
    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        pass

    def end_headers(self) -> None:
        # No-cache: the agent edits files; the page must always reflect disk.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def _jail_check(self, path: str) -> bool:
        # http.server's translate_path is directory-scoped already; this is a
        # second belt for explicit traversal attempts.
        return ".." not in path.replace("\\", "/").split("/")

    def do_GET(self) -> None:  # noqa: N802
        route = self.path.split("?")[0]
        if route == "/__preview.js":
            body = BRIDGE_JS.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if route == "/__reload":
            self._handle_reload()
            return
        if not self._jail_check(self.path):
            self.send_error(403, "Forbidden")
            return
        # Inject the bridge script into HTML responses so the preview page
        # registers itself, reports console/errors, and live-reloads.
        p = self.translate_path(route)
        if os.path.isdir(p):
            p = os.path.join(p, "index.html")
        if p.lower().endswith((".html", ".htm")) and os.path.isfile(p):
            try:
                with open(p, "rb") as f:
                    html = f.read().decode("utf-8", "replace")
                tag = '<script src="/__preview.js"></script>'
                low = html.lower()
                idx = low.find("</body>")
                if idx == -1:
                    idx = low.find("</html>")
                out = (html[:idx] + tag + html[idx:]) if idx != -1 else html + tag
                body = out.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Cache-Control", "no-store, must-revalidate")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            except Exception:  # noqa: BLE001 — fall through to default serving
                pass
        # Everything else: default static serving (directory listings,
        # assets, index.html fallbacks).
        super().do_GET()

    def _handle_reload(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        session = get_preview_session()
        if session is None:
            return
        session.sse_clients.add(self)
        last_version = session.reload_version
        try:
            while True:
                with session.reload_cond:
                    session.reload_cond.wait(timeout=15)
                    if session.reload_version == last_version:
                        self.wfile.write(b": ping\n\n")  # keepalive comment
                        self.wfile.flush()
                        continue
                    last_version = session.reload_version
                data = f"data: {session.reload_kind}:{session.reload_path}\n\n".encode()
                self.wfile.write(data)
                self.wfile.flush()
        except Exception:  # noqa: BLE001 — client went away
            pass
        finally:
            session.sse_clients.discard(self)

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/__bridge":
            length = int(self.headers.get("Content-Length") or 0)
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except Exception:  # noqa: BLE001
                body = {}
            session = get_preview_session()
            if session is not None:
                mtype = str(body.get("type") or "")
                if mtype == "register":
                    # Only the page carrying THIS session's id marks the
                    # window as connected (a stale tab from an old session
                    # must not).
                    if str(body.get("id") or "") == session.session_id:
                        session.window_registered.set()
                        log_info("[preview] Preview page registered with session bridge")
                elif mtype == "console":
                    level = str(body.get("level") or "log")
                    text = str(body.get("text") or "")[:500]
                    if len(session.console) < 500:
                        session.console.append({"level": level, "text": text, "ts": time.time()})
                    if session.console_cb:
                        try:
                            session.console_cb(level, text)
                        except Exception:  # noqa: BLE001
                            pass
            self.send_response(204)
            self.end_headers()
            return
        self.send_error(404)


class PreviewSession:
    def __init__(self, root: str) -> None:
        self.root = os.path.abspath(root)
        self.session_id = uuid.uuid4().hex[:12]
        self.port = 0
        self.server: http.server.ThreadingHTTPServer | None = None
        self.thread: threading.Thread | None = None
        self.sse_clients: set = set()
        self.reload_cond = threading.Condition()
        self.reload_version = 0
        self.reload_kind = ""
        self.reload_path = ""
        self.console: list[dict[str, Any]] = []
        self.console_cb: Callable[[str, str], None] | None = None
        self.window_registered = asyncio.Event()
        self.started_at = time.time()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/?__kxid={self.session_id}"


_SESSION: PreviewSession | None = None
_SESSION_LOCK = threading.Lock()


def get_preview_session() -> PreviewSession | None:
    return _SESSION


def _notify_reload(kind: str, path: str) -> None:
    """Push a reload event to connected SSE clients (called from the FS watcher)."""
    session = _SESSION
    if session is None or not session.sse_clients:
        return
    with session.reload_cond:
        session.reload_version += 1
        session.reload_kind = kind
        session.reload_path = path
        session.reload_cond.notify_all()


def start_preview(root: str, open_window: Callable[[str], None] | None = None) -> dict[str, Any]:
    """Start (or restart) the static server for `root`. Returns session info."""
    global _SESSION
    root = os.path.abspath(root)
    if not os.path.isdir(root):
        return {"ok": False, "error": f"Preview root is not a directory: {root}"}
    with _SESSION_LOCK:
        if _SESSION is not None:
            _stop_locked()
        session = PreviewSession(root)
        handler = functools.partial(_PreviewFileHandler, root=root)
        try:
            session.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        except OSError as e:
            return {"ok": False, "error": f"Could not bind preview server: {e}"}
        session.port = session.server.server_address[1]
        thread = threading.Thread(target=session.server.serve_forever, daemon=True)
        thread.start()
        session.thread = thread
        _SESSION = session
    log_info(f"[preview] Serving {root} at http://127.0.0.1:{session.port}")
    if open_window is not None:
        try:
            open_window(session.url)
        except Exception as e:  # noqa: BLE001
            log_warn(f"[preview] Failed to ask client to open window: {e}")
    return {"ok": True, "url": session.url, "root": root, "sessionId": session.session_id}


def stop_preview() -> dict[str, Any]:
    global _SESSION
    with _SESSION_LOCK:
        if _SESSION is None:
            return {"ok": True, "stopped": False}
        _stop_locked()
        return {"ok": True, "stopped": True}


def _stop_locked() -> None:
    global _SESSION
    session = _SESSION
    _SESSION = None
    if session is None:
        return
    try:
        session.server.shutdown()  # type: ignore[union-attr]
        session.server.server_close()  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001
        pass
    log_info("[preview] Server stopped")


def describe_session() -> str:
    session = get_preview_session()
    if session is None:
        return "(no preview running)"
    return f"http://127.0.0.1:{session.port} (root: {session.root})"


# ─── File watching for live reload ──────────────────────────────────────

async def watch_preview_root(root: str, signal: asyncio.Event) -> None:
    """Poll mtimes under `root` and trigger reloads on change. Runs until `signal`."""
    snapshot: dict[str, float] = {}

    def snap() -> dict[str, float]:
        out: dict[str, float] = {}
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules", "__pycache__", ".venv")]
            for f in filenames:
                p = os.path.join(dirpath, f)
                try:
                    out[p] = os.path.getmtime(p)
                except OSError:
                    pass
        return out

    snapshot = snap()
    warned_full = False
    while not signal.is_set():
        await asyncio.sleep(1.0)
        if get_preview_session() is None:
            continue  # nothing to watch for while no preview is live
        try:
            now = snap()
        except Exception:  # noqa: BLE001
            continue
        if len(now) > _MAX_WATCHED_FILES:
            if not warned_full:
                log_warn(f"[preview] {len(now)} files — live reload disabled (workspace too large)")
                warned_full = True
            continue
        changed = [p for p, m in now.items() if snapshot.get(p) != m]
        removed = [p for p in snapshot if p not in now]
        snapshot = now
        for p in changed[:5]:
            _notify_reload("changed", os.path.relpath(p, root))
        for p in removed[:5]:
            _notify_reload("removed", os.path.relpath(p, root))


async def wait_for_window_registered(timeout: float = 10.0) -> bool:
    session = get_preview_session()
    if session is None:
        return False
    try:
        await asyncio.wait_for(session.window_registered.wait(), timeout=timeout)
        return True
    except asyncio.TimeoutError:
        return False


# ─── Client preview bridge (Electron main-process listener) ────────────
# The desktop client registers a loopback-only HTTP listener with the backend
# (POST /api/preview/register-client, loopback-origin only). Preview tools
# POST requests there to open the window, capture screenshots, and run JS —
# no SSE/pipeline plumbing needed.

_client_bridge: dict[str, Any] = {"url": None}


class PreviewBridgeError(RuntimeError):
    """Raised when the client preview bridge cannot service a request."""


def register_client_bridge(url: str) -> dict[str, Any]:
    url = (url or "").strip()
    if not re.match(r"^http://(127\.0\.0\.1|localhost|\[::1\]):\d+/", url):
        return {"ok": False, "error": "Bridge URL must be a loopback http URL ending in /"}
    _client_bridge["url"] = url
    log_info(f"[preview] Client bridge registered: {url}")
    return {"ok": True}


def client_bridge_url() -> str | None:
    return _client_bridge["url"]


async def client_call(payload: dict[str, Any], timeout: float = 12.0) -> dict[str, Any]:
    """POST one action to the registered client bridge. Raises PreviewBridgeError."""
    import httpx

    url = _client_bridge["url"]
    if not url:
        raise PreviewBridgeError(
            "No desktop client preview bridge is registered with this backend. "
            "Common causes: (1) the Kasalix client is not running — start it; "
            "(2) the client predates the preview feature — rebuild it (cd frontend && npm run build:electron); "
            "(3) the client cannot reach this backend at all — check its server connection settings and the "
            "client console log for the exact registration error "
            "(repeated every 15 s while it keeps retrying). "
            "The client re-registers automatically within 15 s once the cause is fixed."
        )

    def _post() -> dict[str, Any]:
        with httpx.Client(timeout=timeout) as client:
            resp = client.post(url, json=payload)
            resp.raise_for_status()
            data = resp.json()
        if not isinstance(data, dict) or not data.get("ok"):
            raise PreviewBridgeError(str((data or {}).get("error") or "client preview call failed"))
        return data

    return await asyncio.to_thread(_post)


# ─── Workspace watcher (live reload) ────────────────────────────────────

_watcher_task: asyncio.Task | None = None
_MAX_WATCHED_FILES = 15000


def ensure_watcher(root: str) -> None:
    """Start the change watcher once per process (idempotent)."""
    global _watcher_task
    if _watcher_task is not None and not _watcher_task.done():
        return
    stop = asyncio.Event()
    _watcher_task = asyncio.create_task(watch_preview_root(root, stop))
