"""GET /api/models — mirrors backend/src/routes/models.ts."""

from __future__ import annotations

from fastapi import APIRouter

from ..capabilities import supports_thinking_fast
from ..model_assignments import MODEL_USAGE_DESCRIPTIONS
from ..ollama_client import get_models

router = APIRouter()


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