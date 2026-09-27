"""ALC routes — the Advanced Learning Cycle's own surface for the client.

The cycle itself runs inside the chat pipeline; these endpoints exist so the
Settings UI can show and maintain what ALC reads from outside the conversation:

- the documentation index (what is indexed, how big it is, rebuild on demand),
- the project knowledge store of a workspace (what earlier cycles remembered).

Both are read-only views plus one explicit build action — nothing here changes
how a conversation behaves. Design: docs/ALC_DESIGN.md §5.
"""

from __future__ import annotations

import asyncio
import os

from fastapi import APIRouter, Request

from ..alc import docs, knowledge
from ..deps import user_id_from_request
from ..logger import error as log_error, info as log_info
from ..settings_store import get_alc_settings

router = APIRouter()


async def _roots() -> tuple[list[str], list[str]]:
    """Configured documentation folders, split into existing and unusable."""
    settings = await get_alc_settings()
    configured = [str(path) for path in settings.get("alcDocsPaths") or []]
    roots = docs.resolve_roots(configured)
    resolved = {os.path.realpath(path) for path in roots}
    missing = [
        path
        for path in configured
        if path.strip() and os.path.realpath(os.path.expanduser(path.strip())) not in resolved
    ]
    return roots, missing


@router.get("/index")
async def get_index() -> dict:
    """What the documentation index holds right now (cheap — no walk)."""
    roots, missing = await _roots()
    return {
        "configured": len(missing) + len(roots),
        "roots": roots,
        "missing": missing,
        "fts5": docs.fts5_available(),
        "indexPath": str(docs.index_path()),
        "status": docs.index_status(),
    }


@router.post("/index")
async def rebuild_index(request: Request) -> dict:
    """Force a full rebuild of the documentation index (blocking work in a thread).

    Incremental refreshes happen automatically during a cycle; this is the
    button for "I just added the docs, index them now".
    """
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 — no body is fine
        body = {}
    if not isinstance(body, dict):
        body = {}
    force = body.get("force") is not False

    roots, _missing = await _roots()
    if not roots:
        return {
            "ok": False,
            "error": "No usable documentation folders are configured.",
            "roots": [],
            "status": docs.index_status(),
        }
    log_info(f"[alc] Rebuilding the documentation index over {len(roots)} folder(s) (force={force})")
    stats = await asyncio.to_thread(docs.build_index, roots, force=force)
    return {"ok": True, "roots": roots, "stats": stats, "status": docs.index_status()}


@router.delete("/index")
async def clear_index() -> dict:
    """Forget every indexed document (the index is a cache — it can be rebuilt)."""
    ok = await asyncio.to_thread(docs.clear_index)
    return {"ok": ok, "status": await asyncio.to_thread(docs.index_status)}


@router.get("/knowledge")
async def get_knowledge(request: Request, workspace: str = "") -> dict:
    """What ALC has remembered for a workspace (`ALC/knowledge`)."""
    path = (workspace or request.query_params.get("workspacePath") or "").strip()
    try:
        workspace_path = os.path.realpath(os.path.expanduser(path)) if path else ""
    except (OSError, ValueError):
        workspace_path = ""
    if not workspace_path or not os.path.isdir(workspace_path):
        return {
            "workspace": workspace_path,
            "available": False,
            "userId": user_id_from_request(request),
            "topics": [],
            "stats": {},
        }
    try:
        stats = await asyncio.to_thread(knowledge.stats, workspace_path)
        topics = await asyncio.to_thread(knowledge.topics, workspace_path)
    except Exception as e:  # noqa: BLE001 — never break Settings over a bad workspace
        log_error("[alc] Could not read the knowledge store:", e)
        return {"workspace": workspace_path, "available": True, "topics": [], "stats": {}, "error": str(e)}
    return {"workspace": workspace_path, "available": True, "topics": topics, "stats": stats}
