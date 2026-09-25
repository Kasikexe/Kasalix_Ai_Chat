"""Cloud usage tracking routes — mirrors backend/src/routes/cloud-usage.ts."""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _js_num(v: Any) -> Any:
    """Match JS JSON.stringify: whole floats serialize as integers (4.00 → 4)."""
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def _js_iso(dt: datetime | None = None) -> str:
    """Format like JS Date.toISOString(): UTC, milliseconds, Z suffix.

    The TS backend emits lastReset this way and the frontend parses it, so the
    Python port must match exactly (no microseconds, no +00:00 offset).
    """
    d = (dt or datetime.now(timezone.utc)).astimezone(timezone.utc)
    return d.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..config import get_data_dir

router = APIRouter()

USAGE_FILE = Path(get_data_dir()) / "cloud_usage.json"

# ─── Model Pricing Table (USD per 1M tokens) ──────────────────────
DEFAULT_PRICING: dict[str, dict[str, float]] = {
    "gpt-4o": {"input": 2.50, "output": 10.00},
    "gpt-4o-mini": {"input": 0.15, "output": 0.60},
    "gpt-4-turbo": {"input": 10.00, "output": 30.00},
    "gpt-4": {"input": 30.00, "output": 60.00},
    "gpt-3.5-turbo": {"input": 0.50, "output": 1.50},
    "o1": {"input": 15.00, "output": 60.00},
    "o1-mini": {"input": 3.00, "output": 12.00},
    "o3-mini": {"input": 1.10, "output": 4.40},
    "claude-sonnet-4-20250514": {"input": 3.00, "output": 15.00},
    "claude-3-5-sonnet-20241022": {"input": 3.00, "output": 15.00},
    "claude-3-5-haiku-20241022": {"input": 0.80, "output": 4.00},
    "claude-3-opus-20240229": {"input": 15.00, "output": 75.00},
    "claude-3-haiku-20240307": {"input": 0.25, "output": 1.25},
    "gemini-2.0-flash": {"input": 0.10, "output": 0.40},
    "gemini-1.5-pro": {"input": 1.25, "output": 5.00},
    "gemini-1.5-flash": {"input": 0.075, "output": 0.30},
    "deepseek-chat": {"input": 0.14, "output": 0.28},
    "deepseek-coder": {"input": 0.14, "output": 0.28},
    "deepseek-reasoner": {"input": 0.55, "output": 2.19},
}


def _get_month_start() -> str:
    now = datetime.now()
    return f"{now.year}-{now.month:02d}-01"


def _is_new_month(usage: dict[str, Any]) -> bool:
    return usage.get("periodStart") != _get_month_start()


def _default_usage() -> dict[str, Any]:
    return {
        "totalRequests": 0,
        "totalTokens": 0,
        "byModel": {},
        "tokensByModel": {},
        "monthlyLimit": 0,
        "tokenBudget": 0,
        "customPricing": {},
        "lastReset": _js_iso(),
        "periodStart": _get_month_start(),
    }


async def load_usage() -> dict[str, Any]:
    try:
        parsed = json.loads(USAGE_FILE.read_text(encoding="utf-8"))
        usage = {**_default_usage(), **parsed}
        if _is_new_month(usage):
            usage["totalRequests"] = 0
            usage["totalTokens"] = 0
            usage["byModel"] = {}
            usage["tokensByModel"] = {}
            usage["periodStart"] = _get_month_start()
            usage["lastReset"] = _js_iso()
            await save_usage(usage)
        return usage
    except (OSError, json.JSONDecodeError):
        return _default_usage()


async def save_usage(usage: dict[str, Any]) -> None:
    USAGE_FILE.parent.mkdir(parents=True, exist_ok=True)
    USAGE_FILE.write_text(json.dumps(usage, indent=2), encoding="utf-8")


def _get_model_pricing(model: str, custom_pricing: dict[str, dict[str, float]]) -> dict[str, float] | None:
    if model in custom_pricing:
        return custom_pricing[model]
    if model in DEFAULT_PRICING:
        return DEFAULT_PRICING[model]
    lower = model.lower()
    for key, price in DEFAULT_PRICING.items():
        if key in lower:
            return price
    for key, price in custom_pricing.items():
        if key.lower() in lower:
            return price
    return None


