"""Kasalix AI backend — FastAPI entry point (ports backend/src/index.ts).

Serves the same API contract as the TypeScript/Hono backend: HTTPS with
auto-generated self-signed certs, SSE chat streaming, workspace-sandboxed
files, admin auth via the settings_auth cookie, session auth via Bearer
tokens, generated image serving, terminal + tools APIs, the download page,
and the built frontend when run standalone.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import signal as _signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from .ai_rules import ensure_ai_rules_file
from .auth import destroy_session, shutdown as shutdown_auth, start_auth as start_auth_service
from .capabilities import probe_all_models
from .config import (
    app_version,
    get_certs_dir,
    get_generated_images_dir,
    get_release_dir,
    get_static_dir,
    port,
)
from .deps import SESSION_PROTECTED_PATHS, session_authenticated, user_id_from_request
from .logger import error as log_error, info as log_info, warn as log_warn
from .routes import (
    attachments as attachments_routes,
    auth as auth_routes,
    changelog as changelog_routes,
    chat as chat_routes,
    cloud_usage as cloud_usage_routes,
    conversations as conversations_routes,
    files as files_routes,
    memory as memory_routes,
    models as models_routes,
    ollama as ollama_routes,
    planned as planned_routes,
    plugins as plugins_routes,
    preview as preview_routes,
    session_logs as session_logs_routes,
    settings as settings_routes,
    speedtest as speedtest_routes,
)
from .routes.ollama import (
    auto_apply_settings_if_external,
    detect_ollama_ownership,
    ensure_ollama_running_at_startup,
)
from .services.plugins.manager import load_installed_plugins
from .tools import execute_tool as execute_builtin_tool
from .tools import get_all_tools
from .tools.register import register_all_tools

app = FastAPI(title="Kasalix AI Chat Backend", docs_url=None, redoc_url=None, openapi_url=None)

# ─── Startup hooks ────────────────────────────────────────────
register_all_tools()


async def _startup() -> None:
    try:
        await load_installed_plugins()
    except Exception as e:  # noqa: BLE001
        log_error("[plugins] Startup load failed:", e)
    try:
        ensure_ai_rules_file()
    except Exception as e:  # noqa: BLE001
        log_warn(f"[server] Could not create AI rules file: {e}")


@app.on_event("startup")
async def _startup_event() -> None:
    # Load persisted users/sessions + start the session persist/cleanup loops.
    # Without this, "Remember me" silently died at every backend restart:
    # tokens were written to sessions.json but never loaded back, so every
    # client was logged out whenever the server process restarted.
    try:
        await start_auth_service()
    except Exception as e:  # noqa: BLE001
        log_error("[auth] Startup init failed:", e)
    await _startup()
    # Probe installed models for tool/thinking capabilities (non-blocking)
    asyncio.create_task(_probe_task())


async def _probe_task() -> None:
    try:
        await probe_all_models()
    except Exception:  # noqa: BLE001
        pass
    try:
        await detect_ollama_ownership()
    except Exception:  # noqa: BLE001
        pass
    # An external Ollama (tray autostart) runs on its own env — restart it
    # with the host's saved tuning instead of waiting for Save & Restart.
    try:
        await auto_apply_settings_if_external()
    except Exception:  # noqa: BLE001
        pass
    # After a Server-app restart Ollama is dead (the GUI tree-kills the
    # backend, and Ollama is its child) — spawn it back up with the saved
    # tuning instead of leaving every client with 502s until manual action.
    try:
        await ensure_ollama_running_at_startup()
    except Exception:  # noqa: BLE001
        pass


# ─── Middleware ───────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-User-Id"],
    expose_headers=["X-User-Id"],
)


@app.middleware("http")
async def request_logger(request: Request, call_next: Any) -> Any:
    start = time.time() * 1000
    response = await call_next(request)
    ms = int(time.time() * 1000 - start)
    method = request.method
    path = request.url.path
    status = response.status_code
    marker = "\x1b[32m" if status < 400 else ("\x1b[33m" if status < 500 else "\x1b[31m")
    reset = "\x1b[0m"
    print(
        f"{time.strftime('%H:%M:%S')} {marker}{method} {path} {status}{reset} {ms}ms",
        file=sys.stdout,
        flush=True,
    )
    return response


@app.middleware("http")
async def session_protect(request: Request, call_next: Any) -> Any:
    path = request.url.path
    for pattern in SESSION_PROTECTED_PATHS:
        # /api/chat/* style — match prefix for both the base and subpaths
        base = pattern.rstrip("/*")
        if path == base or path.startswith(base + "/"):
            if not session_authenticated(request):
                return JSONResponse({"error": "Authentication required"}, status_code=401)
    return await call_next(request)


# ─── API routes ───────────────────────────────────────────────
app.include_router(models_routes.router, prefix="/api/models")
app.include_router(chat_routes.router, prefix="/api/chat")
app.include_router(conversations_routes.router, prefix="/api/conversations")
app.include_router(settings_routes.router, prefix="/api/settings")
app.include_router(files_routes.router, prefix="/api/files")
app.include_router(memory_routes.router, prefix="/api/memory")
app.include_router(changelog_routes.router, prefix="/api/changelog")
app.include_router(planned_routes.router, prefix="/api/planned")
app.include_router(ollama_routes.router, prefix="/api/ollama")
app.include_router(preview_routes.router, prefix="/api/preview")
app.include_router(speedtest_routes.router, prefix="/api/speedtest")
app.include_router(plugins_routes.router, prefix="/api/plugins")
app.include_router(cloud_usage_routes.router, prefix="/api/cloud-usage")
app.include_router(session_logs_routes.router, prefix="/api/session-logs")
app.include_router(auth_routes.router, prefix="/api/auth")
app.include_router(attachments_routes.router, prefix="/api/attachments")


# ─── Generated images ─────────────────────────────────────────
GENERATED_IMAGES_DIR = get_generated_images_dir()

IMAGE_CONTENT_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
}


def is_safe_image_filename(filename: str) -> bool:
    return (
        ".." not in filename
        and "/" not in filename
        and "\\" not in filename
        and bool(re.fullmatch(r"[A-Za-z0-9._-]+", filename))
    )


async def serve_generated_image(filename: str, force_download: bool) -> Response:
    if not is_safe_image_filename(filename):
        return JSONResponse({"error": "Invalid filename"}, status_code=400)
    file_path = GENERATED_IMAGES_DIR / filename
    try:
        data = file_path.read_bytes()
    except OSError:
        return JSONResponse({"error": "Image not found"}, status_code=404)
    ext = file_path.suffix.lower()
    headers = {
        "Content-Type": IMAGE_CONTENT_TYPES.get(ext, "application/octet-stream"),
        "Cache-Control": "no-cache" if force_download else "public, max-age=3600",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    }
    if force_download:
        headers["Content-Disposition"] = f'attachment; filename="{filename}"'
    return Response(content=data, headers=headers)


@app.get("/api/generated/{filename}")
async def generated_image(filename: str) -> Response:
    return await serve_generated_image(filename, False)


@app.get("/api/generated/{filename}/download")
async def generated_image_download(filename: str) -> Response:
    return await serve_generated_image(filename, True)


@app.post("/api/generated/{filename}/save-to-workspace")
async def save_generated_to_workspace(filename: str, request: Request) -> Response:
    if not is_safe_image_filename(filename):
        return JSONResponse({"error": "Invalid filename"}, status_code=400)
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"error": "workspacePath is required in request body"}, status_code=400)
    target_dir = body.get("workspacePath")
    if not target_dir or not isinstance(target_dir, str):
        return JSONResponse({"error": "workspacePath is required"}, status_code=400)
    source_path = GENERATED_IMAGES_DIR / filename
    dest_path = Path(os.path.abspath(target_dir)) / filename
    try:
        if not source_path.is_file():
            return JSONResponse({"error": "Image not found"}, status_code=404)
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        import shutil

        shutil.copyfile(source_path, dest_path)
        log_info(f"[image] Saved to workspace: {dest_path}")
        return JSONResponse({"success": True, "path": str(dest_path), "filename": filename})
    except Exception as e:  # noqa: BLE001
        log_error("[image] Save to workspace failed:", e)
        return JSONResponse({"error": "Failed to save image to workspace"}, status_code=500)


# ─── Terminal API ─────────────────────────────────────────────
@app.post("/api/terminal")
async def terminal(request: Request) -> Response:
    if not session_authenticated(request):
        return JSONResponse({"error": "Authentication required"}, status_code=401)
    try:
        body = await request.json()
        command = body.get("command")
        cwd = body.get("cwd")
        workspace_path = body.get("workspacePath")
        if not command or not isinstance(command, str):
            return JSONResponse({"error": "command is required"}, status_code=400)
        if not workspace_path or not isinstance(workspace_path, str):
            return JSONResponse({"error": "A valid workspacePath is required in the request body"}, status_code=403)
        workspace_root = os.path.abspath(workspace_path)
        if os.path.splitdrive(workspace_root)[1] in ("\\", "/") or workspace_root == "/":
            return JSONResponse({"error": "workspacePath must be a real folder, not a drive root"}, status_code=403)
        safe_cwd = os.path.abspath(cwd) if cwd else workspace_root
        from .utils import is_path_inside

        if not (await is_path_inside(workspace_root, safe_cwd)):
            user_id = user_id_from_request(request)
            log_warn(f"[terminal] Blocked cwd outside workspace from user {user_id}: {safe_cwd}")
            return JSONResponse({"error": "Access denied: cwd is outside the workspace"}, status_code=403)

        dangerous = re.compile(r"\b(rm\s+-[rf]\s+/|format\s+[c-z]:\s*/q|dd\s+if=|mkfs\.|fdisk|shutdown\s+-[rh]\s+-t\s+0|del\s+/f\s+/s)", re.I)
        if dangerous.search(command):
            return JSONResponse({"error": "Command blocked for security"}, status_code=403)

        proc = await asyncio.create_subprocess_shell(
            command,
            cwd=safe_cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60)
        except asyncio.TimeoutError:
            proc.kill()
            return JSONResponse(
                {
                    "success": False,
                    "stdout": "",
                    "stderr": "Command timed out after 60 seconds",
                    "code": 1,
                    "killed": True,
                    "timeout": True,
                }
            )
        return JSONResponse(
            {
                "success": True,
                "stdout": (stdout or b"").decode("utf-8", "replace"),
                "stderr": (stderr or b"").decode("utf-8", "replace"),
                "code": 0,
            }
        )
    except Exception as e:  # noqa: BLE001
        return JSONResponse(
            {
                "success": False,
                "stdout": "",
                "stderr": str(e),
                "code": 1,
                "killed": False,
                "timeout": False,
            }
        )


# ─── Tools API ────────────────────────────────────────────────
@app.get("/api/tools")
async def list_tools() -> dict:
    return {"tools": [vars(t) for t in get_all_tools()]}


@app.post("/api/tools/execute")
async def execute_tool_route(request: Request) -> Response:
    if not session_authenticated(request):
        return JSONResponse({"error": "Authentication required"}, status_code=401)
    body = await request.json()
    tool_id = body.get("toolId")
    if not tool_id:
        return JSONResponse({"error": "toolId is required"}, status_code=400)
    result = await execute_builtin_tool(tool_id, body.get("params") or {}, {"userInput": body.get("userInput") or ""})
    from .tools import ToolResult

    if isinstance(result, ToolResult):
        return JSONResponse({"success": result.success, "output": result.output, "data": result.data})
    return JSONResponse(result)


# ─── Download page + release files ────────────────────────────
RELEASE_DIR = get_release_dir()
GITHUB_RELEASES_URL = os.environ.get("GITHUB_RELEASES_URL") or f"https://github.com/{os.environ.get('GITHUB_REPO') or 'Kasikexe/Kasalix'}/releases"

DOWNLOAD_HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#0a0a0a" />
  <title>Download Kasalix AI Chat</title>
  <style>
    * {{ margin: 0; padding: 0; box-sizing: border-box; }}
    body {{
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #030712; color: #e5e7eb; min-height: 100vh;
      display: flex; justify-content: center; align-items: center;
    }}
    .container {{ max-width: 600px; padding: 2rem; text-align: center; }}
    h1 {{ font-size: 1.5rem; font-weight: 700; color: #f9fafb; margin-bottom: 0.5rem; }}
    .subtitle {{ color: #9ca3af; font-size: 0.95rem; margin-bottom: 2rem; line-height: 1.5; }}
    .card {{
      background: linear-gradient(135deg, #111827, #1f2937); border: 1px solid #374151;
      border-radius: 12px; padding: 1.5rem; margin-bottom: 1rem;
      display: flex; align-items: center; gap: 1rem; text-decoration: none; transition: all 0.2s ease;
    }}
    .card:hover {{ border-color: #6366f1; background: linear-gradient(135deg, #1e1b4b, #1f2937); transform: translateY(-1px); }}
    .card-icon {{ width: 48px; height: 48px; background: #1e293b; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 1.5rem; flex-shrink: 0; }}
    .card-content {{ flex: 1; text-align: left; }}
    .card-title {{ color: #f9fafb; font-weight: 600; font-size: 1rem; margin-bottom: 0.25rem; }}
    .card-desc {{ color: #9ca3af; font-size: 0.8rem; }}
    .badge {{ display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 0.7rem; font-weight: 500; margin-top: 4px; }}
    .badge-green {{ background: #064e3b; color: #6ee7b7; }}
    .badge-blue {{ background: #1e3a5f; color: #93c5fd; }}
    .badge-gray {{ background: #374151; color: #9ca3af; }}
    .github-link {{ margin-top: 2rem; display: inline-block; color: #6366f1; font-size: 0.85rem; text-decoration: none; }}
    .github-link:hover {{ text-decoration: underline; }}
  </style>
</head>
<body>
  <div class="container">
    <h1>Kasalix AI Chat</h1>
    <p class="subtitle">Download the app for your device.<br>Connect to your local AI server.</p>

    <a href="{desktop_href}" class="card" target="{desktop_target}" rel="noopener noreferrer">
      <div class="card-icon">🪟</div>
      <div class="card-content">
        <div class="card-title">Windows Desktop</div>
        <div class="card-desc">{desktop_desc}</div>
        <span class="badge {desktop_badge_cls}">{desktop_badge}</span>
      </div>
    </a>

    <a href="{android_href}" class="card" target="{android_target}" rel="noopener noreferrer">
      <div class="card-icon">📱</div>
      <div class="card-content">
        <div class="card-title">Android App</div>
        <div class="card-desc">{android_desc}</div>
        <span class="badge {android_badge_cls}">{android_badge}</span>
      </div>
    </a>

    <a href="{github_url}" class="github-link" target="_blank" rel="noopener noreferrer">View all releases on GitHub →</a>
  </div>
</body>
</html>"""


