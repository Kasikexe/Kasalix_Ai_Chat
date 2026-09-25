"""Random Generator Tool — mirrors backend/src/services/tools/random.ts."""

from __future__ import annotations

import random
import re
import secrets
import uuid as uuid_lib
from typing import Any

from ..logger import info as log_info
from . import ToolContext, ToolDefinition, ToolParam, ToolResult, register_tool


def generate_password(length: int) -> str:
    chars = (
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        "abcdefghijklmnopqrstuvwxyz"
        "0123456789"
    )
    return "".join(secrets.choice(chars) for _ in range(length))


def roll_dice(sides: int, count: int) -> dict[str, Any]:
    rolls = [random.randint(1, sides) for _ in range(count)]
    total = sum(rolls)
    return {"rolls": rolls, "total": total, "average": round(total / count, 2) if count else 0}


def flip_coin(count: int) -> dict[str, Any]:
    results = ["heads" if random.random() < 0.5 else "tails" for _ in range(count)]
    heads = results.count("heads")
    return {"heads": heads, "tails": count - heads, "results": results}


DEFINITION = ToolDefinition(
    id="random",
    name="Random Generator",
    description="Generate random numbers, passwords, UUIDs, dice rolls, coin flips, and random picks",
    version="1.0.0",
    icon="\U0001f3b2",
    params=[
        ToolParam(name="action", type="string", description="What to generate: number, password, uuid, dice, coin, pick, float", required=True),
        ToolParam(name="min", type="number", description="Minimum value (for number/float)", required=False),
        ToolParam(name="max", type="number", description="Maximum value (for number/float)", required=False),
        ToolParam(name="length", type="number", description="Length (for password, default 16)", required=False),
        ToolParam(name="sides", type="number", description="Dice sides (for dice, default 6)", required=False),
        ToolParam(name="count", type="number", description="How many (for dice/coin, default 1)", required=False),
        ToolParam(name="items", type="string", description="Comma-separated items to pick from", required=False),
    ],
)


async def execute(params: dict[str, Any], ctx: ToolContext) -> ToolResult:
    action = str(params.get("action") or "").lower()
    mn = params.get("min") if isinstance(params.get("min"), (int, float)) else 1
    mx = params.get("max") if isinstance(params.get("max"), (int, float)) else 100
    length = int(params.get("length")) if isinstance(params.get("length"), (int, float)) else 16
    sides = int(params.get("sides")) if isinstance(params.get("sides"), (int, float)) else 6
    count = int(params.get("count")) if isinstance(params.get("count"), (int, float)) else 1

    if action in ("number", "int", "integer"):
        val = random.randint(int(mn), int(mx))
        return ToolResult(success=True, output=f"{val}", data={"value": val, "min": mn, "max": mx})
    if action in ("float", "decimal"):
        decimals = int(params.get("decimals")) if isinstance(params.get("decimals"), (int, float)) else 2
        val = round(random.uniform(float(mn), float(mx)), decimals)
        return ToolResult(success=True, output=f"{val}", data={"value": val, "min": mn, "max": mx, "decimals": decimals})
    if action in ("password", "pass", "pw"):
        pw = generate_password(length)
        return ToolResult(success=True, output=f"Generated password ({length} chars): `{pw}`", data={"password": pw, "length": length})
    if action in ("uuid", "guid"):
        uid = str(uuid_lib.uuid4())
        return ToolResult(success=True, output=f"{uid}", data={"uuid": uid})
    if action in ("dice", "dice roll", "roll"):
        result = roll_dice(sides, count)
        return ToolResult(
            success=True,
            output=f"Rolled {count}d{sides}: [{', '.join(str(r) for r in result['rolls'])}] = {result['total']} (avg: {result['average']})",
            data=result,
        )
    if action in ("coin", "coin flip", "flip"):
        result = flip_coin(count)
        pct = round(result["heads"] / count * 100) if count > 0 else 0
        return ToolResult(
            success=True,
            output=f"Flipped {count} coin(s): {result['heads']} heads, {result['tails']} tails ({pct}% heads)",
            data=result,
        )
    if action in ("pick", "choose"):
        items = str(params.get("items") or params.get("query") or "")
        if not items:
            return ToolResult(success=False, output="Please provide a comma-separated list of items to pick from.")
        options = [s.strip() for s in items.split(",") if s.strip()]
        if not options:
            return ToolResult(success=False, output="Please provide a comma-separated list of items to pick from.")
        picked = random.choice(options)
        return ToolResult(success=True, output=f"Picked: {picked}", data={"picked": picked, "from": items})

    return ToolResult(
        success=False,
        output=f'Unknown action "{action}". Available: number, float, password, uuid, dice, coin, pick',
    )


def detect(input_text: str) -> dict[str, Any] | None:
    """Auto-detect random generator intent from user input."""
    lower = input_text.lower()

    if re.search(r"roll\s+\d+d\d+|dice|d\d+\s*(?:roll|dice)", input_text, re.IGNORECASE):
        m = re.search(r"(\d+)\s*d\s*(\d+)", input_text, re.IGNORECASE)
        return {"confidence": 0.9, "params": {"action": "dice", "count": int(m.group(1)) if m else 1, "sides": int(m.group(2)) if m else 6}}

    if re.search(r"flip\s+(a\s+)?coin|coin\s+flip|toss", input_text, re.IGNORECASE):
        m = re.search(r"(\d+)", input_text)
        return {"confidence": 0.9, "params": {"action": "coin", "count": int(m.group(1)) if m else 1}}

    if re.search(r"generate\s+(a\s+)?password|random\s+password|create\s+(a\s+)?password", lower):
        m = re.search(r"(\d+)\s*(char|character)", lower)
        return {"confidence": 0.85, "params": {"action": "password", "length": int(m.group(1)) if m else 16}}

    if re.search(r"generate\s+(a\s+)?uuid|new\s+uuid|random\s+uuid", lower):
        return {"confidence": 0.9, "params": {"action": "uuid"}}

    if re.search(r"random\s+number|random\s+int|pick\s+(a\s+)?random", lower):
        m = re.search(r"(?:between|from|in)\s+(\d+)\s*(?:to|and|-)\s*(\d+)", lower)
        return {"confidence": 0.7, "params": {"action": "number", "min": int(m.group(1)) if m else 1, "max": int(m.group(2)) if m else 100}}

    if re.search(r"(?:pick|choose)\s+(?:a\s+)?random", lower) or re.search(r"randomly\s+(?:pick|choose)", lower):
        stripped = re.sub(r"pick|choose|randomly|random", "", input_text, flags=re.IGNORECASE)
        stripped = re.sub(r"\bfrom\b", "", stripped, flags=re.IGNORECASE).strip()
        return {"confidence": 0.6, "params": {"action": "pick", "items": stripped}}

    return None


def register_random_tool() -> None:
    register_tool(DEFINITION, execute)
    log_info("[tools] Random Generator registered")
