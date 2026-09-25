"""FastAPI auth dependencies — mirror the Hono middleware in backend/src/index.ts.

- Every request gets a user id: Bearer session token wins, else the
  X-User-Id header, else a fresh generated id.
- Admin routes (settings, planned, changelog, speedtest, plugins,
  cloud-usage, session-logs, ollama) are OPEN: the settings password was
  removed because a one-click reset made it security theater. Securing the
  host is now the operator's job (lock the PC / restrict the server).
- /api/chat, /api/conversations, /api/files, /api/memory require a valid
  Bearer session token.
"""

from __future__ import annotations

from typing import Callable

from fastapi import Request
from fastapi.responses import JSONResponse

from .auth import validate_session
from .config import generate_id

ADMIN_PATHS = [
    "/api/settings",
    "/api/planned",
    "/api/changelog",
    "/api/speedtest",
    "/api/plugins",
    "/api/cloud-usage",
    "/api/session-logs",
    "/api/ollama",
]
# ADMIN_PATHS is kept only to document which routes used to be password-protected;
# admin_authenticated() always allows requests now.

SESSION_PROTECTED_PATHS = [
    "/api/chat",
    "/api/conversations",
    "/api/files",
    "/api/memory",
]


def admin_authenticated(request: Request) -> bool:
    """Admin auth was removed (the settings password had a one-click reset,
    which made it pointless) — every admin request is allowed. Kept as a
    no-op so all route-level checks stay valid Python with zero churn."""
    return True


def user_id_from_request(request: Request) -> str:
    auth_header = request.headers.get("authorization") or ""
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]
        result = validate_session(token)
        if result.get("valid") and result.get("userId"):
            return result["userId"]
    header_id = request.headers.get("x-user-id")
    return header_id or generate_id()


def session_authenticated(request: Request) -> bool:
    auth_header = request.headers.get("authorization") or ""
    if not auth_header.startswith("Bearer "):
        return False
    result = validate_session(auth_header[7:])
    return bool(result.get("valid") and result.get("userId"))


def require_admin() -> Callable[[Request], dict | JSONResponse | None]:
    async def dependency(request: Request) -> dict | JSONResponse | None:
        if not admin_authenticated(request):
            return JSONResponse({"error": "Not authenticated"}, status_code=401)
        return None

    return dependency


def require_session() -> Callable[[Request], dict | JSONResponse | None]:
    async def dependency(request: Request) -> dict | JSONResponse | None:
        if not session_authenticated(request):
            return JSONResponse({"error": "Authentication required"}, status_code=401)
        return None

    return dependency