def _scan_release_dir() -> dict[str, Any]:
    has_desktop = False
    has_android = False
    desktop_name = ""
    android_name = ""
    try:
        for f in os.listdir(RELEASE_DIR):
            if f.endswith(".exe") and not f.endswith(".exe.blockmap"):
                has_desktop = True
                desktop_name = f
            if f.lower().endswith(".apk"):
                has_android = True
                android_name = f
    except OSError:  # noqa: S110
        pass
    return {
        "hasDesktop": has_desktop,
        "hasAndroid": has_android,
        "desktopName": desktop_name,
        "androidName": android_name,
    }


@app.get("/download")
async def download_page() -> Response:
    scan = _scan_release_dir()
    version = app_version()
    html = DOWNLOAD_HTML_TEMPLATE.format(
        desktop_href="/download/desktop" if scan["hasDesktop"] else GITHUB_RELEASES_URL,
        desktop_target="_self" if scan["hasDesktop"] else "_blank",
        desktop_desc="Download from this server" if scan["hasDesktop"] else "Get from GitHub releases",
        desktop_badge_cls="badge-blue" if scan["hasDesktop"] else "badge-gray",
        desktop_badge=scan["desktopName"] if scan["hasDesktop"] else "Not on this server",
        android_href="/download/android" if scan["hasAndroid"] else GITHUB_RELEASES_URL,
        android_target="_self" if scan["hasAndroid"] else "_blank",
        android_desc="Download from this server" if scan["hasAndroid"] else "Get from GitHub releases",
        android_badge_cls="badge-green" if scan["hasAndroid"] else "badge-gray",
        android_badge=scan["androidName"] if scan["hasAndroid"] else "Not on this server",
        github_url=GITHUB_RELEASES_URL,
    )
    return Response(content=html, media_type="text/html")


