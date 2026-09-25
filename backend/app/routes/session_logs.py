"""Session log routes — mirrors backend/src/routes/session-logs.ts."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..deps import admin_authenticated
from ..services.session_log import list_session_logs, read_session_log

router = APIRouter()


@router.get("")
async def list_logs(request: Request) -> dict:
    if not admin_authenticated(request):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    try:
        return {"logs": await list_session_logs()}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e) or "Failed"}, status_code=500)


@router.get("/{run_id}")
async def read_log(run_id: str, request: Request) -> dict:
    if not admin_authenticated(request):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    try:
        events = await read_session_log(run_id)
        return {"runId": run_id, "events": events}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e) or "Failed"}, status_code=500)