def _calculate_model_cost(model: str, input_tokens: int, output_tokens: int, custom_pricing: dict) -> float:
    pricing = _get_model_pricing(model, custom_pricing)
    if not pricing:
        return 0.0
    return (input_tokens / 1_000_000) * pricing["input"] + (output_tokens / 1_000_000) * pricing["output"]


@router.get("")
async def get_usage() -> dict:
    usage = await load_usage()
    breakdown: list[dict[str, Any]] = []
    total_estimated_cost = 0.0
    for model, tokens in usage.get("tokensByModel", {}).items():
        input_tokens = tokens.get("input") or 0
        output_tokens = tokens.get("output") or 0
        pricing = _get_model_pricing(model, usage.get("customPricing", {}))
        input_cost = (input_tokens / 1_000_000) * pricing["input"] if pricing else 0.0
        output_cost = (output_tokens / 1_000_000) * pricing["output"] if pricing else 0.0
        total_cost = input_cost + output_cost
        total_estimated_cost += total_cost
        breakdown.append(
            {
                "model": model,
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "inputCost": input_cost,
                "outputCost": output_cost,
                "totalCost": total_cost,
            }
        )
    breakdown.sort(key=lambda b: b["totalCost"], reverse=True)
    pricing_table: dict[str, Any] = {}
    for model, price in DEFAULT_PRICING.items():
        pricing_table[model] = {"input": _js_num(price["input"]), "output": _js_num(price["output"]), "source": "built-in"}
    for model, price in usage.get("customPricing", {}).items():
        pricing_table[model] = {"input": _js_num(price.get("input")), "output": _js_num(price.get("output")), "source": "custom"}
    return {
        **usage,
        "costBreakdown": breakdown,
        "totalEstimatedCost": _js_num(total_estimated_cost),
        "pricingTable": pricing_table,
    }


@router.post("/increment")
async def increment(request: Request) -> dict:
    try:
        body = await request.json()
        model = body.get("model")
        tokens = body.get("tokens")
        input_tokens = body.get("inputTokens")
        output_tokens = body.get("outputTokens")
        usage = await load_usage()
        usage["totalRequests"] += 1
        token_delta = tokens or 0
        usage["totalTokens"] += token_delta
        if model:
            usage.setdefault("byModel", {})
            usage["byModel"][model] = usage["byModel"].get(model, 0) + 1
            usage.setdefault("tokensByModel", {})
            usage["tokensByModel"].setdefault(model, {"input": 0, "output": 0})
            if input_tokens is not None or output_tokens is not None:
                usage["tokensByModel"][model]["input"] += input_tokens or 0
                usage["tokensByModel"][model]["output"] += output_tokens or 0
            elif token_delta > 0:
                usage["tokensByModel"][model]["input"] += round(token_delta * 0.6)
                usage["tokensByModel"][model]["output"] += round(token_delta * 0.4)
        await save_usage(usage)
        return usage
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e) or "Failed to increment"}, status_code=500)


@router.put("/limit")
async def update_limit(request: Request) -> dict:
    try:
        body = await request.json()
        usage = await load_usage()
        if body.get("monthlyLimit") is not None:
            usage["monthlyLimit"] = float(body["monthlyLimit"]) or 0
        if body.get("tokenBudget") is not None:
            usage["tokenBudget"] = float(body["tokenBudget"]) or 0
        await save_usage(usage)
        return usage
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e) or "Failed to update limit"}, status_code=500)


@router.put("/pricing")
async def update_pricing(request: Request) -> dict:
    try:
        body = await request.json()
        model = body.get("model")
        if not model:
            return JSONResponse({"error": "model is required"}, status_code=400)
        usage = await load_usage()
        usage.setdefault("customPricing", {})
        if body.get("input") is not None and body.get("output") is not None:
            usage["customPricing"][model] = {"input": body["input"], "output": body["output"]}
        else:
            usage["customPricing"].pop(model, None)
        await save_usage(usage)
        return {"customPricing": usage["customPricing"]}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e) or "Failed to update pricing"}, status_code=500)


@router.post("/reset")
async def reset_usage() -> dict:
    usage = await load_usage()
    usage["totalRequests"] = 0
    usage["totalTokens"] = 0
    usage["byModel"] = {}
    usage["tokensByModel"] = {}
    usage["lastReset"] = _js_iso()
    usage["periodStart"] = _get_month_start()
    await save_usage(usage)
    return usage