@app.get("/download/desktop")
async def download_desktop() -> Response:
    try:
        for f in os.listdir(RELEASE_DIR):
            if f.endswith(".exe") and not f.endswith(".exe.blockmap"):
                data = (RELEASE_DIR / f).read_bytes()
                return Response(
                    content=data,
                    media_type="application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{f}"'},
                )
    except OSError:  # noqa: S110
        pass
    return RedirectResponse(GITHUB_RELEASES_URL)


@app.get("/download/android")
async def download_android() -> Response:
    try:
        for f in os.listdir(RELEASE_DIR):
            if f.lower().endswith(".apk"):
                data = (RELEASE_DIR / f).read_bytes()
                return Response(
                    content=data,
                    media_type="application/vnd.android.package-archive",
                    headers={"Content-Disposition": f'attachment; filename="{f}"'},
                )
    except OSError:  # noqa: S110
        pass
    return RedirectResponse(GITHUB_RELEASES_URL)


@app.get("/latest.yml")
async def latest_yml() -> Response:
    try:
        data = (RELEASE_DIR / "latest.yml").read_bytes()
        return Response(content=data, media_type="text/yaml", headers={"Cache-Control": "no-cache"})
    except OSError:
        return JSONResponse({"error": "Not found"}, status_code=404)


@app.get("/{filename}.blockmap")
async def blockmap_file(filename: str) -> Response:
    if ".." in filename or "/" in filename or "\\" in filename:
        return JSONResponse({"error": "Invalid path"}, status_code=400)
    try:
        data = (RELEASE_DIR / f"{filename}.blockmap").read_bytes()
        return Response(content=data, media_type="application/octet-stream", headers={"Cache-Control": "no-cache"})
    except OSError:
        return JSONResponse({"error": "Not found"}, status_code=404)


