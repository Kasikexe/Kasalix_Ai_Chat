"""Tool Registration — mirrors backend/src/services/tools/register.ts.

Imported once to register all built-in tools.
"""

from __future__ import annotations

from ..logger import info as log_info
from . import get_all_tools
from .calculator import register_calculator_tool
from .color import register_color_tool
from .converter import register_converter_tool
from .datetime import register_datetime_tool
from .draw import register_draw_tool
from .hash import register_hash_tool
from .json import register_json_tool
from .random import register_random_tool
from .search import register_search_tool
from .text import register_text_tool


def register_all_tools() -> None:
    register_converter_tool()
    register_calculator_tool()
    register_text_tool()
    register_random_tool()
    register_json_tool()
    register_color_tool()
    register_datetime_tool()
    register_hash_tool()
    register_search_tool()
    register_draw_tool()

    tools = get_all_tools()
    names = ", ".join(t.name for t in tools)
    log_info(f"[tools] {len(tools)} tool(s) registered: {names}")
