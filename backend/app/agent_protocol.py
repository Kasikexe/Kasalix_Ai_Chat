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
    "run_command": ({}, {"command": STRING, "cwd": STRING, "timeout": NUMBER, "background": BOOLEAN,
                         "operation": STRING, "process_id": STRING, "wait": NUMBER}),
    "browser": ({"operation": STRING}, {"url": STRING, "path": STRING, "selector": STRING, "text": STRING}),
    "edit_file": ({"path": STRING, "old_string": STRING, "new_string": STRING}, {}),
    "edit_lines": ({"path": STRING, "start": NUMBER, "content": STRING}, {"end": NUMBER, "expect": STRING}),
    "write_file": ({"path": STRING, "content": STRING}, {"force": BOOLEAN}),
    "delete_file": ({"path": STRING}, {}),
    "rename_file": ({"from": STRING, "to": STRING}, {}),
    "glob": ({"pattern": STRING}, {}),
}


def validate_command_args(args: dict[str, Any]) -> str | None:
    allowed = {"command", "cwd", "timeout", "background", "operation", "process_id", "wait"}
    if set(args) - allowed:
        return "run_command received unknown arguments."
    if "background" in args and not isinstance(args["background"], bool):
        return 'run_command "background" must be a boolean.'
    operation = args.get("operation", "start")
    if operation == "start":
        if not isinstance(args.get("command"), str) or not args["command"].strip():
            return 'run_command start requires a non-empty "command".'
        if "process_id" in args or "wait" in args:
            return 'run_command start does not accept "process_id" or "wait".'
        timeout = args.get("timeout")
        if "timeout" in args and (isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= 600):
            return 'run_command "timeout" must be an integer from 1 to 600 seconds.'
    elif operation in ("status", "stop"):
        if not isinstance(args.get("process_id"), str) or not args["process_id"].strip():
            return f'run_command {operation} requires "process_id".'
        if any(key in args for key in ("command", "cwd", "timeout", "background")):
            return f'run_command {operation} only accepts "process_id"' + (' and "wait".' if operation == "status" else '.')
        if operation == "stop" and "wait" in args:
            return 'run_command stop does not accept "wait".'
        wait = args.get("wait", 0)
        if isinstance(wait, bool) or not isinstance(wait, int) or not 0 <= wait <= 10:
            return 'run_command "wait" must be an integer from 0 to 10 seconds.'
    else:
        return 'run_command "operation" must be "start", "status", or "stop".'
    return None


def validate_browser_args(args: dict[str, Any]) -> str | None:
    operation = args.get("operation")
    allowed = {
        "open": {"operation", "url", "path"}, "inspect": {"operation"}, "click": {"operation", "selector"},
        "type": {"operation", "selector", "text"}, "screenshot": {"operation"},
        "console": {"operation"}, "close": {"operation"},
    }
    if not isinstance(operation, str) or operation not in allowed:
        return "browser operation must be open, inspect, click, type, screenshot, console, or close."
    unexpected = set(args) - allowed[operation]
    if unexpected:
        return (f"browser {operation} does not accept {', '.join(sorted(unexpected))}. "
                f"Allowed arguments: {', '.join(sorted(allowed[operation]))}.")
    if operation == "open" and "url" in args and "path" in args:
        return "browser open accepts either url or path, not both."
    required = {"click": ("selector",), "type": ("selector", "text")}.get(operation, ())
    if operation == "open":
        required = tuple(key for key in ("url", "path") if key in args)
    for key in required:
        if not isinstance(args.get(key), str) or (key != "text" and not args[key].strip()) or len(args[key]) > 4096:
            return f"browser {operation} requires a valid {key} string."
    return None


def native_tool_schemas(definitions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    tools = []
    for definition in definitions:
        name = definition["name"]
        if name not in TOOL_ARGUMENTS:
            continue  # Never expose a tool without an explicit schema.
        required, optional = TOOL_ARGUMENTS[name]
        properties = {**required, **optional}
        if name == "browser":
            properties = {
                "operation": {"type": "string", "enum": ["open", "inspect", "click", "type", "screenshot", "console", "close"],
                              "description": "Choose one browser action. Inspect before clicking or typing."},
                "url": {"type": "string", "description": "Open only: the actual localhost HTTP(S) URL of an existing server."},
                "path": {"type": "string", "description": "Open only: workspace HTML file to serve automatically. Omit for index.html."},
                "selector": {"type": "string", "description": "Click or type only: a visible element selector from inspect."},
                "text": {"type": "string", "description": "Type only: text to enter."},
            }
        tools.append({"type": "function", "function": {"name": name, "description": definition["description"],
            "parameters": {"type": "object", "properties": properties, "required": list(required)}}})
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
        if name == "browser" and isinstance(args, dict) and validate_browser_args(args):
            raise ValueError(validate_browser_args(args))
        schema = {"type": "object", "properties": {**required, **optional}, "required": list(required)}
        if not _valid(args, schema):
            raise ValueError(f"Invalid arguments for {name}")
        if name == "run_command" and validate_command_args(args):
            raise ValueError(validate_command_args(args))
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
