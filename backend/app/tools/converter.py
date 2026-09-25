"""Converter Tool — mirrors backend/src/services/tools/converter.ts.

Converts between units: temperature, length, weight, volume, speed, data,
currency (approximate).
"""

from __future__ import annotations

import re
from typing import Any, Callable

from ..logger import info as log_info
from . import ToolContext, ToolDefinition, ToolParam, ToolResult, register_tool

UnitConv = tuple[str, str, Callable[[float], float], Callable[[float], float]]  # id, name, toBase, fromBase

CATEGORIES: list[tuple[str, str, list[UnitConv]]] = [
    ("temperature", "Temperature", [
        ("celsius", "Celsius (\u00b0C)", lambda v: v, lambda v: v),
        ("fahrenheit", "Fahrenheit (\u00b0F)", lambda v: (v - 32) * 5 / 9, lambda v: v * 9 / 5 + 32),
        ("kelvin", "Kelvin (K)", lambda v: v - 273.15, lambda v: v + 273.15),
    ]),
    ("length", "Length", [
        ("millimeter", "Millimeters", lambda v: v / 1000, lambda v: v * 1000),
        ("centimeter", "Centimeters", lambda v: v / 100, lambda v: v * 100),
        ("meter", "Meters", lambda v: v, lambda v: v),
        ("kilometer", "Kilometers", lambda v: v * 1000, lambda v: v / 1000),
        ("inch", "Inches", lambda v: v * 0.0254, lambda v: v / 0.0254),
        ("foot", "Feet", lambda v: v * 0.3048, lambda v: v / 0.3048),
        ("yard", "Yards", lambda v: v * 0.9144, lambda v: v / 0.9144),
        ("mile", "Miles", lambda v: v * 1609.344, lambda v: v / 1609.344),
    ]),
    ("weight", "Weight", [
        ("gram", "Grams", lambda v: v / 1000, lambda v: v * 1000),
        ("kilogram", "Kilograms", lambda v: v, lambda v: v),
        ("ton", "Tons (metric)", lambda v: v * 1000, lambda v: v / 1000),
        ("pound", "Pounds", lambda v: v * 0.453592, lambda v: v / 0.453592),
        ("ounce", "Ounces", lambda v: v * 0.0283495, lambda v: v / 0.0283495),
    ]),
    ("volume", "Volume", [
        ("milliliter", "Milliliters", lambda v: v / 1000, lambda v: v * 1000),
        ("liter", "Liters", lambda v: v, lambda v: v),
        ("gallon", "Gallons (US)", lambda v: v * 3.78541, lambda v: v / 3.78541),
        ("quart", "Quarts (US)", lambda v: v * 0.946353, lambda v: v / 0.946353),
        ("cup", "Cups", lambda v: v * 0.236588, lambda v: v / 0.236588),
    ]),
    ("speed", "Speed", [
        ("kmh", "km/h", lambda v: v / 3.6, lambda v: v * 3.6),
        ("mph", "mph", lambda v: v * 0.44704, lambda v: v / 0.44704),
        ("ms", "m/s", lambda v: v, lambda v: v),
        ("knot", "Knots", lambda v: v * 0.514444, lambda v: v / 0.514444),
    ]),
    ("data", "Data", [
        ("byte", "Bytes", lambda v: v, lambda v: v),
        ("kilobyte", "Kilobytes", lambda v: v * 1024, lambda v: v / 1024),
        ("megabyte", "Megabytes", lambda v: v * 1024 * 1024, lambda v: v / (1024 * 1024)),
        ("gigabyte", "Gigabytes", lambda v: v * 1024 ** 3, lambda v: v / (1024 ** 3)),
    ]),
    ("currency", "Currency (approximate)", [
        ("usd", "USD ($)", lambda v: v, lambda v: v),
        ("eur", "EUR (\u20ac)", lambda v: v * 1.08, lambda v: v / 1.08),
        ("gbp", "GBP (\u00a3)", lambda v: v * 1.27, lambda v: v / 1.27),
        ("jpy", "JPY (\u00a5)", lambda v: v * 0.0067, lambda v: v / 0.0067),
        ("czk", "CZK (K\u010d)", lambda v: v * 0.041, lambda v: v / 0.041),
    ]),
]

CONVERT_PATTERNS = [
    re.compile(r"convert\s+(\d+(?:\.\d+)?)\s*([a-zA-Z\u00b0\u00a9\u00ae]+)\s*(?:to|in|\u2192)\s*([a-zA-Z\u00b0\u00a9\u00ae]+)", re.IGNORECASE),
    re.compile(r"(\d+(?:\.\d+)?)\s*([a-zA-Z\u00b0\u00a9\u00ae]+)\s*(?:to|in|\u2192|as)\s*([a-zA-Z\u00b0\u00a9\u00ae]+)", re.IGNORECASE),
    re.compile(r"(?:what is|how much is|how many)\s+(\d+(?:\.\d+)?)\s*([a-zA-Z\u00b0\u00a9\u00ae]+)\s*(?:to|in|as)\s*([a-zA-Z\u00b0\u00a9\u00ae]+)", re.IGNORECASE),
    re.compile(r"(\d+(?:\.\d+)?)\s*(?:degrees?\s*)?([a-zA-Z\u00b0\u00a9\u00ae]+)\s*(?:is|equals?)\s*(?:.*?)\s*([a-zA-Z\u00b0\u00a9\u00ae]+)", re.IGNORECASE),
]

