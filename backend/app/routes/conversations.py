"""Conversations CRUD — mirrors backend/src/routes/conversations.ts."""

from __future__ import annotations

import os
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
from ..utils import is_path_inside, is_protected_path

router = APIRouter()


@router.post("/{conv_id}/revert-file")
async def revert_file(conv_id: str, request: Request) -> dict:
    """Restore a journaled file only if it still matches the agent's version."""
    owner = user_id_from_request(request)
    conv = await get_conversation(conv_id, owner)
    if not conv:
        return JSONResponse({"error": "Not found"}, status_code=404)
    body = await request.json()
    path = body.get("filePath")
    root = conv.get("workspacePath")
    if not isinstance(path, str) or not isinstance(root, str):
        return JSONResponse({"error": "Invalid workspace or file path"}, status_code=400)
    path = os.path.abspath(path)
    if is_protected_path(root, path) or not await is_path_inside(root, path):
        return JSONResponse({"error": "Access denied"}, status_code=403)
    changes = conv.get("fileChanges") or []
    entry = next ( (item for item in changes if item.get("filePath") == path), None )
    if not entry or not entry.get("originalAvailable") or not entry.get("snapshotAvailable"):
        return JSONResponse({"error": "A complete undo snapshot is not available for this file"}, status_code=409)
    try:
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8", newline="") as stream:
                current = stream.read()
        else:
            current = None
        if current != entry.get("expectedContent"):
            return JSONResponse({"error": "The file changed since Koding last edited it. Review it before reverting."}, status_code=409)
        original = entry.get("originalContent")
        if original is None:
            if current is not None:
                os.remove(path)
        else:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8", newline="") as stream:
                stream.write(original)
        await update_conversation(conv_id, owner, {"fileChanges": [item for item in changes if item is not entry]})
        return {"success": True}
    except (OSError, UnicodeError):
        return JSONResponse({"error": "Could not restore file"}, status_code=500)


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
