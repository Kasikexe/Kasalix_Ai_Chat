"""Changelog routes — mirrors backend/src/routes/changelog.ts."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..deps import admin_authenticated
from ..services.changelog import (
    add_changelog_entry,
    delete_changelog_entry,
    get_changelog,
    get_draft,
    publish_draft,
    update_draft,
)

router = APIRouter()

VALID_TYPES = ("major", "minor", "patch")


def _authed(request: Request) -> bool:
    return admin_authenticated(request)


@router.get("")
async def list_changelog(request: Request) -> dict:
    if not _authed(request):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    return {"entries": await get_changelog()}


@router.post("")
async def create_entry(request: Request) -> dict:
    if not _authed(request):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    body = await request.json()
    version = body.get("version")
    title = body.get("title")
    description = body.get("description")
    entry_type = body.get("type")
    if not version or not title or not description or not entry_type:
        return JSONResponse({"error": "version, title, description, and type are required"}, status_code=400)
    if entry_type not in VALID_TYPES:
        return JSONResponse({"error": "type must be major, minor, or patch"}, status_code=400)
    entry = await add_changelog_entry({"version": version, "title": title, "description": description, "type": entry_type})
    return JSONResponse({"entry": entry}, status_code=201)


@router.delete("/{version}")
async def delete_entry(version: str, request: Request) -> dict:
    if not _authed(request):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    deleted = await delete_changelog_entry(version)
    if not deleted:
        return JSONResponse({"error": "Version not found"}, status_code=404)
    return {"success": True}


@router.get("/draft")
async def get_draft_route(request: Request) -> dict:
    if not _authed(request):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    return {"draft": await get_draft()}


@router.put("/draft")
async def save_draft(request: Request) -> dict:
    if not _authed(request):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    body = await request.json()
    description = body.get("description")
    if description is None:
        return JSONResponse({"error": "description is required"}, status_code=400)
    draft = await update_draft(description)
    return {"draft": draft}


@router.post("/draft/publish")
async def publish(request: Request) -> dict:
    if not _authed(request):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    body = await request.json()
    version = body.get("version")
    title = body.get("title")
    entry_type = body.get("type")
    if not version or not title or not entry_type:
        return JSONResponse({"error": "version, title, and type are required"}, status_code=400)
    if entry_type not in VALID_TYPES:
        return JSONResponse({"error": "type must be major, minor, or patch"}, status_code=400)
    entry = await publish_draft(version, title, entry_type)
    return JSONResponse({"entry": entry}, status_code=201)