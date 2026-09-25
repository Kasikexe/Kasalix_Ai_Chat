"""Preview bridge registration.

The Electron client runs a tiny loopback-only HTTP listener (its main
process). On startup it POSTs its URL here so the backend's preview tools
can reach it to open the preview window, capture screenshots, and run JS in
the page. Registration is idempotent — clients re-register freely (e.g.
after a backend restart).
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..logger import info as log_info, warn as log_warn

from ..preview import client_bridge_url, register_client_bridge

router = APIRouter()


@router.get("/bridge-status")
async def preview_bridge_status() -> JSONResponse:
    """Diagnostic: is a client bridge currently registered? (loopback-only)."""
    return JSONResponse({"ok": True, "registered": client_bridge_url() is not None})


@router.post("/register-client")
async def register_preview_client(request: Request) -> JSONResponse:
    # NOTE: we deliberately do NOT require the *source* IP to be loopback.
    # The client may reach the backend over a LAN IP (its saved server URL,
    # e.g. https://192.168.31.89:3001) while running on the very same
    # machine — chat works fine that way, and refusing here silently broke
    # registration forever. The security invariant that matters is that the
    # registered bridge URL itself is loopback (enforced in
    # register_client_bridge): the backend only ever POSTs to its own
    # machine, so a remote host cannot register a bridge the backend would
    # then call. A remote client registering its own loopback URL is a no-op
    # (the backend would only reach itself), which is harmless.
    try:
        body: dict[str, Any] = await request.json()
    except Exception:  # noqa: BLE001
        return JSONResponse({"ok": False, "error": "Invalid JSON body"}, status_code=400)
    url = str(body.get("url") or "")
    previous = client_bridge_url()
    result = register_client_bridge(url)
    if not result.get("ok"):
        log_warn(f"[preview] Bridge registration refused: {result.get('error')} (url={url!r})")
        return JSONResponse(result, status_code=400)
    log_info(f"[preview] Client bridge registration accepted: {url}")
    return JSONResponse({"ok": True, "previous": previous == url})
