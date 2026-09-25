"""Conversations CRUD — mirrors backend/src/routes/conversations.ts."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..deps import user_id_from_request
from ..storage import (
    add_message,
    create_conversation,
    delete_conversation,
    delete_message,
    get_all_conversations,
    get_conversation,
    update_conversation,
)
from ..models import make_message

router = APIRouter()


@router.get("")
async def list_conversations(request: Request) -> dict:
    owner_id = user_id_from_request(request)
    convs = await get_all_conversations(owner_id)
    return {"conversations": convs}


@router.get("/{conv_id}")
async def get_one(conv_id: str, request: Request) -> dict:
    owner_id = user_id_from_request(request)
    conv = await get_conversation(conv_id, owner_id)
    if not conv:
        return JSONResponse({"error": "Not found"}, status_code=404)
    return {"conversation": conv}


@router.post("")
async def create_one(request: Request) -> dict:
    try:
        owner_id = user_id_from_request(request)
        body = await request.json()
        model = body.get("model")
        if not model:
            return JSONResponse({"error": "model is required"}, status_code=400)
        conv = await create_conversation(
            model,
            owner_id,
            body.get("title"),
            body.get("mode"),
            body.get("workspacePath"),
        )
        return {"conversation": conv}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e) or "Failed to create"}, status_code=500)


@router.put("/{conv_id}")
async def update_one(conv_id: str, request: Request) -> dict:
    try:
        owner_id = user_id_from_request(request)
        updates = await request.json()
        conv = await update_conversation(conv_id, owner_id, updates)
        if not conv:
            return JSONResponse({"error": "Not found"}, status_code=404)
        return {"conversation": conv}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e) or "Failed to update"}, status_code=500)


@router.delete("/{conv_id}")
async def delete_one(conv_id: str, request: Request) -> dict:
    owner_id = user_id_from_request(request)
    ok = await delete_conversation(conv_id, owner_id)
    if not ok:
        return JSONResponse({"error": "Not found"}, status_code=404)
    return {"success": True}


@router.post("/{conv_id}/messages")
async def add_one_message(conv_id: str, request: Request) -> dict:
    try:
        owner_id = user_id_from_request(request)
        body = await request.json()
        role = body.get("role")
        content = body.get("content")
        if not role or not content:
            return JSONResponse({"error": "role and content are required"}, status_code=400)
        conv = await add_message(conv_id, owner_id, make_message(role, content, timestamp=body.get("timestamp")))
        if not conv:
            return JSONResponse({"error": "Conversation not found"}, status_code=404)
        return {"conversation": conv}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e) or "Failed to add message"}, status_code=500)


@router.delete("/{conv_id}/messages/{index}")
async def delete_one_message(conv_id: str, index: str, request: Request) -> dict:
    try:
        owner_id = user_id_from_request(request)
        try:
            msg_index = int(index)
        except ValueError:
            return JSONResponse({"error": "Invalid message index"}, status_code=400)
        if msg_index < 0:
            return JSONResponse({"error": "Invalid message index"}, status_code=400)
        conv = await delete_message(conv_id, owner_id, msg_index)
        if not conv:
            return JSONResponse({"error": "Conversation or message not found"}, status_code=404)
        return {"conversation": conv}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e) or "Failed to delete message"}, status_code=500)