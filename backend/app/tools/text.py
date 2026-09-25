"""Text Utilities Tool — mirrors backend/src/services/tools/text.ts."""

from __future__ import annotations

import base64
import re
import urllib.parse
from typing import Any, Callable

from ..logger import info as log_info
from . import ToolContext, ToolDefinition, ToolParam, ToolResult, register_tool


def word_count(text: str) -> int:
    return len([w for w in re.split(r"\s+", text.strip()) if w])


def char_count(text: str) -> int:
    return len(text)


def line_count(text: str) -> int:
    return len(text.split("\n"))


def to_title_case(text: str) -> str:
    return re.sub(
        r"\w\S*", lambda m: m.group(0)[0].upper() + m.group(0)[1:].lower(), text
    )


def to_camel_case(text: str) -> str:
    out = re.sub(r"[-_\s]+(.)", lambda m: m.group(1).upper(), text)
    if out and out[0].isupper():
        out = out[0].lower() + out[1:]
    return re.sub(r"[-_\s]", "", out)


def to_snake_case(text: str) -> str:
    out = re.sub(r"([A-Z])", r"_\1", text)
    out = re.sub(r"[-_\s]+", "_", out).lower()
    return out[1:] if out.startswith("_") else out


OPERATIONS: dict[str, Callable[[str], str]] = {
    "uppercase": str.upper,
    "lowercase": str.lower,
    "titlecase": to_title_case,
    "camelcase": to_camel_case,
    "snakecase": to_snake_case,
    "reverse": lambda t: t[::-1],
    "base64encode": lambda t: base64.b64encode(t.encode("utf-8")).decode("ascii"),
    "base64decode": lambda t: base64.b64decode(t).decode("utf-8", "replace"),
    "urlencode": lambda t: urllib.parse.quote(t, safe=""),
    "urldecode": lambda t: urllib.parse.unquote(t),
}


def detect_operation(input_text: str) -> str | None:
    lower = input_text.lower()
    if any(k in lower for k in ("uppercase", "upper case", "capitalize", "all caps")):
        return "uppercase"
    if any(k in lower for k in ("lowercase", "lower case")):
        return "lowercase"
    if any(k in lower for k in ("title case", "titlecase")):
        return "titlecase"
    if any(k in lower for k in ("camel case", "camelcase")):
        return "camelcase"
    if any(k in lower for k in ("snake case", "snakecase")):
        return "snakecase"
    if "reverse" in lower or "backwards" in lower:
        return "reverse"
    if "base64 encode" in lower:
        return "base64encode"
    if "base64 decode" in lower or "decode base64" in lower:
        return "base64decode"
    if "url encode" in lower:
        return "urlencode"
    if "url decode" in lower:
        return "urldecode"
    return None


DEFINITION = ToolDefinition(
    id="text",
    name="Text Utilities",
    description=(
        "Analyze and transform text: word/char/line/sentence count, case conversion, "
        "encoding (base64, URL), and more"
    ),
    version="1.0.0",
    icon="\U0001f4dd",
    params=[
        ToolParam(
            name="operation",
            type="string",
            description=(
                "What to do: count, uppercase, lowercase, titlecase, camelcase, snakecase, "
                "reverse, base64encode, base64decode, urlencode, urldecode"
            ),
            required=True,
        ),
        ToolParam(name="text", type="string", description="The text to analyze or transform", required=True),
    ],
)


async def execute(params: dict[str, Any], ctx: ToolContext) -> ToolResult:
    text = str(params.get("text") or params.get("query") or ctx.userInput or "")
    operation = str(
        params.get("operation") or detect_operation(ctx.userInput) or "count"
    ).lower()

    if not text.strip():
        return ToolResult(success=False, output="Please provide some text to analyze or transform.")

    if operation in ("count", "stats", "analyze"):
        wc = word_count(text)
        cc = char_count(text)
        ccns = len(re.sub(r"\s", "", text))
        lc = line_count(text)
        sc = len([s for s in re.split(r"[.!?]+", text) if s.strip()])
        vowels = len(re.findall(r"[aeiou\u00e1\u00e9\u00ed\u00f3\u00fa\u00e0\u00e8\u00ec\u00f2\u00f9\u00e4\u00eb\u00ef\u00f6\u00fc\u00e2\u00ea\u00ee\u00f4\u00fb]", text, re.IGNORECASE))
        consonants = len(re.findall(r"[bcdfghjklmnpqrstvwxyz]", text, re.IGNORECASE))
        return ToolResult(
            success=True,
            output=(
                f"\U0001f4ca Text Statistics:\n\u2022 Words: {wc}\n\u2022 Characters: {cc} ({ccns} without spaces)"
                f"\n\u2022 Lines: {lc}\n\u2022 Sentences: {sc}\n\u2022 Vowels: {vowels}\n\u2022 Consonants: {consonants}"
            ),
            data={
                "words": wc, "chars": cc, "charsNoSpaces": ccns, "lines": lc,
                "sentences": sc, "vowels": vowels, "consonants": consonants,
            },
        )

    transformer = OPERATIONS.get(operation)
    if transformer:
        try:
            result = transformer(text)
            return ToolResult(
                success=True, output=result, data={"operation": operation, "input": text, "output": result}
            )
        except Exception as e:  # noqa: BLE001
            return ToolResult(success=False, output=f"Failed to {operation}: {e}")

    return ToolResult(
        success=False,
        output=(
            f'Unknown operation "{operation}". Available: count/stats, uppercase, lowercase, titlecase, '
            "camelcase, snakecase, reverse, base64encode, base64decode, urlencode, urldecode"
        ),
    )


def register_text_tool() -> None:
    register_tool(DEFINITION, execute)
    log_info("[tools] Text Utilities registered")
