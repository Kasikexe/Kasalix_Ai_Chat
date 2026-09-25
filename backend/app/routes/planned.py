"""Planned features routes — mirrors backend/src/routes/planned.ts."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..deps import admin_authenticated
from ..services.planned import add_planned_feature, delete_planned_feature, get_planned_features, update_planned_feature

router = APIRouter()

VALID_STATUSES = ("done", "in-progress", "planned")


@router.get("")
async def list_features(request: Request) -> dict:
    if not admin_authenticated(request):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    return {"features": await get_planned_features()}


@router.post("")
async def create_feature(request: Request) -> dict:
    if not admin_authenticated(request):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    body = await request.json()
    title = body.get("title")
    description = body.get("description")
    if not title or not description:
        return JSONResponse({"error": "title and description are required"}, status_code=400)
    status = body.get("status") or "planned"
    if status not in VALID_STATUSES:
        return JSONResponse({"error": "status must be done, in-progress, or planned"}, status_code=400)
    feature = await add_planned_feature(
        {"title": title, "description": description, "status": status, "icon": body.get("icon") or "📋"}
    )
    return JSONResponse({"feature": feature}, status_code=201)


@router.put("/{feature_id}")
async def update_feature(feature_id: str, request: Request) -> dict:
    if not admin_authenticated(request):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    body = await request.json()
    updates: dict = {}
    if body.get("title") is not None:
        updates["title"] = body["title"]
    if body.get("description") is not None:
        updates["description"] = body["description"]
    if body.get("status") is not None:
        if body["status"] not in VALID_STATUSES:
            return JSONResponse({"error": "Invalid status"}, status_code=400)
        updates["status"] = body["status"]
    if body.get("icon") is not None:
        updates["icon"] = body["icon"]
    if body.get("order") is not None:
        updates["order"] = body["order"]
    updated = await update_planned_feature(feature_id, updates)
    if not updated:
        return JSONResponse({"error": "Feature not found"}, status_code=404)
    return {"feature": updated}


@router.delete("/{feature_id}")
async def delete_feature(feature_id: str, request: Request) -> dict:
    if not admin_authenticated(request):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    deleted = await delete_planned_feature(feature_id)
    if not deleted:
        return JSONResponse({"error": "Feature not found"}, status_code=404)
    return {"success": True}