"""Settings routes — mirrors backend/src/routes/settings.ts."""

from __future__ import annotations

import time

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from ..deps import admin_authenticated
from ..logger import error as log_error, info as log_info, warn as log_warn
from ..ollama_client import invalidate_num_ctx_cache
from ..settings_store import (
    get_cloud_settings,
    invalidate_settings_cache,
    load_settings,
    save_settings,
)

router = APIRouter()


@router.get("")
async def get_settings() -> dict:
    return await load_settings()


@router.get("/auth")
async def check_auth(request: Request) -> dict:
    return {"authenticated": admin_authenticated(request)}


@router.post("/auth")
async def login() -> JSONResponse:
    """Legacy no-op kept for older clients: the settings password was removed,
    so every admin request is allowed and the auth check always succeeds."""
    response = JSONResponse({"authenticated": True})
    response.set_cookie(
        "settings_auth", "1", httponly=True, path="/", samesite="strict", max_age=86400
    )
    return response


@router.put("")
async def update_settings(request: Request) -> dict:
    if not admin_authenticated(request):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    try:
        body = await request.json()
        existing = await load_settings()
        next_settings = {**existing}
        for key in (
            "hiddenModels",
            "modelAssignments",
            "cloudMode",
            "cloudApiKey",
            "cloudEndpoint",
            "cloudModelAssignments",
            "kvCacheOffload",
            "kvCacheType",
            "defaultNumCtx",
            "ollamaNumParallel",
            "ollamaMaxLoadedModels",
            "ollamaKeepAlive",
        ):
            if key in body:
                next_settings[key] = body[key]
        next_settings["updatedAt"] = int(time.time() * 1000)
        await save_settings(next_settings)
        # Drop the in-memory cache immediately so the pipeline/assignments
        # pick up the new values on the NEXT request (a 2s TTL is not enough:
        # save-then-chat within 2s served the OLD model assignment).
        invalidate_settings_cache()
        if "defaultNumCtx" in body:
            invalidate_num_ctx_cache()
        return next_settings
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e) or "Failed to save"}, status_code=500)


@router.post("/reset")
async def reset_settings(request: Request) -> dict:
    if not admin_authenticated(request):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    from ..settings_store import DEFAULT_SETTINGS

    data = {**DEFAULT_SETTINGS, "modelAssignments": {}, "updatedAt": int(time.time() * 1000)}
    await save_settings(data)
    invalidate_settings_cache()
    return data


@router.get("/cloud-models")
async def get_cloud_models(request: Request) -> dict:
    if not admin_authenticated(request):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    try:
        import httpx

        cloud = await get_cloud_settings()
        if not cloud.get("cloudEndpoint"):
            return {"models": [], "error": "No cloud endpoint configured"}
        if not cloud.get("cloudApiKey"):
            return {"models": [], "error": "No API key configured"}
        base = cloud["cloudEndpoint"].rstrip("/")
        models: list[dict] = []
        last_error = ""
        headers = {
            "Authorization": f"Bearer {cloud['cloudApiKey']}",
            "Content-Type": "application/json",
        }

        # Attempt 1: /v1/models (OpenAI-compatible — works on ollama.com cloud)
        try:
            url = f"{base}/v1/models"
            log_info(f"[settings] Fetching cloud models via /v1/models: {url}")
            async with httpx.AsyncClient(timeout=10) as client:
                res = await client.get(url, headers=headers)
            if res.status_code < 400:
                data = res.json()
                if isinstance(data.get("data"), list):
                    models = [
                        {"id": m.get("id") or m.get("name", ""), "name": m.get("id") or m.get("name", ""), "owned_by": m.get("owned_by") or "ollama"}
                        for m in data["data"]
                    ]
                elif isinstance(data.get("models"), list):
                    models = [
                        {"id": m.get("name") or m.get("id") or m.get("model", ""), "name": m.get("name") or m.get("id") or m.get("model", ""), "owned_by": (m.get("details") or {}).get("family") or "ollama"}
                        for m in data["models"]
                    ]
                log_info(f"[settings] /v1/models returned {len(models)} models")
            else:
                last_error = f"/v1/models returned {res.status_code}"
                log_warn(f"[settings] {last_error}")
        except Exception as e:  # noqa: BLE001
            last_error = str(e)
            log_error("[settings] /v1/models fetch failed:", last_error)

        # Attempt 2: /api/tags fallback
        if not models:
            try:
                url = f"{base}/api/tags"
                async with httpx.AsyncClient(timeout=10) as client:
                    res = await client.get(url, headers=headers)
                if res.status_code < 400:
                    data = res.json()
                    if isinstance(data.get("models"), list):
                        models = [
                            {"id": m.get("name") or m.get("model", ""), "name": m.get("name") or m.get("model", ""), "owned_by": (m.get("details") or {}).get("family") or "ollama"}
                            for m in data["models"]
                        ]
                else:
                    last_error = f"/api/tags returned {res.status_code}"
            except Exception as e:  # noqa: BLE001
                last_error = str(e)

        if not models:
            return {"models": [], "error": last_error or "No models found"}
        result = sorted(
            [{"id": m["id"], "name": m.get("name") or m["id"], "owned_by": m.get("owned_by") or "ollama"} for m in models],
            key=lambda m: m["id"],
        )
        return {"models": result}
    except Exception as e:  # noqa: BLE001
        return {"models": [], "error": str(e)}