UNIT_ALIASES: dict[str, str] = {
    "\u00b0c": "celsius", "c": "celsius", "celsius": "celsius",
    "\u00b0f": "fahrenheit", "f": "fahrenheit", "fahrenheit": "fahrenheit",
    "k": "kelvin", "kelvin": "kelvin",
    "mm": "millimeter", "millimeter": "millimeter", "millimeters": "millimeter",
    "cm": "centimeter", "centimeter": "centimeter", "centimeters": "centimeter",
    "m": "meter", "meter": "meter", "meters": "meter", "metre": "meter",
    "km": "kilometer", "kilometer": "kilometer", "kilometers": "kilometer",
    "in": "inch", "inch": "inch", "inches": "inch", '"': "inch",
    "ft": "foot", "foot": "foot", "feet": "foot", "'": "foot",
    "yd": "yard", "yard": "yard", "yards": "yard",
    "mi": "mile", "mile": "mile", "miles": "mile",
    "g": "gram", "gram": "gram", "grams": "gram",
    "kg": "kilogram", "kilogram": "kilogram", "kilograms": "kilogram",
    "t": "ton", "ton": "ton", "tons": "ton", "tonne": "ton",
    "lb": "pound", "pound": "pound", "lbs": "pound", "pounds": "pound",
    "oz": "ounce", "ounce": "ounce", "ounces": "ounce",
    "ml": "milliliter", "milliliter": "milliliter", "milliliters": "milliliter",
    "l": "liter", "liter": "liter", "liters": "liter", "litre": "liter",
    "gal": "gallon", "gallon": "gallon", "gallons": "gallon",
    "qt": "quart", "quart": "quart", "quarts": "quart",
    "kph": "kmh", "km/h": "kmh", "kmh": "kmh",
    "mph": "mph",
    "m/s": "ms", "ms": "ms",
    "b": "byte", "byte": "byte", "bytes": "byte",
    "kb": "kilobyte", "kilobyte": "kilobyte",
    "mb": "megabyte", "megabyte": "megabyte",
    "gb": "gigabyte", "gigabyte": "gigabyte",
    "$": "usd", "usd": "usd", "dollar": "usd", "dollars": "usd",
    "\u20ac": "eur", "eur": "eur", "euro": "eur", "euros": "eur",
    "\u00a3": "gbp", "gbp": "gbp", "pound sterling": "gbp",
    "\u00a5": "jpy", "jpy": "jpy", "yen": "jpy",
    "k\u010d": "czk", "czk": "czk", "koruna": "czk", "crown": "czk",
}


def resolve_unit(text: str) -> str | None:
    clean = re.sub(r"[\u00b0\"']", "", text).strip().lower()
    return UNIT_ALIASES.get(clean)


def detect_conversion(input_text: str) -> dict[str, Any] | None:
    for pattern in CONVERT_PATTERNS:
        m = pattern.search(input_text)
        if not m:
            continue
        value = float(m.group(1))
        from_id = resolve_unit(m.group(2))
        to_id = resolve_unit(m.group(3))
        if from_id and to_id:
            for _cid, cname, units in CATEGORIES:
                unit_ids = [u[0] for u in units]
                if from_id in unit_ids and to_id in unit_ids:
                    return {"value": value, "from": from_id, "to": to_id, "category": cname}
    return None


def run_conversion(value: float, from_id: str, to_id: str) -> dict[str, Any] | None:
    for _cid, _cname, units in CATEGORIES:
        from_unit = next((u for u in units if u[0] == from_id), None)
        to_unit = next((u for u in units if u[0] == to_id), None)
        if from_unit and to_unit:
            base_value = from_unit[2](value)
            result = to_unit[3](base_value)
            return {"result": result, "formula": f"{value} {from_unit[1]} \u2192 {result:.4f} {to_unit[1]}"}
    return None


DEFINITION = ToolDefinition(
    id="converter",
    name="Unit Converter",
    description="Convert between units: temperature, length, weight, volume, speed, data, and currency",
    version="1.0.0",
    icon="\U0001f504",
    params=[
        ToolParam(name="value", type="number", description="The numeric value to convert", required=True),
        ToolParam(name="from", type="string", description="Source unit (e.g., celsius, feet, kg)", required=True),
        ToolParam(name="to", type="string", description="Target unit (e.g., fahrenheit, meters, lb)", required=True),
    ],
)


async def execute(params: dict[str, Any], ctx: ToolContext) -> ToolResult:
    try:
        value = float(params.get("value"))
    except (TypeError, ValueError):
        return ToolResult(success=False, output="Please provide a numeric value to convert.")
    from_id = resolve_unit(str(params.get("from") or ""))
    to_id = resolve_unit(str(params.get("to") or ""))
    if not from_id or not to_id:
        return ToolResult(success=False, output='Could not recognize units. Try: "convert 100 cm to inches"')

    conversion = run_conversion(value, from_id, to_id)
    if conversion is None:
        return ToolResult(success=False, output="Cannot convert between those units — they may be in different categories.")

    return ToolResult(
        success=True,
        output=conversion["formula"],
        data={"value": value, "from": from_id, "to": to_id, "result": conversion["result"]},
    )


def register_converter_tool() -> None:
    register_tool(DEFINITION, execute)
    log_info(f"[tools] Converter registered with {len(CATEGORIES)} unit categories")
