"""JSON Utilities Tool — mirrors backend/src/services/tools/json.ts."""

from __future__ import annotations

import json
import re
from typing import Any

from ..logger import info as log_info
from . import ToolContext, ToolDefinition, ToolParam, ToolResult, register_tool


def _extract_keys(parsed: Any) -> list[str]:
    keys: set[str] = set()

    def walk(obj: Any, prefix: str) -> None:
        if isinstance(obj, dict):
            for key, value in obj.items():
                full_key = f"{prefix}.{key}" if prefix else str(key)
                keys.add(full_key)
                walk(value, full_key)
        elif isinstance(obj, list):
            for item in obj:
                walk(item, prefix)

    walk(parsed, "")
    return sorted(keys)


def _count_elements(parsed: Any) -> dict[str, int]:
    stats = {"totalKeys": 0, "nestingLevel": 0, "arrayCount": 0, "objectCount": 0}

    def walk(obj: Any, depth: int) -> None:
        stats["nestingLevel"] = max(stats["nestingLevel"], depth)
        if isinstance(obj, list):
            stats["arrayCount"] += 1
            for item in obj:
                walk(item, depth + 1)
        elif isinstance(obj, dict):
            stats["objectCount"] += 1
            stats["totalKeys"] += len(obj)
            for value in obj.values():
                walk(value, depth + 1)

    walk(parsed, 0)
    return stats


DEFINITION = ToolDefinition(
    id="json",
    name="JSON Utilities",
    description="Format, validate, minify, and analyze JSON data — extract keys, count elements, detect issues",
    version="1.0.0",
    icon="\U0001f4cb",
    params=[
        ToolParam(name="action", type="string", description="Action: format, validate, minify, keys, analyze", required=True),
        ToolParam(name="data", type="string", description="JSON data to process", required=True),
        ToolParam(name="indent", type="number", description="Indentation size (for format, default 2)", required=False),
    ],
)


def _extract_json_str(raw: str) -> str:
    json_str = raw
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
    if m:
        json_str = m.group(1).strip()
    if not json_str.startswith("{") and not json_str.startswith("["):
        bm = re.search(r"(\{[\s\S]*\}|\[[\s\S]*\])", raw)
        if bm:
            json_str = bm.group(1).strip()
    return json_str


async def execute(params: dict[str, Any], ctx: ToolContext) -> ToolResult:
    action = str(params.get("action") or "format").lower()
    raw = str(params.get("data") or params.get("query") or ctx.userInput or "")
    indent = int(params.get("indent")) if isinstance(params.get("indent"), (int, float)) else 2

    json_str = _extract_json_str(raw)
    if not json_str.strip():
        return ToolResult(success=False, output="Please provide JSON data to process.")

    if action in ("format", "prettify", "beautify"):
        try:
            formatted = json.dumps(json.loads(json_str), indent=indent)
            return ToolResult(success=True, output=f"```json\n{formatted}\n```", data={"result": formatted})
        except json.JSONDecodeError as e:
            return ToolResult(success=False, output=f"Invalid JSON: {e}")

    if action in ("minify", "compress"):
        try:
            minified = json.dumps(json.loads(json_str), separators=(",", ":"))
            return ToolResult(
                success=True,
                output=minified,
                data={"result": minified, "originalSize": len(json_str), "minifiedSize": len(minified)},
            )
        except json.JSONDecodeError as e:
            return ToolResult(success=False, output=f"Invalid JSON: {e}")

    if action in ("validate", "check", "valid"):
        try:
            parsed = json.loads(json_str)
            jtype = "array" if isinstance(parsed, list) else type(parsed).__name__
            return ToolResult(success=True, output=f"\u2705 Valid JSON (type: {jtype})", data={"valid": True, "type": jtype})
        except json.JSONDecodeError as e:
            return ToolResult(success=False, output=f"\u274c Invalid JSON: {e}", data={"valid": False, "error": str(e)})

    if action in ("keys", "schema", "structure"):
        try:
            parsed = json.loads(json_str)
            keys = _extract_keys(parsed)
            info = _count_elements(parsed)
            preview = ", ".join(keys[:30]) + ("..." if len(keys) > 30 else "")
            return ToolResult(
                success=True,
                output=(
                    f"\U0001f4ca JSON Structure:\n\u2022 Keys ({len(keys)}): {preview}"
                    f"\n\u2022 Nesting depth: {info['nestingLevel']}"
                    f"\n\u2022 Objects: {info['objectCount']}, Arrays: {info['arrayCount']}"
                    f"\n\u2022 Raw size: {len(json_str)} bytes"
                ),
                data={"keys": keys, **info},
            )
        except json.JSONDecodeError as e:
            return ToolResult(success=False, output=f"Invalid JSON: {e}")

    if action in ("analyze", "stats", "info"):
        try:
            parsed = json.loads(json_str)
        except json.JSONDecodeError as e:
            return ToolResult(success=False, output=f"\u274c Invalid JSON: {e}")
        info = _count_elements(parsed)
        keys = _extract_keys(parsed)
        size = len(json_str)
        size_note = f" ({size / 1024:.1f} KB)" if size > 1024 else ""
        return ToolResult(
            success=True,
            output=(
                f"\U0001f4ca JSON Analysis:\n\u2022 Valid: \u2705 (object)\n\u2022 Keys: {info['totalKeys']}"
                f"\n\u2022 Nesting depth: {info['nestingLevel']}\n\u2022 Objects: {info['objectCount']}"
                f"\n\u2022 Arrays: {info['arrayCount']}\n\u2022 Size: {size} bytes{size_note}"
            ),
            data={**info, "keys": keys, "valid": True},
        )

    return ToolResult(success=False, output=f'Unknown action "{action}". Available: format, validate, minify, keys, analyze')


def detect(input_text: str) -> dict[str, Any] | None:
    lower = input_text.lower()
    has_json = "{" in input_text or "[" in input_text
    if not has_json and "json" not in lower:
        return None
    if any(k in lower for k in ("format", "prettify", "beautify")):
        return {"confidence": 0.8, "params": {"action": "format", "query": input_text}}
    if "minify" in lower or "compress" in lower:
        return {"confidence": 0.8, "params": {"action": "minify", "query": input_text}}
    if any(k in lower for k in ("validate", "is valid", "check if")):
        return {"confidence": 0.8, "params": {"action": "validate", "query": input_text}}
    if any(k in lower for k in ("keys", "structure", "schema")):
        return {"confidence": 0.7, "params": {"action": "keys", "query": input_text}}
    if any(k in lower for k in ("analyze", "stats", "info about")):
        return {"confidence": 0.7, "params": {"action": "analyze", "query": input_text}}
    return None


def register_json_tool() -> None:
    register_tool(DEFINITION, execute)
    log_info("[tools] JSON Utilities registered")
