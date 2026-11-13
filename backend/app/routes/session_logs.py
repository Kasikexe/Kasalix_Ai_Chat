"""Session log routes — mirrors backend/src/routes/session-logs.ts."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from pathlib import Path

from ..config import get_data_dir
from ..deps import session_authenticated, user_id_from_request
from ..services.session_log import list_session_logs, read_session_log

router = APIRouter()


@router.get("")
async def list_logs(request: Request) -> dict:
    if not session_authenticated(request):
        return JSONResponse({"error": "Authentication required"}, status_code=401)
    try:
        return {"logs": await list_session_logs(user_id_from_request(request))}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e) or "Failed"}, status_code=500)


@router.get("/{run_id}")
async def read_log(run_id: str, request: Request) -> dict:
    if not session_authenticated(request):
        return JSONResponse({"error": "Authentication required"}, status_code=401)
    try:
        events = await read_session_log(run_id)
        if not events or events[0].get("meta", {}).get("ownerId") != user_id_from_request(request):
            return JSONResponse({"error": "Session log not found"}, status_code=404)
        return {"runId": run_id, "events": events}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e) or "Failed"}, status_code=500)


@router.delete("/{run_id}")
async def delete_log(run_id: str, request: Request) -> dict:
    if not session_authenticated(request):
        return JSONResponse({"error": "Authentication required"}, status_code=401)
    events = await read_session_log(run_id)
    if not events or events[0].get("meta", {}).get("ownerId") != user_id_from_request(request):
        return JSONResponse({"error": "Session log not found"}, status_code=404)
    try:
        (Path(get_data_dir()) / "session-logs" / f"{run_id}.jsonl").unlink()
    except OSError:
        return JSONResponse({"error": "Could not delete session log"}, status_code=500)
    return {"success": True}
