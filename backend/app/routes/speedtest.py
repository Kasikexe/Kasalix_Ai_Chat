"""Speedtest routes — mirrors backend/src/routes/speedtest.ts."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..deps import admin_authenticated
from ..logger import error as log_error
from ..services.speedtest import SPEED_TESTS, delete_result, get_results, run_speed_tests

router = APIRouter()


@router.get("/tests")
async def list_tests() -> dict:
    test_list = [
        {
            "id": t["id"],
            "name": t["name"],
            "description": t["description"],
            "category": t["category"],
            "assignmentKey": t["assignmentKey"],
        }
        for t in SPEED_TESTS
    ]
    return {"tests": test_list}


@router.post("/run")
async def run_tests(request: Request) -> dict:
    if not admin_authenticated(request):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    try:
        result = await run_speed_tests()
        return {"result": result}
    except Exception as e:  # noqa: BLE001
        msg = str(e) or "Speed test failed"
        log_error("[speedtest] Run error:", msg)
        return JSONResponse({"error": msg}, status_code=500)


@router.get("/results")
async def results(request: Request) -> dict:
    if not admin_authenticated(request):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    return {"results": await get_results()}


@router.delete("/results/{result_id}")
async def delete_result_route(result_id: str, request: Request) -> dict:
    if not admin_authenticated(request):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    deleted = await delete_result(result_id)
    if not deleted:
        return JSONResponse({"error": "Result not found"}, status_code=404)
    return {"success": True}