@app.get("/{filename}.exe")
async def exe_file(filename: str) -> Response:
    if ".." in filename or "/" in filename or "\\" in filename:
        return JSONResponse({"error": "Invalid path"}, status_code=400)
    try:
        data = (RELEASE_DIR / f"{filename}.exe").read_bytes()
        return Response(content=data, media_type="application/octet-stream", headers={"Cache-Control": "no-cache"})
    except OSError:
        return JSONResponse({"error": "Not found"}, status_code=404)


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}


# ─── Frontend Static File Server ──────────────────────────────
STATIC_DIR = get_static_dir()
MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
}


@app.exception_handler(StarletteHTTPException)
async def spa_fallback(request: Request, exc: StarletteHTTPException) -> Response:
    if exc.status_code != 404:
        return JSONResponse({"error": str(exc.detail)}, status_code=exc.status_code)
    url = request.url.path
    if url.startswith("/api/") or url == "/download":
        return JSONResponse({"error": "Not found"}, status_code=404)
    if ".." in url:
        return JSONResponse({"error": "Invalid path"}, status_code=400)

    file_path = "/index.html" if url in ("/", "") else url
    full_path = STATIC_DIR / file_path.lstrip("/")
    try:
        if full_path.is_file():
            ext = full_path.suffix.lower()
            content_type = MIME_TYPES.get(ext, "application/octet-stream")
            data = full_path.read_bytes()
            return Response(content=data, media_type=content_type, headers={"Cache-Control": "public, max-age=3600"})
    except OSError:  # noqa: S110
        pass
    # SPA fallback: serve index.html for any non-file path
    try:
        index_data = (STATIC_DIR / "index.html").read_bytes()
        return Response(content=index_data, media_type="text/html; charset=utf-8")
    except OSError:
        return JSONResponse({"error": "Frontend not built. Run `cd frontend && npm run build` first."}, status_code=404)


