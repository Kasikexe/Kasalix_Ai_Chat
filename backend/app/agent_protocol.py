"""Schemas and validation for Koding's model-facing tools."""

from __future__ import annotations

import json
from typing import Any


STRING = {"type": "string"}
NUMBER = {"type": "integer"}
BOOLEAN = {"type": "boolean"}

# Each entry is (required parameters, optional parameters). Keep these aligned
# with execute_tool: the same schema is used for model output and validation.
TOOL_ARGUMENTS: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {
    "list_files": ({}, {}),
    "read_file": ({"path": STRING}, {"numbers": BOOLEAN, "offset": NUMBER, "length": NUMBER}),
    "search_files": ({"query": STRING}, {"case_sensitive": BOOLEAN}),
    "edit_file": ({"path": STRING, "old_string": STRING, "new_string": STRING}, {}),
    "edit_lines": ({"path": STRING, "start": NUMBER, "content": STRING}, {"end": NUMBER, "expect": STRING}),
    "write_file": ({"path": STRING, "content": STRING}, {"force": BOOLEAN}),
    "delete_file": ({"path": STRING}, {}),
    "rename_file": ({"from": STRING, "to": STRING}, {}),
    "glob": ({"pattern": STRING}, {}),
}


def native_tool_schemas(definitions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    tools = []
    for definition in definitions:
        name = definition["name"]
        if name not in TOOL_ARGUMENTS:
            continue  # Never expose a tool without an explicit schema.
        required, optional = TOOL_ARGUMENTS[name]
        tools.append({"type": "function", "function": {"name": name, "description": definition["description"],
            "parameters": {"type": "object", "properties": {**required, **optional}, "required": list(required)}}})
    return tools


def _valid(value: Any, schema: dict[str, Any]) -> bool:
    kind = schema.get("type")
    if kind == "string":
        return isinstance(value, str)
    if kind == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if kind == "boolean":
        return isinstance(value, bool)
    if kind == "array":
        return isinstance(value, list) and all(_valid(item, schema.get("items", {})) for item in value)
    if kind == "object":
        if not isinstance(value, dict):
            return False
        properties = schema.get("properties", {})
        return all(key in value for key in schema.get("required", [])) and all(key in properties and _valid(v, properties[key]) for key, v in value.items())
    return False


def normalize_native_calls(calls: list[dict[str, Any]], permitted: set[str]) -> list[dict[str, Any]]:
    """Reject unknown/malformed calls; never repair or execute partial input."""
    result = []
    for call in calls:
        function = call.get("function") if isinstance(call, dict) else None
        if not isinstance(function, dict):
            raise ValueError("Malformed native tool call")
        name, args = function.get("name"), function.get("arguments")
        if not isinstance(name, str) or name not in permitted or name not in TOOL_ARGUMENTS:
            raise ValueError(f"Unknown or unavailable tool: {name}")
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except ValueError as exc:
                raise ValueError(f"Invalid arguments for {name}") from exc
        required, optional = TOOL_ARGUMENTS[name]
        schema = {"type": "object", "properties": {**required, **optional}, "required": list(required)}
        if not _valid(args, schema):
            raise ValueError(f"Invalid arguments for {name}")
        result.append({"tool": name, "args": args})
    return result


def structured_action_schema(permitted: set[str]) -> dict[str, Any]:
    """A constrained envelope; tool-specific arguments are checked separately."""
    permitted = permitted.intersection(TOOL_ARGUMENTS)
    properties: dict[str, Any] = {}
    for name in permitted:
        if name not in TOOL_ARGUMENTS:
            continue
        required, optional = TOOL_ARGUMENTS[name]
        for key, schema in {**required, **optional}.items():
            if key in properties and properties[key] != schema:
                raise ValueError(f"Conflicting schemas for argument: {key}")
            properties[key] = schema
    return {"oneOf": [
        {"type": "object", "properties": {"action": {"const": "tool"}, "tool": {"type": "string", "enum": sorted(permitted)}, "args": {"type": "object", "properties": properties, "additionalProperties": False}}, "required": ["action", "tool", "args"], "additionalProperties": False},
        {"type": "object", "properties": {"action": {"const": "final"}, "message": {"type": "string"}}, "required": ["action", "message"], "additionalProperties": False},
        {"type": "object", "properties": {"action": {"const": "question"}, "question": {"type": "string"}}, "required": ["action", "question"], "additionalProperties": False},
    ]}


def normalize_structured_action(raw: str, permitted: set[str]) -> dict[str, Any]:
    try:
        data = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError("Response is not valid JSON") from exc
    if not isinstance(data, dict):
        raise ValueError("Response must be an object")
    action = data.get("action")
    if action == "tool" and set(data) == {"action", "tool", "args"}:
        call = normalize_native_calls([{"function": {"name": data["tool"], "arguments": data["args"]}}], permitted)[0]
        return {"action": "tool", "call": call}
    if action == "final" and set(data) == {"action", "message"} and isinstance(data["message"], str) and data["message"].strip():
        return data
    if action == "question" and set(data) == {"action", "question"} and isinstance(data["question"], str) and data["question"].strip():
        return {"action": "final", "message": data["question"]}
    raise ValueError("Invalid action or missing fields")
