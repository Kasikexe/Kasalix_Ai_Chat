"""Color Converter Tool — mirrors backend/src/services/tools/color.ts."""

from __future__ import annotations

import colorsys
import re
from typing import Any

from ..logger import info as log_info
from . import ToolContext, ToolDefinition, ToolParam, ToolResult, register_tool

NAMED_COLORS: dict[str, str] = {
    "red": "#FF0000", "green": "#008000", "blue": "#0000FF",
    "white": "#FFFFFF", "black": "#000000", "gray": "#808080",
    "yellow": "#FFFF00", "orange": "#FFA500", "purple": "#800080",
    "pink": "#FFC0CB", "brown": "#A52A2A", "cyan": "#00FFFF",
    "magenta": "#FF00FF", "lime": "#00FF00", "navy": "#000080",
    "teal": "#008080", "maroon": "#800000", "olive": "#808000",
    "coral": "#FF7F50", "gold": "#FFD700", "silver": "#C0C0C0",
    "indigo": "#4B0082", "violet": "#EE82EE", "tomato": "#FF6347",
    "salmon": "#FA8072", "wheat": "#F5DEB3", "skyblue": "#87CEEB",
    "hotpink": "#FF69B4", "crimson": "#DC143C", "chocolate": "#D2691E",
}


def hex_to_rgb(hex_str: str) -> tuple[int, int, int] | None:
    h = re.sub(r"^#", "", hex_str)
    if len(h) == 3:
        h = "".join(c + c for c in h)
    if len(h) != 6:
        return None
    try:
        num = int(h, 16)
    except ValueError:
        return None
    return ((num >> 16) & 255, (num >> 8) & 255, num & 255)


def rgb_to_hex(r: int, g: int, b: int) -> str:
    to_hex = lambda n: f"{max(0, min(255, round(n))):02x}"  # noqa: E731
    return f"#{to_hex(r)}{to_hex(g)}{to_hex(b)}".upper()


def rgb_to_hsl(r: int, g: int, b: int) -> dict[str, int]:
    h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
    return {"h": round(h * 360), "s": round(s * 100), "l": round(l * 100)}


def hsl_to_rgb(h: int, s: int, l: int) -> tuple[int, int, int]:
    r, g, b = colorsys.hls_to_rgb(
        (((h % 360) + 360) % 360) / 360,
        max(0.0, min(100.0, l)) / 100,
        max(0.0, min(100.0, s)) / 100,
    )
    return (round(r * 255), round(g * 255), round(b * 255))


def rgb_to_cmyk(r: int, g: int, b: int) -> dict[str, int]:
    rr, gg, bb = r / 255, g / 255, b / 255
    k = 1 - max(rr, gg, bb)
    if k == 1:
        return {"c": 0, "m": 0, "y": 0, "k": 100}
    return {
        "c": round((1 - rr - k) / (1 - k) * 100),
        "m": round((1 - gg - k) / (1 - k) * 100),
        "y": round((1 - bb - k) / (1 - k) * 100),
        "k": round(k * 100),
    }


def get_contrast_color(r: int, g: int, b: int) -> str:
    luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
    return "black" if luminance > 0.5 else "white"


def parse_color(input_text: str) -> tuple[int, int, int] | None:
    clean = input_text.strip()
    named = NAMED_COLORS.get(clean.lower().replace(" ", ""))
    if named:
        return hex_to_rgb(named)
    if clean.startswith("#"):
        return hex_to_rgb(clean)
    m = re.match(r"^([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$", clean)
    if m:
        return hex_to_rgb(m.group(1))
    m = re.search(r"rgb\s*\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)\s*\)", clean, re.IGNORECASE)
    if m:
        return (int(m.group(1)), int(m.group(2)), int(m.group(3)))
    m = re.search(r"hsl\s*\(\s*(\d+)\s*[,\s]\s*(\d+)%\s*[,\s]\s*(\d+)%\s*\)", clean, re.IGNORECASE)
    if m:
        return hsl_to_rgb(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    return None


DEFINITION = ToolDefinition(
    id="color",
    name="Color Converter",
    description="Convert colors between hex, RGB, HSL, CMYK formats, find contrasting text colors, and look up named colors",
    version="1.0.0",
    icon="\U0001f3a8",
    params=[
        ToolParam(name="color", type="string", description='Color value (e.g., #FF0000, rgb(255,0,0), hsl(0,100%,50%), "red")', required=True),
        ToolParam(name="to", type="string", description="Target format: hex, rgb, hsl, cmyk, all (default)", required=False),
    ],
)


async def execute(params: dict[str, Any], ctx: ToolContext) -> ToolResult:
    color_str = str(params.get("color") or params.get("query") or ctx.userInput or "").strip()
    to = str(params.get("to") or "all").lower()

    if not color_str:
        return ToolResult(success=False, output="Please provide a color value to convert.")

    parsed = parse_color(color_str)
    if parsed is None:
        return ToolResult(
            success=False,
            output=f'Could not parse "{color_str}". Try: hex (#FF0000), rgb(255,0,0), hsl(0,100%,50%), or a named color (red, blue, etc.)',
        )

    r, g, b = parsed
    hex_val = rgb_to_hex(r, g, b)
    hsl = rgb_to_hsl(r, g, b)
    cmyk = rgb_to_cmyk(r, g, b)
    contrast = get_contrast_color(r, g, b)

    if to == "hex":
        return ToolResult(success=True, output=hex_val, data={"hex": hex_val, "r": r, "g": g, "b": b})
    if to == "rgb":
        return ToolResult(success=True, output=f"rgb({r}, {g}, {b})", data={"r": r, "g": g, "b": b})
    if to == "hsl":
        return ToolResult(success=True, output=f"hsl({hsl['h']}, {hsl['s']}%, {hsl['l']}%)", data=hsl)
    if to == "cmyk":
        return ToolResult(
            success=True,
            output=f"cmyk({cmyk['c']}%, {cmyk['m']}%, {cmyk['y']}%, {cmyk['k']}%)",
            data=cmyk,
        )

    named_entry = next((name for name, h in NAMED_COLORS.items() if h == hex_val), None)
    output = (
        f"\U0001f3a8 Color: {named_entry or hex_val}\n"
        f"\u2022 HEX: {hex_val}\n"
        f"\u2022 RGB: rgb({r}, {g}, {b})\n"
        f"\u2022 HSL: hsl({hsl['h']}\u00b0, {hsl['s']}%, {hsl['l']}%)\n"
        f"\u2022 CMYK: cmyk({cmyk['c']}%, {cmyk['m']}%, {cmyk['y']}%, {cmyk['k']}%)\n"
        f"\u2022 Contrast text: {contrast}"
    )
    return ToolResult(
        success=True,
        output=output,
        data={
            "hex": hex_val, "r": r, "g": g, "b": b,
            "h": hsl["h"], "s": hsl["s"], "l": hsl["l"],
            "cmyk": cmyk, "contrast": contrast, "name": named_entry,
        },
    )


def register_color_tool() -> None:
    register_tool(DEFINITION, execute)
    log_info("[tools] Color Converter registered")
