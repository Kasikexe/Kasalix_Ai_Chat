"""Memory routes — mirrors backend/src/routes/memory.ts."""

from __future__ import annotations

import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..deps import user_id_from_request
from ..extractor import extract_memory_from_turn
from ..memory import clear_plugin_memories, get_memory, plugin_memory_id, update_memory
from ..storage import get_conversation

router = APIRouter()


@router.get("")
async def get_memory_route(request: Request) -> dict:
    user_id = user_id_from_request(request)
    return await get_memory(user_id)


@router.put("")
async def update_memory_route(request: Request) -> dict:
    user_id = user_id_from_request(request)
    try:
        body = await request.json()
        updates: dict = {}
        if isinstance(body.get("enabled"), bool):
            updates["enabled"] = body["enabled"]
        if isinstance(body.get("categories"), dict):
            updates["categories"] = body["categories"]
        if not updates:
            return JSONResponse({"error": "No valid updates provided"}, status_code=400)
        return await update_memory(user_id, updates)
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e) or "Failed to update memory"}, status_code=500)


@router.delete("")
async def reset_memory(request: Request) -> dict:
    user_id = user_id_from_request(request)
    reset = {"enabled": False, "categories": {}, "updatedAt": int(time.time() * 1000)}
    result = await update_memory(user_id, reset)
    await clear_plugin_memories(user_id)
    return result


async def _plugin_scope(request: Request, conversation_id: str) -> tuple[str, str] | None:
    owner_id = user_id_from_request(request)
    conversation = await get_conversation(conversation_id, owner_id)
    selection = conversation.get("pluginSelection") if conversation else None
    mode_id = conversation.get("pluginModeId") if conversation else None
    if not mode_id or not isinstance(selection, dict) or selection.get("memory") != "per-item" or not selection.get("id"):
        return None
    return owner_id, plugin_memory_id(owner_id, mode_id, selection["id"])


@router.get("/plugin")
async def get_plugin_memory(request: Request, conversationId: str) -> dict:
    scope = await _plugin_scope(request, conversationId)
    if not scope:
        return JSONResponse({"error": "No separate memory for this conversation"}, status_code=404)
    owner_id, memory_id = scope
    memory = await get_memory(memory_id)
    return {"enabled": bool((await get_memory(owner_id)).get("enabled")), "categories": memory.get("categories", {})}


@router.delete("/plugin")
async def reset_plugin_memory(request: Request, conversationId: str) -> dict:
    scope = await _plugin_scope(request, conversationId)
    if not scope:
        return JSONResponse({"error": "No separate memory for this conversation"}, status_code=404)
    await update_memory(scope[1], {"enabled": False, "categories": {}})
    return {"success": True}


@router.post("/extract")
async def extract_memory(request: Request) -> dict:
    try:
        user_id = user_id_from_request(request)
        body = await request.json()
        user_message = body.get("userMessage") or ""
        if not user_message:
            return JSONResponse({"error": "userMessage is required"}, status_code=400)
        # Fire and forget — only the user's message is analyzed
        import asyncio

        asyncio.create_task(extract_memory_from_turn(user_id, user_message))
        return {"status": "extraction started"}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e) or "Failed to start extraction"}, status_code=500)
