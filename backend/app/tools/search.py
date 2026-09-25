"""Web Search tool — mirrors backend/src/services/tools/search.ts.

Lets the MODEL decide when to look something up instead of the app guessing
from keywords — the main anti-hallucination tool.
"""

from __future__ import annotations

from typing import Any

from ..logger import error as log_error
from ..search import get_web_context
from . import ToolContext, ToolDefinition, ToolParam, ToolResult, register_tool

DEFINITION = ToolDefinition(
    id="web_search",
    name="Web Search",
    description=(
        "Search the web for current, factual information. Use this when you are unsure about a fact, "
        "number, date, price, or anything time-sensitive — instead of guessing."
    ),
    version="1.0.0",
    icon="\U0001f310",
    params=[
        ToolParam(
            name="query",
            type="string",
            description='Search query (e.g. "height of Burj Khalifa in meters")',
            required=True,
        ),
    ],
)


async def execute(params: dict[str, Any], ctx: ToolContext) -> ToolResult:
    query = str(params.get("query") or "").strip()
    if not query:
        return ToolResult(success=False, output="Please provide a search query.")
    try:
        context = await get_web_context(query)
        if not context or not context.strip():
            return ToolResult(
                success=True,
                output=(
                    f'No useful results found for "{query}". Tell the user you couldn\'t find '
                    f"reliable information rather than guessing."
                ),
            )
        return ToolResult(
            success=True,
            output=(
                f'[WEB SEARCH RESULTS for "{query}"]\n{context}\n\n'
                "Answer the user using these results as the source of truth. If the results "
                "don't contain the answer, say so honestly — do not guess."
            ),
        )
    except Exception as e:  # noqa: BLE001
        log_error("[tools] web_search failed:", e)
        return ToolResult(
            success=False,
            output=f"Web search failed ({e}). If you don't know the answer, say so honestly.",
        )


def register_search_tool() -> None:
    register_tool(DEFINITION, execute)