# ─── Certificate generation (cryptography) ────────────────────
def ensure_certs(cert_path: str, key_path: str) -> bool:
    """Generate a self-signed localhost cert if missing/expired. Returns True if (re)generated."""
    from datetime import datetime, timedelta, timezone

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    cert_p = Path(cert_path)
    key_p = Path(key_path)

    def _valid_pair() -> bool:
        try:
            if not cert_p.is_file() or not key_p.is_file():
                return False
            cert_data = cert_p.read_bytes()
            cert = x509.load_pem_x509_certificate(cert_data)
            if cert.not_valid_after_utc < datetime.now(timezone.utc):
                return False
            return True
        except Exception:  # noqa: BLE001
            return False

    if _valid_pair():
        return False

    try:
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        subject = issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
        now = datetime.now(timezone.utc)
        cert = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(issuer)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(days=1))
            .not_valid_after(now + timedelta(days=3650))
            .add_extension(
                x509.SubjectAlternativeName(
                    [x509.DNSName("localhost"), x509.IPAddress(__import__("ipaddress").ip_address("127.0.0.1")), x509.IPAddress(__import__("ipaddress").ip_address("::1"))]
                ),
                critical=False,
            )
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(
                x509.KeyUsage(digital_signature=True, key_encipherment=True, content_commitment=False, data_encipherment=False, key_agreement=False, key_cert_sign=False, crl_sign=False, encipher_only=None, decipher_only=None),
                critical=True,
            )
            .sign(key, hashes.SHA256())
        )
        cert_p.parent.mkdir(parents=True, exist_ok=True)
        key_p.write_bytes(
            key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption(),
            )
        )
        cert_p.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
        return True
    except Exception as e:  # noqa: BLE001
        log_warn(f"[server] Certificate generation failed: {e}")
        return False


