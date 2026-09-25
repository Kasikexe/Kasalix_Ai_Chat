"""Tool Plugin System — mirrors backend/src/services/tools/index.ts.

Registry helpers shared by built-in tools and plugin tools. Log line
prefixes ([tools] ...) match the TS backend so the GUI log parser works.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from ..logger import info as log_info, warn as log_warn


@dataclass
class ToolParam:
    name: str
    type: str  # 'string' | 'number' | 'boolean'
    description: str
    required: bool = False


@dataclass
class ToolDefinition:
    id: str
    name: str
    description: str
    version: str
    icon: str
    params: list[ToolParam] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list)
    pluginId: str | None = None  # noqa: N815


@dataclass
class ToolContext:
    userInput: str = ""  # noqa: N815


@dataclass
class ToolResult:
    success: bool
    output: str
    data: dict[str, Any] | None = None


ToolExecutor = Callable[[dict[str, Any], ToolContext], Awaitable[ToolResult]]


@dataclass
class RegisteredTool:
    definition: ToolDefinition
    execute: ToolExecutor


_registry: dict[str, RegisteredTool] = {}


def register_tool(definition: ToolDefinition, execute: ToolExecutor) -> None:
    if definition.id in _registry:
        log_warn(f'[tools] Tool "{definition.id}" already registered — overwriting')
    _registry[definition.id] = RegisteredTool(definition, execute)
    log_info(f"[tools] Registered tool: {definition.name} ({definition.id})")


def unregister_tool(tool_id: str) -> bool:
    existed = _registry.pop(tool_id, None) is not None
    if existed:
        log_info(f"[tools] Unregistered tool: {tool_id}")
    return existed


def is_tool_registered(tool_id: str) -> bool:
    return tool_id in _registry


def get_all_tools() -> list[ToolDefinition]:
    return [t.definition for t in _registry.values()]


async def execute_tool(tool_id: str, params: dict[str, Any], ctx: ToolContext) -> ToolResult:
    tool = _registry.get(tool_id)
    if tool is None:
        return ToolResult(success=False, output=f'Tool "{tool_id}" is not available.')
    try:
        return await tool.execute(params, ctx)
    except Exception as err:  # noqa: BLE001
        return ToolResult(success=False, output=f'Tool "{tool_id}" error: {err}')


# ─── Math-expression + tool detection ─────────────────────

MATH_WORDS = re.compile(
    r"^(abs|floor|ceil|round|sqrt|cbrt|sin|cos|tan|asin|acos|atan|log|log2|log10|ln|exp|pow|max|min|pi|e)$",
    re.IGNORECASE,
)


def is_probably_math_expression(expr: str) -> bool:
    trimmed = expr.strip()
    if not trimmed or len(trimmed) > 120:
        return False
    words = [w for w in re.split(r"[\s,()+\-*/^%]+", trimmed) if w]
    for w in words:
        if re.match(r"^\d*\.?\d+$", w):
            continue
        if MATH_WORDS.match(w):
            continue
        return False
    return True


async def detect_tool(input_text: str) -> dict[str, Any] | None:
    """Detect which tool the user wants based on their input text."""
    from . import calculator, color, converter, datetime, hash, json, random, text as text_tool

    lower = input_text.lower()

    # ─── Calculator detection ─────────────────────────────
    has_math_evidence = bool(
        re.search(r"[\d]\s*[+\-*/^%]\s*[\d]", input_text)
        or re.match(r"^(calculate|compute|solve|evaluate)\s+", input_text.strip(), re.IGNORECASE)
    )
    has_mixed = bool(
        re.search(r"\d", input_text)
        and re.match(r"^(calculate|what (is|'s)|compute|solve|evaluate)", input_text.strip(), re.IGNORECASE)
    )
    if (has_math_evidence or has_mixed) and "http" not in lower and "convert" not in lower:
        result = calculator.detect(input_text)
        if result and is_probably_math_expression(str(result["params"].get("expression", ""))):
            return {"toolId": "calculator", "params": result["params"]}
        if has_math_evidence:
            expr = re.sub(r"^(calculate|what (?:is|'s)|compute|solve|evaluate)\s+", "", input_text, flags=re.IGNORECASE).strip()
            if is_probably_math_expression(expr):
                return {"toolId": "calculator", "params": {"expression": expr}}

    # ─── Converter detection ──────────────────────────────
    if (
        "convert" in lower
        or "conversion" in lower
        or "how many" in lower
        or "how much" in lower
        or ("to" in lower and any(u in lower for u in ("cm", "feet", "inch", "kg", "lb")))
        or "°f" in lower
        or "°c" in lower
        or "fahrenheit" in lower
        or "celsius" in lower
    ):
        result = converter.detect_conversion(input_text)
        if result:
            return {
                "toolId": "converter",
                "params": {"value": result["value"], "from": result["from"], "to": result["to"]},
            }

    # ─── Text Utilities detection ─────────────────────────
    is_text_op = (
        "word count" in lower
        or "character count" in lower
        or "uppercase" in lower
        or "lowercase" in lower
        or "title case" in lower
        or "camel case" in lower
        or "snake case" in lower
        or "reverse" in lower
        or "base64" in lower
        or "url encode" in lower
        or "url decode" in lower
        or "count words" in lower
        or "text stats" in lower
        or "analyze this text" in lower
        or ("count" in lower and any(k in lower for k in ("word", "letter", "character")))
    )
    if is_text_op:
        op = text_tool.detect_operation(input_text)
        return {"toolId": "text", "params": {"operation": op or "count", "query": input_text}}

    # ─── Color detection ──────────────────────────────────
    has_color = bool(re.search(r"#[0-9A-Fa-f]{3,6}\b|rgb\(|hsl\(|cmyk\(", input_text))
    color_names = [
        "red", "green", "blue", "white", "black", "purple", "orange", "yellow", "pink",
        "brown", "cyan", "magenta", "navy", "teal", "coral", "gold", "silver", "indigo",
        "violet", "tomato",
    ]
    is_color_request = has_color or (
        any(n in lower for n in color_names)
        and any(k in lower for k in ("color", "convert", "hex", "rgb", "hsl", "cmyk"))
    )
    if is_color_request and "convert" not in lower and "cm" not in lower and "inches" not in lower:
        return {"toolId": "color", "params": {"query": input_text}}

    # ─── Date/Time detection ──────────────────────────────
    if (
        re.search(r"what('s| is) (the )?(current )?(time|date|day)", input_text, re.IGNORECASE)
        or re.search(r"what time is it", input_text, re.IGNORECASE)
        or re.search(r"time\s+in\s+\w{2,7}\b", input_text, re.IGNORECASE)
        or re.search(r"(\d+)\s*(day|week|month|year|hour|minute)s?\s+(from|after|ago|now)", input_text, re.IGNORECASE)
        or re.search(r"how long.*(between|from|until)", input_text, re.IGNORECASE)
    ):
        result = datetime.detect(input_text)
        if result:
            return {"toolId": "datetime", "params": result["params"]}
        if re.search(r"what\s+(time|date|day)", input_text, re.IGNORECASE):
            return {"toolId": "datetime", "params": {"action": "now"}}

    # ─── Random detection ─────────────────────────────────
    if (
        re.search(r"roll\s+d\d+|dice|coin\s+flip|flip\s+(a\s+)?coin", input_text, re.IGNORECASE)
        or re.search(r"generate\s+(a\s+)?password|random\s+password", lower)
        or re.search(r"generate\s+(a\s+)?uuid", lower)
        or re.search(r"random\s+(number|int)", lower)
        or re.search(r"pick\s+(a\s+)?random\s+(from|of)", lower)
    ):
        result = random.detect(input_text)
        if result:
            return {"toolId": "random", "params": result["params"]}
        return {"toolId": "random", "params": {"action": "number", "query": input_text}}

    # ─── JSON detection ───────────────────────────────────
    if "json" in lower and any(
        k in lower for k in ("format", "validate", "minify", "prettify", "compress", "keys", "analyze", "structure")
    ):
        result = json.detect(input_text)
        if result:
            return {"toolId": "json", "params": result["params"]}
        return {"toolId": "json", "params": {"action": "format", "query": input_text}}

    # ─── Hash detection ───────────────────────────────────
    hash_keywords = ["md5", "sha1", "sha256", "sha512", "sha3", "blake2", "hmac"]
    wants_hash = any(kw in lower for kw in hash_keywords) and any(
        k in lower for k in ("hash", "generate", "compute", "verify", "check")
    )
    if wants_hash:
        result = hash.detect(input_text)
        if result:
            return {"toolId": "hash", "params": result["params"]}
        return {"toolId": "hash", "params": {"action": "all", "query": input_text}}

    # ─── Plugin tools detection (last) ────────────────────
    for tool in list(_registry.values()):
        defn = tool.definition
        if not defn.pluginId or not defn.keywords:
            continue
        for kw in defn.keywords:
            if not kw:
                continue
            escaped = re.escape(kw)
            if re.search(rf"\b{escaped}\b", input_text, re.IGNORECASE):
                return {"toolId": defn.id, "params": {"query": input_text}}

    return None
