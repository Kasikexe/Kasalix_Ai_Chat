"""GET /api/models — mirrors backend/src/routes/models.ts."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..capabilities import list_tool_use_tests, supports_thinking_fast, test_model_tool_use
from ..deps import session_authenticated
from ..model_assignments import MODEL_USAGE_DESCRIPTIONS, get_resolved_model
from ..ollama_client import get_models
from ..settings_store import get_cloud_settings

router = APIRouter()


@router.get("/tool-tests")
async def tool_tests(request: Request) -> dict:
    if not session_authenticated(request):
        return JSONResponse({"error": "Authentication required"}, status_code=401)
    return {"tests": await list_tool_use_tests()}


@router.post("/tool-test")
async def tool_test(request: Request) -> dict:
    if not session_authenticated(request):
        return JSONResponse({"error": "Authentication required"}, status_code=401)
    try:
        body = await request.json()
    except ValueError:
        return JSONResponse({"error": "Invalid request"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"error": "Invalid request"}, status_code=400)
    selected = body.get("model")
    if selected is not None and (not isinstance(selected, str) or not selected.strip() or len(selected) > 200):
        return JSONResponse({"error": "Invalid model name"}, status_code=400)
    resolved = await get_resolved_model("code")
    model = selected.strip() if selected else resolved.get("model", "")
    if not model:
        return JSONResponse({"error": "No coding model is assigned"}, status_code=400)
    cloud = await get_cloud_settings()
    use_cloud = cloud["cloudMode"] != "local" and bool(cloud["cloudApiKey"] and cloud["cloudEndpoint"])
    if cloud["cloudMode"] == "cloud" and not use_cloud:
        return JSONResponse({"error": "Cloud mode requires an endpoint and API key"}, status_code=400)
    result = await test_model_tool_use(model, cloud["cloudEndpoint"] if use_cloud else None,
                                       cloud["cloudApiKey"] if use_cloud else None, "cloud" if use_cloud else "local")
    return {"test": result}


@router.get("/usage-map")
async def model_usage_map() -> dict:
    """Per-category explanation of where each assigned model is used —
    consumed by the server GUI's "Where it's used" expanders."""
    return {"usage": MODEL_USAGE_DESCRIPTIONS}


@router.get("")
async def list_models() -> dict:
    try:
        models = await get_models()
        enriched = []
        for m in models:
            name = m.get("name") or m.get("model") or ""
            item = dict(m)
            try:
                # Fast path: cached value or name-based fallback — never a
                # blocking probe (probes made /api/models take 5+ seconds and
                # the client looked frozen while polling it).
                item["supportsThinking"] = await supports_thinking_fast(name)
            except Exception:  # noqa: BLE001
                item["supportsThinking"] = False
            enriched.append(item)
        return {"models": enriched}
    except Exception as e:  # noqa: BLE001
        from fastapi.responses import JSONResponse

        return JSONResponse({"error": str(e) or "Failed to fetch models"}, status_code=502)