def _graceful_shutdown() -> None:
    log_info("[server] Shutting down...")
    try:
        shutdown_auth()
    except Exception:  # noqa: BLE001
        pass


def main() -> None:
    """Entry point: uvicorn with HTTPS (self-signed) + graceful shutdown."""
    p = port()
    log_info("[server] Starting...")
    log_info(f"[server] Port: {p}")
    log_info(f"[server] Session TTL: {int(os.environ.get('SESSION_TTL_MS') or 86400000)}ms")

    use_https = "--http" not in sys.argv and os.environ.get("HTTPS") != "false"

    ssl_certfile: str | None = None
    ssl_keyfile: str | None = None
    if use_https:
        certs_dir = get_certs_dir()
        cert_path = os.environ.get("SSL_CERT") or str(certs_dir / "localhost.crt")
        key_path = os.environ.get("SSL_KEY") or str(certs_dir / "localhost.key")
        try:
            created = ensure_certs(cert_path, key_path)
            if created:
                log_info(f"[server] Generated self-signed certificate ({os.path.abspath(cert_path)})")
            ssl_certfile = cert_path
            ssl_keyfile = key_path
            log_info("[server] HTTPS: enabled")
        except Exception as e:  # noqa: BLE001
            log_warn(f"[server] SSL certificates not found and could not be generated — falling back to HTTP: {e}")
            ssl_certfile = None
            ssl_keyfile = None
    else:
        log_info("[server] HTTPS: disabled — serving plain HTTP")

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    for sig in ("SIGINT", "SIGTERM"):
        try:
            loop.add_signal_handler(getattr(_signal, sig), _graceful_shutdown)
        except (NotImplementedError, AttributeError):  # noqa: S110
            pass

    config = uvicorn.Config(
        app,
        host="0.0.0.0",
        port=p,
        ssl_certfile=ssl_certfile,
        ssl_keyfile=ssl_keyfile,
        log_level="warning",
        access_log=False,
    )
    server = uvicorn.Server(config)
    scheme = "https" if ssl_certfile else "http"
    log_info(f"[server] Backend running on {scheme}://0.0.0.0:{p}")
    # Build fingerprint: lets the GUI log (and you) confirm which backend
    # build is actually serving — old exes silently kept running after upgrades.
    import platform as _platform
    import sys as _sys
    log_info(f"[server] Build: v{app_version()} — Python {_sys.version.split()[0]} ({_platform.machine()})")

    try:
        loop.run_until_complete(server.serve())
    except KeyboardInterrupt:  # noqa: S110
        pass
    finally:
        _graceful_shutdown()


if __name__ == "__main__":
    main()