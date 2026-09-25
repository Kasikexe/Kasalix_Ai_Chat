"""Draw Image tool — mirrors backend/src/services/tools/draw.ts.

The model is the artist: it authors a complete SVG scene in the tool call and
the backend sanitizes it, rasterizes it to PNG, and serves it back.
"""

from __future__ import annotations

from typing import Any

from ..imagegen import sanitize_svg, save_artwork
from ..logger import error as log_error
from . import ToolContext, ToolDefinition, ToolParam, ToolResult, register_tool

DEFINITION = ToolDefinition(
    id="draw_image",
    name="Draw Image",
    description=(
        "Draw or generate an image by authoring vector art. Use this when the user asks you to draw, "
        "make, generate, create, or show an image, picture, photo, logo, icon, illustration, or art "
        "(there is no other image generator). "
        "Pass `svg`: ONE complete standalone SVG document that draws the requested picture — NOT a "
        "prompt describing it. "
        'Guidelines: declare width="1024" height="1024" viewBox="0 0 1024 1024"; use flat vector style '
        "with <rect>, <circle>, <ellipse>, <polygon>, <path>, linear/radial gradients in <defs>, and "
        "<g> for groups; layered scenes read best (background first, foreground last); NEVER use "
        "<text> (no fonts available); keep it under ~60 elements; a clean simple scene beats a busy one."
    ),
    version="1.0.0",
    icon="\U0001f3a8",
    params=[
        ToolParam(
            name="svg",
            type="string",
            description=(
                'The complete standalone SVG document (e.g. <svg xmlns="http://www.w3.org/2000/svg" '
                'width="1024" height="1024" viewBox="0 0 1024 1024">…) that draws the requested image.'
            ),
            required=True,
        ),
    ],
)


async def execute(params: dict[str, Any], ctx: ToolContext) -> ToolResult:
    svg = params.get("svg")
    svg = svg.strip() if isinstance(svg, str) else ""
    check = sanitize_svg(svg)
    if not check["ok"]:
        return ToolResult(
            success=False,
            output=f"Your SVG was rejected: {check['error']} Rewrite it to fix the problem, then call the tool again.",
        )

    try:
        art = await save_artwork(svg)
        markdown = f"![Generated image](/api/generated/{art['filename']})"
        kind = "raster PNG" if art["png"] else "SVG"
        return ToolResult(
            success=True,
            output=(
                f'Image drawn and saved as "{art["filename"]}" ({kind}). '
                f"In your reply to the user, include this EXACT markdown so the image displays: {markdown}"
            ),
            data={"filename": art["filename"], "png": art["png"], "markdown": markdown},
        )
    except Exception as e:  # noqa: BLE001
        log_error("[tools] draw_image failed:", e)
        return ToolResult(
            success=False,
            output=f"Could not save the image ({e}). Tell the user the image could not be created.",
        )


def register_draw_tool() -> None:
    register_tool(DEFINITION, execute)
