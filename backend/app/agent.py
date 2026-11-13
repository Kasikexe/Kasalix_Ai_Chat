"""Coding agent — mirrors backend/src/services/agent.ts.

The autonomous Koding agent loop: model-driven tool calling against a
workspace, with session logs, resume state, approvals, background processes,
and the full guarded tool catalog.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import re
import secrets
import signal as signal_module
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

from .ai_rules import with_ai_rules
from .agent_protocol import native_tool_schemas, normalize_native_calls, normalize_structured_action, structured_action_schema, validate_browser_args, validate_command_args
from .game_harness import HARNESS_SOURCE
from .logger import error as log_error, info as log_info, warn as log_warn
from .model_assignments import get_resolved_model
from .ollama_client import OllamaError, StreamOptions, stream_chat, stream_chat_with_tools
from .services.project_rules import (
    read_agent_memory,
    read_project_config,
    read_project_rules,
)
from .services.session_log import SessionLog
from .settings_store import get_cloud_settings
from .utils import (
    PROTECTED_DIRS,
    apply_line_range,
    apply_search_replace,
    changed_line_count,
    diff_lines,
    is_path_inside,
    is_protected_path,
    protected_dirs_label,
)

# ─── Background process tracking ───────────────────────────────────────
background_processes: dict[str, dict[str, Any]] = {}


def get_background_processes() -> list[dict[str, Any]]:
    """Get status of all background processes (for dashboard)."""
    results: list[dict[str, Any]] = []
    for pid, proc in background_processes.items():
        results.append(
            {
                "id": pid,
                "output": proc["output"],
                "exitCode": proc.get("exitCode"),
                "done": proc["done"],
                "outputPreview": proc["output"][-500:],
            }
        )
    return results


# ─── Sandbox helpers ────────────────────────────────────────────────────
def resolve_workspace_root(ws: str | None) -> str | None:
    if not ws or not isinstance(ws, str):
        return None
    resolved = os.path.abspath(ws)
    if os.path.splitdrive(resolved)[1] in ("\\", "/") or resolved == "/":
        return None  # reject drive roots
    return resolved


async def resolve_in_workspace(ws_root: str, p: str) -> str | None:
    """Resolve a relative path inside the workspace, or None if it escapes or is protected."""
    candidate = os.path.abspath(os.path.join(ws_root, p))
    if is_protected_path(ws_root, candidate):
        return None
    if not (await is_path_inside(ws_root, candidate)):
        return None
    return candidate


IGNORE_DIRS = {
    "node_modules", ".git", ".svn", ".hg", ".DS_Store",
    "__pycache__", ".next", ".nuxt", "dist", "build", ".cache",
    "target", "vendor", ".venv", "venv", "env", "coverage",
}


async def find_workspace_files_by_basename(root: str, basename: str, max_results: int = 10) -> list[str]:
    """Recursively find files whose basename matches (case-insensitive), capped.
    Returns absolute paths, always inside the workspace and never in protected dirs."""
    needle = basename.lower()
    found: list[str] = []

    async def walk(dir: str, depth: int) -> None:
        if depth > 5 or len(found) >= max_results:
            return
        if is_protected_path(root, dir):
            return
        try:
            entries = os.listdir(dir)
        except OSError:
            return
        for name in entries:
            if name.startswith(".") or name in IGNORE_DIRS:
                continue
            full = os.path.join(dir, name)
            if os.path.isdir(full):
                await walk(full, depth + 1)
            elif name.lower() == needle:
                found.append(full)
                if len(found) >= max_results:
                    return

    await walk(root, 0)
    return found


async def is_file(p: str) -> bool:
    try:
        return os.path.isfile(p)
    except OSError:
        return False


async def resolve_target_smart(root: str, p: str) -> dict[str, Any]:
    """Resolve a path for reading/editing/deleting with a basename fallback."""
    exact = await resolve_in_workspace(root, p)
    if exact:
        try:
            if os.path.isfile(exact):
                return {"target": exact}
        except OSError:  # noqa: S110
            pass
    if exact:
        candidates = await find_workspace_files_by_basename(root, os.path.basename(p))
        if len(candidates) == 1:
            return {"target": candidates[0], "resolvedFrom": p}
        if len(candidates) > 1:
            rels = ", ".join(os.path.relpath(c, root).replace(os.sep, "/") for c in candidates)
            return {
                "target": None,
                "error": f"{p} does not exist, and {len(candidates)} files share that name ({rels}). Specify the full subfolder path.",
            }
        return {"target": None, "error": f"Could not find {p} inside the workspace ({root}). Use list_files to see what exists."}
    return {"target": None, "error": f"Access denied: {p} is outside the workspace."}


def first_present(args: dict[str, Any], *keys: str) -> Any:
    """First argument that the model actually supplied (skip missing/None)."""
    for k in keys:
        if k in args and args[k] is not None:
            return args[k]
    return None


def _arg_str(args: dict[str, Any], *keys: str) -> str | None:
    """First argument that is a string, tolerating the alias drift models emit
    (old_string / oldString / text, and so on)."""
    v = first_present(args, *keys)
    return v if isinstance(v, str) else None


NUMBERED_LINE_RE = re.compile(r"^\s*\d+\|\s?")


def strip_line_numbers(text: str) -> str:
    """Undo read_file's `  12| code` numbering when a model pastes a numbered
    read back into an edit. Only strips when EVERY non-empty line carries a
    number, and callers use it as a FALLBACK after a plain match failed, so real
    content that happens to contain "12| " is never mangled."""
    lines = text.split("\n")
    non_empty = [l for l in lines if l.strip()]
    if not non_empty or not all(NUMBERED_LINE_RE.match(l) for l in non_empty):
        return text
    return "\n".join(NUMBERED_LINE_RE.sub("", l, count=1) for l in lines)


def search_replace_with_number_fallback(content: str, old_string: str, new_string: str) -> dict[str, Any]:
    """apply_search_replace, then — only if the snippet was not found at all —
    retry once with pasted `12| ` line numbers stripped."""
    result = apply_search_replace(content, old_string, new_string)
    if result.get("ok"):
        return result
    if result.get("matches"):  # found but ambiguous / refused: numbering is not the problem
        return result
    cleaned = strip_line_numbers(old_string)
    if cleaned != old_string:
        retry = apply_search_replace(content, cleaned, new_string)
        if retry.get("ok"):
            return retry
    return result


# ─── User rules (read-only for the agent) ───────────────────────────────
USER_RULES_FILENAMES = [".agent-rules.md", ".agent-rules", "AGENT_RULES.md"]


def is_user_rules_path(root: str, target: str) -> bool:
    rel = os.path.relpath(target, root)
    if rel == "" or rel.startswith("..") or os.path.isabs(rel):
        return False
    if os.sep in rel:
        return False  # must be the file at the workspace root
    return os.path.basename(target).lower() in USER_RULES_FILENAMES


MAX_READ_BYTES = 200 * 1024        # read_file cap
MIN_READ_BYTES = 2000              # read_file floor — tiny model-requested windows are never useful
MAX_OUTPUT_CHARS = 8000            # run_command output cap
MAX_SEARCH_MATCHES = 50
MAX_ITERATIONS = 15                # loop guard (default; auto-extends on progress)
MAX_ITERATIONS_HARD_CAP = 120      # absolute ceiling — runaway protection
PROGRESS_WINDOW = 6                # iterations evaluated when deciding to extend
MAX_HISTORY = 40                   # bounded tool-loop history
GAME_VERIFY_CAP = 8                # automatic headless game replays per run


def action_limits(root: str) -> tuple[float, int]:
    """Per-workspace wall-clock deadline and number of action retries."""
    timeout, retries = 180.0, 2
    try:
        config = json.loads((Path(root) / ".agent-config.json").read_text(encoding="utf-8"))
        configured_timeout = config.get("actionTimeoutSeconds")
        configured_retries = config.get("actionRetryLimit")
        if isinstance(configured_timeout, (int, float)) and not isinstance(configured_timeout, bool):
            timeout = max(5.0, min(float(configured_timeout), 1800.0))
        if isinstance(configured_retries, int) and not isinstance(configured_retries, bool):
            retries = max(0, min(configured_retries, 4))
    except (OSError, ValueError, AttributeError):
        pass
    return timeout, retries


# ─── Transient-error retry ──────────────────────────────────────────────
def is_transient_error(e: BaseException) -> bool:
    if isinstance(e, asyncio.CancelledError):
        return False
    msg = str(e)
    if re.search(r"abort", msg, re.IGNORECASE):
        return False
    # Degeneration: retrying the identical prompt reproduces the identical
    # loop — burning 3 retries over ~10s of GPU time for nothing.
    if "repeating itself" in msg or "degeneration" in msg:
        return False
    if re.search(r"Ollama error \(4\d\d\)", msg):
        return False
    return bool(
        re.search(
            r"fetch failed|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|socket|network|Ollama error \(5\d\d\)|timed\s?out",
            msg,
            re.IGNORECASE,
        )
    )


def switch_action_protocol(state: dict[str, Any], opts: dict[str, Any], mode: str, reason: str) -> None:
    if state.get("mode") == mode:
        return
    state["mode"] = mode
    log_info(f"[agent] {reason}; using {mode} action format")
    _cb(opts, "onStage", "agent:retry")
    _cb(opts, "onNarration", f"{reason}. Trying {mode} tool-call format.")


def fallback_after_invalid_action(state: dict[str, Any], opts: dict[str, Any], reason: str) -> None:
    mode = state.get("mode")
    if mode == "native":
        switch_action_protocol(state, opts, "text" if opts.get("cloudEndpoint") else "structured", reason)
        state["invalidStructured"] = 0
        state["invalidStructuredLimit"] = 1
    elif mode == "structured":
        state["invalidStructured"] = state.get("invalidStructured", 0) + 1
        if state["invalidStructured"] >= state.get("invalidStructuredLimit", 2):
            switch_action_protocol(state, opts, "text", reason)


async def stream_chat_with_retry(
    opts: dict[str, Any],
    messages: list[dict[str, str]],
    on_chunk: Callable[[str], None],
    on_thinking_chunk: Callable[[str], None],
) -> str:
    max_attempts = int(opts.get("actionRetryLimit", 2)) + 1
    last_err: BaseException | None = None
    signal: asyncio.Event | None = opts.get("signal")
    for attempt in range(1, max_attempts + 1):
        buffered: list[str] = []
        buffered_thinking: list[str] = []
        # Live passthrough: thinking is ALSO forwarded to the client the moment
        # it arrives. Buffered copies are still replayed after the stream (for
        # the loop's own parsing), but the client no longer stares at silence
        # during multi-minute rounds on slow models.
        live_thinking = (opts.get("callbacks") or {}).get("onThinking")
        preparing_shown = False

        def content_tap(chunk: str) -> None:
            nonlocal preparing_shown
            if not preparing_shown:
                preparing_shown = True
                if opts.get("actionRound"):
                    _cb(opts, "onStage", "agent:preparing")
            buffered.append(chunk)

        def thinking_tap(t: str) -> None:
            buffered_thinking.append(t)
            if live_thinking:
                try:
                    live_thinking(t)
                except Exception:  # noqa: BLE001
                    pass

        try:
            stream_options = StreamOptions(
                    signal=signal,
                    temperature=opts.get("temperature"),
                    top_p=opts.get("top_p"),
                    max_tokens=opts.get("max_tokens"),
                    think=opts.get("think"),
                    on_thinking=thinking_tap,
                    base_url=opts.get("cloudEndpoint") or None,
                    api_key=opts.get("cloudApiKey") or None,
                    # Fires per completed stream; the client keeps overwriting
                    # its tok/s badge, so the FINAL iteration's stats are the
                    # ones left visible on the message.
                    on_metrics=(opts.get("callbacks") or {}).get("onMetrics"),
                )
            schemas = opts.get("toolSchemas")
            protocol = opts.get("protocolState") or {"mode": "native" if schemas else "text"}
            mode = protocol.get("mode", "text")
            if schemas and mode == "native":
                result = await stream_chat_with_tools(opts["model"], to_native_tool_history(messages), schemas, content_tap, stream_options)
                if result.get("toolsEnabled") is False:
                    # The capability cache was optimistic and Ollama rejected
                    # tools. Never treat its tool-less reply as a native call.
                    buffered.clear()
                    switch_action_protocol(protocol, opts, "structured" if not opts.get("cloudEndpoint") else "text", "This model does not accept native tools")
                    protocol["invalidStructuredLimit"] = 1
                    mode = protocol["mode"]
                calls = result.get("toolCalls") or []
                if calls:
                    try:
                        normalized = normalize_native_calls(calls, {tool["function"]["name"] for tool in schemas})
                    except ValueError as exc:
                        buffered = [f"[INVALID NATIVE TOOL CALL] {exc}"]
                    else:
                        # Only execute the validated native calls. Model prose
                        # can itself contain JSON-looking examples.
                        buffered = ["\n".join(json.dumps(c, ensure_ascii=False) for c in normalized)]
                elif mode == "native" and isinstance(opts.get("roundMeta"), dict):
                    # Text returned by the native API is prose, not an
                    # executable tool call, even if it contains JSON examples.
                    opts["roundMeta"]["structuredFinal"] = True
            if mode == "structured":
                stream_options.output_format = structured_action_schema({tool["function"]["name"] for tool in schemas})
                structured_messages = [{"role": "system", "content": build_structured_system_prompt(opts.get("workspacePath") or "workspace", opts.get("userName") or "a user", schemas)}, *messages]
                try:
                    await stream_chat(opts["model"], structured_messages, content_tap, stream_options)
                except OllamaError as exc:
                    message = str(exc).lower()
                    if not (re.search(r"\b(400|422|501)\b|unsupported|not support", message) and re.search(r"format|schema|structured|grammar|json", message)):
                        raise
                    buffered.clear()
                    switch_action_protocol(protocol, opts, "text", "This endpoint rejected structured output")
                    mode = "text"
                if mode == "structured":
                    try:
                        action = normalize_structured_action("".join(buffered), {tool["function"]["name"] for tool in schemas})
                    except ValueError as exc:
                        buffered = [f"[INVALID STRUCTURED ACTION] {exc}"]
                    else:
                        if action["action"] == "tool":
                            buffered = [json.dumps(action["call"], ensure_ascii=False)]
                        else:
                            buffered = [action["message"]]
                            if isinstance(opts.get("roundMeta"), dict):
                                opts["roundMeta"]["structuredFinal"] = True
            if mode == "text":
                stream_options.output_format = None
                legacy_prompt = build_system_prompt(opts.get("workspacePath") or "workspace", opts.get("userName") or "a user", opts.get("autoApply") is True)
                await stream_chat(opts["model"], [*messages, {"role": "system", "content": legacy_prompt}], content_tap, stream_options)
            out = "".join(buffered)
            for c in buffered:
                on_chunk(c)
            for t in buffered_thinking:
                on_thinking_chunk(t)
            return out
        except Exception as e:  # noqa: BLE001
            last_err = e
            if attempt >= max_attempts or not is_transient_error(e) or (signal is not None and signal.is_set()):
                raise
            delay = [1000, 3000, 7000][attempt - 1] if attempt - 1 < 3 else 5000
            _cb(opts, "onStage", "agent:retry")
            log_info(f"[agent] Transient model error ({e}) — retry {attempt}/{max_attempts - 1} in {delay}ms")
            await asyncio.sleep(delay / 1000)
    raise RuntimeError(f"streamChatWithRetry exhausted retries: {last_err}")


# ─── Context budget ─────────────────────────────────────────────────────
def estimate_tokens(text: str) -> int:
    return max(1, (len(text) + 3) // 4)


MAX_CONTEXT_TOKENS = 16000

# [image:data:...] markers carry base64 screenshots — they are NOT text tokens
# (Ollama receives them via the images array), so pruning must never truncate
# or count them as content.
_IMAGE_MARKER_RE = re.compile(r"\[image:data:image/[^;\]]+;base64,[^\]]+\]")


def prune_to_budget(msgs: list[dict[str, str]]) -> dict[str, Any]:
    # Split image markers out of every message first: prune the TEXT only,
    # then re-attach markers to whatever survives.
    work: list[dict[str, Any]] = []
    for m in msgs:
        content = m.get("content", "")
        images = _IMAGE_MARKER_RE.findall(content)
        if images:
            work.append({**m, "content": _IMAGE_MARKER_RE.sub("", content).strip(), "_imgs": images})
        else:
            work.append(dict(m))

    def _tok(x: dict[str, Any]) -> int:
        return max(1, (len(x["content"]) + 3) // 4)

    system = [x for x in work if x.get("role") == "system"]
    rest = [x for x in work if x.get("role") != "system"]
    total = sum(_tok(x) for x in system) + sum(_tok(x) for x in rest)
    original_tokens = total
    did_compact = False

    # Phase 1: Tool-result pruning — shrink verbose tool results before dropping messages
    if total > MAX_CONTEXT_TOKENS:
        for i, x in enumerate(rest):
            if x.get("role") == "user" and x["content"].startswith("[TOOL RESULT") and _tok(x) > 500:
                truncated = x["content"][:600] + "\n...[middle pruned to save context]...\n" + x["content"][-200:]
                total -= _tok(x) - estimate_tokens(truncated)
                rest[i] = {**x, "content": truncated}
                did_compact = True

    # Phase 2: Keep the beginning and end of large results rather than replacing
    # evidence with a claim that it was "processed".
    if total > MAX_CONTEXT_TOKENS:
        for i, x in enumerate(rest):
            if total <= MAX_CONTEXT_TOKENS:
                break
            if x.get("role") == "user" and x["content"].startswith("[TOOL RESULT") and _tok(x) > 200:
                orig = _tok(x)
                summary = x["content"][:500] + "\n...[middle omitted]...\n" + x["content"][-250:]
                total -= orig - estimate_tokens(summary)
                rest[i] = {**x, "content": summary}
                did_compact = True

    # Drop oldest messages if still over budget
    while len(rest) > 6 and total > MAX_CONTEXT_TOKENS:
        removed = rest.pop(0)
        total -= _tok(removed)
        did_compact = True

    # Re-attach image markers to surviving messages (converter turns them into
    # Ollama `images` entries; dropped messages lose their images with them).
    out = []
    for x in [*system, *rest]:
        imgs = x.pop("_imgs", None)
        if imgs:
            x = {**x, "content": x["content"] + "\n\n" + "\n\n".join(imgs)}
        out.append(x)
    return {
        "messages": out,
        "didCompact": did_compact,
        "tokensSaved": original_tokens - total,
        "originalTokens": original_tokens,
    }


def build_working_summary(history: list[dict[str, Any]], messages: list[dict[str, Any]], completed: list[str], plan: str) -> str:
    """Preserve verifiable task context when older loop messages are dropped."""
    user_messages = [_IMAGE_MARKER_RE.sub("[image omitted]", str(m.get("content") or "")) for m in messages if m.get("role") == "user"]
    parts = ["WORKING CONTEXT (earlier history was compacted; excerpts may be incomplete):"]
    if user_messages:
        parts.append("Original request: " + user_messages[0][:1500])
        if len(user_messages) > 1:
            parts.append("Latest user instruction: " + user_messages[-1][:1000])
    if plan:
        parts.append("Plan: " + plan[:1200])
    if completed:
        parts.append("Recorded completed steps: " + "; ".join(completed[-12:])[:1200])
    evidence = []
    for message in history:
        content = str(message.get("content") or "")
        if message.get("role") == "user" and content.startswith(("[TOOL RESULT", "[VERIFICATION RESULT", "[FINAL VERIFICATION", "[USER ANSWER")):
            evidence.append(content[:350])
    if evidence:
        parts.append("Recent tool and verification evidence (excerpts):\n" + "\n".join(evidence[-6:]))
    return "\n".join(parts)


# ─── ask_user (mid-task clarification) ──────────────────────────────────
_pending_questions: dict[str, dict[str, Any]] = {}


def resolve_pending_question(key: str, answer: str) -> bool:
    p = _pending_questions.get(key)
    if not p:
        return False
    _pending_questions.pop(key, None)
    if not p["future"].done():
        p["future"].set_result(answer)
    return True




# ─── Tool approval ──────────────────────────────────────────────────────
_pending_approvals: dict[str, dict[str, Any]] = {}


def resolve_pending_approval(key: str, approved: bool) -> bool:
    p = _pending_approvals.get(key)
    if not p:
        return False
    _pending_approvals.pop(key, None)
    if not p["future"].done():
        p["future"].set_result(approved)
    return True


async def wait_for_approval(key: str, signal: asyncio.Event | None) -> bool:
    future: asyncio.Future = asyncio.get_running_loop().create_future()
    _pending_approvals[key] = {"future": future}

    signal_task: asyncio.Task | None = None
    if signal is not None:
        if signal.is_set():
            _pending_approvals.pop(key, None)
            raise asyncio.CancelledError()
        signal_task = asyncio.create_task(signal.wait())

    try:
        if signal_task is not None:
            done, _ = await asyncio.wait({future, signal_task}, return_when=asyncio.FIRST_COMPLETED)
            if signal_task in done:
                _pending_approvals.pop(key, None)
                raise asyncio.CancelledError()
            return await future
        return await future
    finally:
        if signal_task is not None:
            signal_task.cancel()


def _cb(opts: dict[str, Any], name: str, *args: Any) -> None:
    """Call a callback from the callbacks dict if present."""
    callbacks = opts.get("callbacks") or {}
    fn = callbacks.get(name)
    if fn:
        try:
            fn(*args)
        except Exception as e:  # noqa: BLE001
            log_warn(f"[agent] callback {name} failed: {e}")


_pending_browser_actions: dict[str, dict[str, Any]] = {}


def resolve_browser_action(key: str, owner_id: str, result: dict[str, Any]) -> bool:
    pending = _pending_browser_actions.get(key)
    if not pending or pending["owner"] != owner_id or pending["future"].done():
        return False
    pending["future"].set_result(result)
    return True


async def request_browser_action(args: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    callback = (context.get("callbacks") or {}).get("onBrowserAction")
    if not callable(callback):
        return {"ok": False, "output": "The visible Koding browser is unavailable in this client."}
    key = secrets.token_urlsafe(24)
    future = asyncio.get_running_loop().create_future()
    _pending_browser_actions[key] = {"owner": context.get("userId"), "future": future}
    stop = context.get("signal")
    stopped = asyncio.create_task(stop.wait()) if stop is not None else None
    try:
        callback({"key": key, "sessionId": context["browserSession"],
                  "conversationId": context.get("conversationId"), "args": args})
        done, _ = await asyncio.wait({future, *([stopped] if stopped else [])}, timeout=30,
                                     return_when=asyncio.FIRST_COMPLETED)
        if stopped and stopped in done:
            raise asyncio.CancelledError()
        if future not in done:
            return {"ok": False, "output": "The desktop browser did not respond within 30 seconds."}
        result = future.result()
        output = str(result.get("output") or result.get("error") or "Browser action completed.")[:12000]
        response: dict[str, Any] = {"ok": result.get("ok") is True, "output": output}
        image = result.get("imageData")
        if args.get("operation") == "screenshot" and response["ok"]:
            if (context.get("use_vision_model") and isinstance(image, str)
                    and image.startswith(("data:image/png;base64,", "data:image/jpeg;base64,"))
                    and len(image) <= 4_000_000):
                response["imageData"] = image
                response["output"] += " The screenshot is attached."
            else:
                response["output"] += " The coding model cannot inspect this screenshot; use inspect for page text."
        return response
    finally:
        _pending_browser_actions.pop(key, None)
        if stopped:
            stopped.cancel()
        if not future.done():
            future.cancel()


# ─── Python interpreter discovery (for run_python) ──────────────────────
VIRTUALENV_PYTHON_RELPATHS = (
    r"venv\Scripts\python.exe",
    r".venv\Scripts\python.exe",
    r"env\Scripts\python.exe",
    "venv/bin/python",
    ".venv/bin/python",
)


def find_python_interpreter(root: str | None = None) -> list[str]:
    """Locate a usable Python interpreter for the run_python tool.

    Order: an explicit KASALIX_PYTHON override, a virtualenv INSIDE the
    workspace (so the project's own packages such as pygame are importable),
    the backend's own interpreter when it is a real (non-frozen) Python, then
    python/python3/py on PATH. Returns the argv PREFIX (e.g. ["py", "-3"]) —
    empty when none is found.
    """
    override = os.environ.get("KASALIX_PYTHON")
    if override and os.path.exists(override):
        return [override]
    if root:
        for rel in VIRTUALENV_PYTHON_RELPATHS:
            candidate = os.path.join(root, rel)
            if os.path.isfile(candidate):
                return [candidate]
    if not getattr(sys, "frozen", False) and sys.executable:
        return [sys.executable]
    for name in ("python", "python3"):
        found = shutil.which(name)
        if found:
            return [found]
    py = shutil.which("py")
    if py:
        return [py, "-3"]
    return []


# ─── Tool definitions (exposed to the model) ────────────────────────────
AGENT_TOOL_DEFS: list[dict[str, Any]] = [
    {"name": "list_files", "description": "List files and directories in the workspace (recursive, ignores node_modules/.git/dist etc). Use this to see what exists before editing.", "args": "{}", "mutating": False},
    {"name": "read_file", "description": "Read the contents of a file inside the workspace. Always read a file BEFORE editing it so you know exactly what is in it. Do NOT pass offset/length for normal files — read the whole file in one call; offset/length is ONLY for files larger than 200KB. Pass \"numbers\": true to get line numbers in front of each line (12| code) — needed for edit_lines; never copy those numbers into an edit's text.", "args": '{"path": "src/index.ts"} or {"path": "src/index.ts", "numbers": true} or {"path": "src/index.ts", "offset": 200000, "length": 100000}', "mutating": False},
    {"name": "search_files", "description": "Search workspace file contents for literal text, returning paths and line numbers. Matching is case-insensitive by default; set case_sensitive to true for an exact-case search. Results may include comments and strings, not just code references.", "args": '{"query": "function render"} or {"query": "render", "case_sensitive": true}', "mutating": False},
    {"name": "run_command", "description": "Run a shell command for testing or start a background server. Start: pass command, optional workspace-relative cwd, and background=true. Status: operation=status and process_id, optionally wait=0-10 seconds. Stop: operation=stop and process_id. timeout=1-600 seconds is optional; foreground defaults to 120 seconds. Background processes used for an open browser preview remain available to follow-up messages in this chat, otherwise they stop when the run ends. Do not daemonize. Check status and exit code: starting is not proof of success. Commands run with the server user's permissions, not in a sandbox.", "args": '{"command": "python -m pytest -q"} or {"command": "npm run dev", "background": true} or {"operation": "status", "process_id": "<id>", "wait": 3} or {"operation": "stop", "process_id": "<id>"}', "mutating": False},
    {"name": "browser", "description": "Control the visible Koding browser pane. For a static HTML page, use open with its workspace-relative path (or omit path to open index.html); Koding starts a local preview automatically. For an existing dev server, open its actual localhost URL. Use inspect to read page text and selectors, click or type with a selector, console for errors, screenshot if your model supports vision, and close when finished. Browser actions can change the app's data.", "args": '{"operation": "open", "path": "index.html"} or {"operation": "open", "url": "http://127.0.0.1:3000/"} or {"operation": "inspect"} or {"operation": "click", "selector": "button"} or {"operation": "type", "selector": "input", "text": "hello"} or {"operation": "screenshot"} or {"operation": "console"}', "mutating": False},
    {"name": "edit_file", "description": "SURGICAL edit of an existing file: replace an exact snippet (old_string) with new content (new_string). Use this for SMALL changes to existing files instead of rewriting the whole file. old_string must appear exactly once in the file (or differ only in whitespace). ONLY available in auto-apply mode. After a successful edit the result includes a diff summary.", "args": '{"path": "src/app.ts", "old_string": "const x = 1;", "new_string": "const x = 2;"}', "mutating": True},
    {"name": "edit_lines", "description": "Edit an existing file BY LINE NUMBER — replaces lines start..end with content, so you NEVER copy the old text. This is the easiest way to change a few lines, a loop, or one statement inside a file you have read. start/end are 1-based line numbers (from read_file with \"numbers\": true); omit end to change one line; make end smaller than start to INSERT before start; negative counts from the end (-1 = last line); content \"\" deletes those lines. Pass expect (the first line being replaced, copied from the file) and the edit is refused if the numbers are stale. ONLY available in auto-apply mode.", "args": '{"path": "snake.py", "start": 42, "end": 48, "content": "    new_line_1\\n    new_line_2", "expect": "    def update(self):"}', "mutating": True},
    {"name": "write_file", "description": "Create a NEW file. If the file already exists, only YOUR CHANGED LINES are applied and everything else in the file is preserved exactly (safe to pass the full new file content — a version that rewrites most of the file is refused). ONLY available in auto-apply mode — the file is written immediately and can be reverted by the user.", "args": '{"path": "src/app.ts", "content": "..."}', "mutating": True},
    {"name": "delete_file", "description": "Delete a file inside the workspace. ONLY available in auto-apply mode — the deletion happens immediately and can be reverted by the user.", "args": '{"path": "src/old.ts"}', "mutating": True},
    {"name": "rename_file", "description": "Rename or move a file inside the workspace. The original file is deleted and the new path is created with the same content. Both paths must be inside the workspace. Can be reverted by the user.", "args": '{"from": "src/old.ts", "to": "src/new.ts"}', "mutating": True},
    {"name": "glob", "description": "Fast file pattern matching. Find files by name/extension pattern (e.g. \"**/*.tsx\", \"src/**/*.ts\", \"*.json\"). Returns matching paths sorted by modification time. ALWAYS use this instead of list_files when searching for files by extension or name pattern — it is much faster.", "args": '{"pattern": "**/*.py"}', "mutating": False},
]

TOOL_JSON_EXAMPLES = f"""Available tools — to use one, respond with ONLY a single JSON object, no markdown, no other text:

{{"tool": "list_files", "args": {{}}}}
{{"tool": "read_file", "args": {{"path": "src/index.ts"}}}}
{{"tool": "read_file", "args": {{"path": "src/index.ts", "numbers": true}}}} — line numbers in front of each line (12| code) for use with edit_lines
{{"tool": "search_files", "args": {{"query": "function render"}}}}
{{"tool": "run_command", "args": {{"command": "python -m pytest -q", "cwd": ".", "timeout": 120}}}}
{{"tool": "run_command", "args": {{"command": "npm run dev", "background": true}}}} — start a background server; use the returned process_id
{{"tool": "run_command", "args": {{"operation": "status", "process_id": "<id>", "wait": 3}}}} — inspect status and output
{{"tool": "run_command", "args": {{"operation": "stop", "process_id": "<id>"}}}} — stop the process
{{"tool": "browser", "args": {{"operation": "open", "path": "index.html"}}}} — automatically serve and open a static page
{{"tool": "browser", "args": {{"operation": "open", "url": "http://127.0.0.1:3000/"}}}} — open an existing local server
{{"tool": "browser", "args": {{"operation": "inspect"}}}} — read page text and selectors before interacting
{{"tool": "edit_file", "args": {{"path": "src/app.ts", "old_string": "const x = 1;", "new_string": "const x = 2;"}}}}
{{"tool": "edit_lines", "args": {{"path": "snake.py", "start": 42, "end": 48, "content": "    new_line_1\\n    new_line_2"}}}} — change lines BY NUMBER (read_file with "numbers": true); no old text needed
{{"tool": "write_file", "args": {{"path": "src/app.ts", "content": "..."}}}} — for an EXISTING file only your changed lines are applied; the rest is preserved
{{"tool": "delete_file", "args": {{"path": "src/old.ts"}}}}
{{"tool": "rename_file", "args": {{"from": "src/old.ts", "to": "src/new.ts"}}}}
{{"tool": "glob", "args": {{"pattern": "**/*.py"}}}}
{{"tool": "glob", "args": {{"pattern": "src/**/*.tsx"}}}}
"""


# ─── Workspace listing ──────────────────────────────────────────────────
async def list_workspace_tree(root: str) -> str:
    lines: list[str] = []
    limited = False

    async def walk(dir: str, depth: int) -> None:
        nonlocal limited
        if depth > 3 or len(lines) >= 400:
            limited = True
            return
        if is_protected_path(root, dir):
            return
        try:
            entries = os.listdir(dir)
        except OSError:
            return
        entries.sort(key=lambda n: (not os.path.isdir(os.path.join(dir, n)), n.lower()))
        for name in entries:
            if len(lines) >= 400:
                limited = True
                return
            if name.startswith(".") or name in IGNORE_DIRS:
                continue
            full = os.path.join(dir, name)
            if is_protected_path(root, full) or os.path.islink(full):
                continue
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            if os.path.isdir(full):
                lines.append("  " * depth + rel + "/")
                await walk(full, depth + 1)
            else:
                size = ""
                try:
                    s = os.path.getsize(full)
                    size = f" ({s}B)" if s < 1024 else f" ({s / 1024:.1f}KB)"
                except OSError:  # noqa: S110
                    pass
                lines.append("  " * depth + rel + size)

    await walk(root, 0)
    result = "\n".join(lines) if lines else "(empty workspace)"
    return result + ("\n[Listing may be incomplete: depth or 400-entry limit reached.]" if limited else "")


# ─── Workspace profile ──────────────────────────────────────────────────
LANGUAGE_EXT_MAP: dict[str, str] = {
    "py": "Python", "ts": "TypeScript", "tsx": "TypeScript/React", "js": "JavaScript", "jsx": "JavaScript/React",
    "c": "C", "h": "C/C++", "cpp": "C++", "hpp": "C++", "cs": "C#", "java": "Java", "kt": "Kotlin",
    "go": "Go", "rs": "Rust", "rb": "Ruby", "php": "PHP", "swift": "Swift",
    "html": "HTML", "css": "CSS", "scss": "SCSS", "vue": "Vue", "svelte": "Svelte",
    "sql": "SQL", "sh": "Shell", "bat": "Batch", "ps1": "PowerShell",
}

PROJECT_MARKERS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"^requirements\.txt$", re.I), "Python (requirements.txt)"),
    (re.compile(r"^pyproject\.toml$", re.I), "Python (pyproject.toml)"),
    (re.compile(r"^setup\.py$", re.I), "Python (setup.py)"),
    (re.compile(r"^Pipfile$", re.I), "Python (Pipfile)"),
    (re.compile(r"^manage\.py$", re.I), "Python/Django (manage.py)"),
    (re.compile(r"^package\.json$", re.I), "JavaScript/Node (package.json)"),
    (re.compile(r"^tsconfig\.json$", re.I), "TypeScript (tsconfig.json)"),
    (re.compile(r"^go\.mod$", re.I), "Go (go.mod)"),
    (re.compile(r"^Cargo\.toml$", re.I), "Rust (Cargo.toml)"),
    (re.compile(r"^pom\.xml$", re.I), "Java/Maven (pom.xml)"),
    (re.compile(r"^build\.gradle$", re.I), "Java/Gradle (build.gradle)"),
    (re.compile(r"^Gemfile$", re.I), "Ruby (Gemfile)"),
    (re.compile(r"^composer\.json$", re.I), "PHP (composer.json)"),
    (re.compile(r"^index\.html$", re.I), "Web (index.html)"),
]


async def detect_project_profile(root: str) -> dict[str, Any]:
    counts: dict[str, int] = {}
    key_files: list[str] = []
    marker_label: str | None = None

    async def walk(dir: str, depth: int) -> None:
        nonlocal marker_label
        if depth > 4 or len(key_files) > 25:
            return
        if is_protected_path(root, dir):
            return
        try:
            entries = os.listdir(dir)
        except OSError:
            return
        for name in entries:
            if name.startswith(".") or name in IGNORE_DIRS:
                continue
            full = os.path.join(dir, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            if os.path.isdir(full):
                await walk(full, depth + 1)
                continue
            ext = (name.split(".").pop() or "").lower() if "." in name else ""
            if ext and ext != name.lower():
                counts[ext] = counts.get(ext, 0) + 1
            if marker_label is None:
                for pattern, label in PROJECT_MARKERS:
                    if pattern.search(name):
                        marker_label = label
                        break
            if marker_label and len(key_files) < 15:
                key_files.append(f"{rel} ({name})")
            elif ext in LANGUAGE_EXT_MAP and len(key_files) < 15:
                key_files.append(rel)

    await walk(root, 0)

    extensions = [
        {"ext": ext, "count": count, "label": LANGUAGE_EXT_MAP[ext]}
        for ext, count in sorted(counts.items(), key=lambda kv: -kv[1])[:3]
        if ext in LANGUAGE_EXT_MAP
    ]
    language = marker_label or (extensions[0]["label"] if extensions else None)
    seen: set[str] = set()
    key_files_deduped: list[str] = []
    for k in key_files:
        if k not in seen:
            seen.add(k)
            key_files_deduped.append(k)
    return {"language": language, "extensions": extensions, "keyFiles": key_files_deduped[:20]}


async def build_workspace_profile(
    root: str,
    verify_command: str | None = None,
    project_rules: str | None = None,
    agent_memory: str | None = None,
    project_config: str | None = None,
) -> str:
    profile = await detect_project_profile(root)
    lines: list[str] = ["WORKSPACE PROFILE (read this — it tells you what kind of project this is):"]
    if profile["language"]:
        lines.append(f"- Project language: {profile['language']}")
    else:
        lines.append("- Project language: unknown — use list_files + read_file to determine it before making changes")
    if profile["extensions"]:
        ext_summary = ", ".join(f"{e['label']} (.{e['ext']} × {e['count']})" for e in profile["extensions"])
        lines.append(f"- Source files: {ext_summary}")
    if profile["keyFiles"]:
        lines.append("- Key files: " + ", ".join(profile["keyFiles"][:12]))
    if verify_command:
        lines.append(f"- Verify command: {verify_command} (auto-run before the final answer when files change)")
    lines.append(
        f"- User rules: {project_rules if project_rules else 'none yet — the user can create .agent-rules.md for standing instructions'}"
    )
    lines.append(
        f"- Agent memory: {agent_memory if agent_memory else 'none'}"
    )
    lines.append(f"- PROTECTED directories (never access): {protected_dirs_label(root)}")
    lines.append("- RULE: Match the project language above for ALL new or edited files. Do NOT create files in a different language than the project unless the user explicitly asks for that language.")
    if project_config:
        lines.append("\n" + project_config)
    return "\n".join(lines)


def summarize_diff(path: str, old_content: str, new_content: str) -> str:
    old_lines = old_content.replace("\r\n", "\n").split("\n")
    new_lines = new_content.replace("\r\n", "\n").split("\n")
    hunks = diff_lines(old_lines, new_lines)
    if hunks is None:
        return f"Diff for {path}: (files differ too much to summarize) — read the file and re-apply your change as a targeted edit."
    parts: list[str] = []
    changed = 0
    cap = 30
    for h in hunks:
        changed += max(h["oldCount"], h["newCount"])
        for i in range(h["oldCount"]):
            if len(parts) >= cap:
                parts.append("  ... (more)")
                break
            parts.append(f"- {old_lines[h['oldStart'] + i]}")
        if len(parts) >= cap:
            break
        for i in range(h["newCount"]):
            if len(parts) >= cap:
                parts.append("  ... (more)")
                break
            parts.append(f"+ {new_lines[h['newStart'] + i]}")
    return f"Diff for {path} ({changed} changed line(s)):\n" + ("\n".join(parts) or "  (no changes)")


# ─── Verify command detection ───────────────────────────────────────────
async def detect_verify_command(root: str) -> dict[str, Any] | None:
    # Per-workspace override via .agent-config.json
    try:
        cfg = json.loads((Path(root) / ".agent-config.json").read_text(encoding="utf-8"))
        if cfg and cfg.get("verifyEnabled") is False:
            return None
        if cfg and isinstance(cfg.get("verifyCommand"), str) and cfg["verifyCommand"].strip():
            label = cfg.get("verifyLabel")
            return {
                "command": cfg["verifyCommand"].strip(),
                "label": label if isinstance(label, str) and label.strip() else "custom verify",
                "isTest": False,
            }
    except OSError:  # noqa: S110
        pass
    except json.JSONDecodeError:  # noqa: S110
        pass

    candidates: list[dict[str, Any]] = []

    # Node: package.json scripts (test > build)
    try:
        pkg = json.loads((Path(root) / "package.json").read_text(encoding="utf-8"))
        scripts = pkg.get("scripts") or {}
        if isinstance(scripts.get("test"), str):
            candidates.append({"command": f'npm test --prefix "{root}"', "label": "npm test", "isTest": True})
        elif isinstance(scripts.get("build"), str):
            candidates.append({"command": f'npm run build --prefix "{root}"', "label": "npm run build", "isTest": False})
    except OSError:  # noqa: S110
        pass
    except json.JSONDecodeError:  # noqa: S110
        pass

    # Python
    py_env: str | None = None
    for p in ("venv", ".venv"):
        bin_dir = Path(root) / p / ("Scripts" if sys.platform == "win32" else "bin")
        exe = bin_dir / ("python.exe" if sys.platform == "win32" else "python")
        if exe.is_file():
            py_env = str(exe)
            break
    py_cmd = f'"{py_env}"' if py_env else "python"
    has_py_tests = (Path(root) / "tests").is_dir()
    if not has_py_tests:
        for f in ("pytest.ini", "setup.cfg", "pyproject.toml"):
            try:
                if re.search(r"pytest", (Path(root) / f).read_text(encoding="utf-8"), re.I):
                    has_py_tests = True
                    break
            except OSError:  # noqa: S110
                pass
    if has_py_tests:
        candidates.append({"command": f"{py_cmd} -m pytest -q", "label": "pytest", "isTest": True})
        candidates.append({"command": f"{py_cmd} -m unittest discover -q", "label": "unittest", "isTest": True})
    else:
        py_main = await find_main_script(root, [".py"])
        if py_main:
            candidates.append({"command": f'{py_cmd} -m py_compile "{py_main}"', "label": "python syntax check", "isTest": False})

    # Node without scripts → syntax check
    if not (Path(root) / "package.json").is_file():
        js_main = await find_main_script(root, [".js", ".mjs", ".cjs"])
        if js_main:
            candidates.append({"command": f'node --check "{js_main}"', "label": "node syntax check", "isTest": False})

    if (Path(root) / "Cargo.toml").is_file():
        candidates.append({"command": "cargo test", "label": "cargo test", "isTest": True})
    if (Path(root) / "go.mod").is_file():
        candidates.append({"command": "go test ./...", "label": "go test", "isTest": True})
    if (Path(root) / "Makefile").is_file():
        candidates.append({"command": "make test", "label": "make test", "isTest": True})

    chosen = (
        next((c for c in candidates if c["isTest"] and c["label"] == "npm test"), None)
        or next((c for c in candidates if c["label"] == "npm run build"), None)
        or next((c for c in candidates if c["label"] in ("pytest", "unittest")), None)
        or next((c for c in candidates if c["label"] == "python syntax check"), None)
        or next((c for c in candidates if c["label"] == "node syntax check"), None)
        or next((c for c in candidates if c["isTest"]), None)
    )
    return chosen


async def detect_verify_for_paths(root: str, paths: set[str]) -> list[dict[str, Any]]:
    """Choose checks from the nearest project root for each changed file."""
    root_path = Path(root).resolve()
    try:
        config = json.loads((root_path / ".agent-config.json").read_text(encoding="utf-8"))
        if config.get("verifyEnabled") is False:
            return []
        if config.get("verifyCommand"):
            explicit = await detect_verify_command(str(root_path))
            return [{**explicit, "cwd": str(root_path)}] if explicit else []
    except (OSError, ValueError, AttributeError):
        pass
    roots: set[Path] = set()
    manifests = ("package.json", "pyproject.toml", "pytest.ini", "Cargo.toml", "go.mod", "Makefile")
    for path in paths:
        target = Path(path)
        target = target if target.is_absolute() else root_path / target
        try:
            directory = target.resolve().parent
            directory.relative_to(root_path)
        except ValueError:
            continue
        while directory != root_path and not any((directory / name).is_file() for name in manifests):
            directory = directory.parent
        roots.add(directory)
    checks = []
    for directory in sorted(roots, key=str):
        check = await detect_verify_command(str(directory))
        if check:
            checks.append({**check, "cwd": str(directory)})
    return checks


async def find_main_script(root: str, extensions: list[str]) -> str | None:
    wanted = {e.lower() for e in extensions}
    matches: list[str] = []
    preferred = {"main", "index", "app"}

    async def walk(dir: str, depth: int) -> None:
        if depth > 3 or len(matches) >= 20:
            return
        if is_protected_path(root, dir):
            return
        try:
            entries = os.listdir(dir)
        except OSError:
            return
        for name in entries:
            if name.startswith(".") or name in IGNORE_DIRS:
                continue
            full = os.path.join(dir, name)
            if os.path.isdir(full):
                await walk(full, depth + 1)
            else:
                ext = (name.split(".").pop() or "").lower() if "." in name else ""
                if ext not in wanted:
                    continue
                stem = name.rsplit(".", 1)[0].lower()
                if stem in preferred and len(matches) < 3:
                    matches.insert(0, full)
                else:
                    matches.append(full)

    await walk(root, 0)
    return matches[0] if matches else None


# ─── Vision description ─────────────────────────────────────────────────


# ─── Git helpers ────────────────────────────────────────────────────────
MUTATING_TOOLS = {tool["name"] for tool in AGENT_TOOL_DEFS if tool["mutating"]}
EXECUTION_TOOLS = {"run_command", "browser"}


async def authorize_tool_calls(
    calls: list[dict[str, Any]], opts: dict[str, Any], signal: asyncio.Event | None,
    session_log: SessionLog,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Return only calls that may actually execute and feedback for the model."""
    import random

    mode = opts.get("toolPermission") or "auto"
    approved_calls: list[dict[str, Any]] = []
    feedback: list[str] = []
    for call in calls:
        name = call["tool"]
        unsafe = name in MUTATING_TOOLS | EXECUTION_TOOLS
        blocked = name not in {tool["name"] for tool in AGENT_TOOL_DEFS} or (mode == "read-only" and unsafe)
        if blocked:
            reason = "Blocked by the selected permission mode"
        else:
            needs_approval = mode in ("ask-each", "suggest") or (mode == "auto-edit" and name in EXECUTION_TOOLS)
            if needs_approval:
                key = f"approval-{int(time.time() * 1000)}-{''.join(random.choices('abcdefghijklmnopqrstuvwxyz0123456789', k=6))}"
                _cb(opts, "onApprovalRequest", key, name, call["args"])
                _cb(opts, "onStage", "agent:waiting")
                reason = "Denied by user" if not await wait_for_approval(key, signal) else ""
            else:
                reason = ""
        if reason:
            feedback.append(f"[TOOL BLOCKED — {name}] {reason}. Do not assume this call ran.")
            await session_log.log_tool_result(name, reason, False)
        else:
            approved_calls.append(call)
    return approved_calls, feedback

# Tools that REUSE an existing no-op call. The identical-call guard counts
# ALL repeats of the same call — but "already has exactly this content" is a
# SUCCESS, so the model must not be punished for repeating it (that exact
# false give-up shipped to a user: two write_file calls, second returned
# no-op, guard tripped with "kept failing the same way" for a call that
# never failed).
NOOP_OK_TOOLS = {"write_file", "edit_lines"}


def process_group_options() -> dict[str, Any]:
    return {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if sys.platform == "win32" else {"start_new_session": True}


async def kill_process_tree(proc: asyncio.subprocess.Process) -> None:
    """Stop the process group started for an agent command."""
    if proc.returncode is not None:
        return
    try:
        if sys.platform == "win32":
            killer = await asyncio.create_subprocess_exec("taskkill", "/PID", str(proc.pid), "/T", "/F", stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            await asyncio.wait_for(killer.wait(), timeout=5)
        else:
            os.killpg(proc.pid, signal_module.SIGKILL)
    except (OSError, ProcessLookupError, asyncio.TimeoutError):
        pass
    if proc.returncode is None:
        try:
            proc.kill()
        except (OSError, ProcessLookupError):
            pass
    try:
        await asyncio.wait_for(proc.wait(), timeout=5)
    except (OSError, asyncio.TimeoutError):
        pass


async def communicate_with_stop(proc: asyncio.subprocess.Process, timeout: float, stop: asyncio.Event | None = None, input: bytes | None = None) -> tuple[bytes, bytes]:
    communication = asyncio.create_task(proc.communicate(input=input) if input is not None else proc.communicate())
    stopped = asyncio.create_task(stop.wait()) if stop is not None else None
    try:
        done, _ = await asyncio.wait({communication, *([stopped] if stopped else [])}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
        if stopped and stopped in done:
            raise asyncio.CancelledError()
        if communication not in done:
            raise asyncio.TimeoutError()
        return communication.result()
    except (asyncio.TimeoutError, asyncio.CancelledError):
        await kill_process_tree(proc)
        communication.cancel()
        await asyncio.gather(communication, return_exceptions=True)
        raise
    finally:
        if stopped:
            stopped.cancel()


async def collect_command_output(
    proc: asyncio.subprocess.Process, timeout: int, stop: asyncio.Event | None,
) -> dict[str, Any]:
    """Drain both pipes while retaining a bounded tail, and stop the process on timeout/cancel."""
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    sizes = {"stdout": 0, "stderr": 0}
    limits = {"stdout": 6000, "stderr": 2000}

    async def drain(name: str, stream: asyncio.StreamReader | None) -> None:
        if stream is None:
            return
        while chunk := await stream.read(8192):
            sizes[name] += len(chunk)
            buffers[name].extend(chunk)
            if len(buffers[name]) > limits[name]:
                del buffers[name][:-limits[name]]

    async def finish() -> None:
        await asyncio.gather(proc.wait(), drain("stdout", proc.stdout), drain("stderr", proc.stderr))

    finished = asyncio.create_task(finish())
    stopped = asyncio.create_task(stop.wait()) if stop is not None else None
    timed_out = False

    async def stop_and_drain() -> None:
        await kill_process_tree(proc)
        try:
            await asyncio.wait_for(asyncio.shield(finished), timeout=3)
        except Exception:  # cleanup must not hide the original stop
            finished.cancel()
            await asyncio.gather(finished, return_exceptions=True)

    try:
        done, _ = await asyncio.wait(
            {finished, *([stopped] if stopped else [])}, timeout=timeout,
            return_when=asyncio.FIRST_COMPLETED,
        )
        if stopped is not None and stopped in done:
            raise asyncio.CancelledError()
        if finished not in done:
            timed_out = True
            await stop_and_drain()
        else:
            finished.result()
    except asyncio.CancelledError:
        await stop_and_drain()
        raise
    except Exception:
        await stop_and_drain()
        raise
    finally:
        if stopped:
            stopped.cancel()

    parts = [f"Command timed out after {timeout} seconds." if timed_out else f"Exit code: {proc.returncode}"]
    for name in ("stdout", "stderr"):
        if sizes[name]:
            note = f" (truncated; showing last {len(buffers[name])} of {sizes[name]} bytes)" if sizes[name] > len(buffers[name]) else ""
            parts.append(f"{name}{note}:\n{bytes(buffers[name]).decode('utf-8', 'replace')}")
    return {"ok": not timed_out and proc.returncode == 0, "output": "\n".join(parts)}


class BackgroundCommandManager:
    """Own background commands for a single agent run; never share handles between runs."""

    def __init__(self) -> None:
        self.processes: dict[str, dict[str, Any]] = {}
        self.closed = False

    async def start(self, command: str, cwd: str, timeout: int | None) -> dict[str, Any]:
        if self.closed:
            return {"ok": False, "output": "This agent run has ended."}
        # Bound both process count and retained records; evict completed records first.
        for process_id in list(self.processes):
            if len(self.processes) < 8:
                break
            if self.processes[process_id]["done"]:
                del self.processes[process_id]
        if len(self.processes) >= 8:
            return {"ok": False, "output": "Background process limit reached (8). Stop a process before starting another."}
        proc = await asyncio.create_subprocess_shell(
            command, cwd=cwd, stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            **process_group_options(),
        )
        process_id = "bg-" + secrets.token_hex(8)
        entry: dict[str, Any] = {
            "proc": proc, "done": False, "stopped": False, "timed_out": False,
            "buffers": {"stdout": bytearray(), "stderr": bytearray()},
            "sizes": {"stdout": 0, "stderr": 0}, "changed": asyncio.Event(), "lock": asyncio.Lock(),
        }
        self.processes[process_id] = entry
        entry["command"] = command
        entry["cwd"] = cwd

        async def drain(name: str, stream: asyncio.StreamReader | None, limit: int) -> None:
            if stream is None:
                return
            while chunk := await stream.read(8192):
                entry["sizes"][name] += len(chunk)
                buffer = entry["buffers"][name]
                buffer.extend(chunk)
                if len(buffer) > limit:
                    del buffer[:-limit]
                entry["changed"].set()

        async def pump() -> None:
            try:
                await asyncio.gather(proc.wait(), drain("stdout", proc.stdout, 6000), drain("stderr", proc.stderr, 2000))
            except Exception as exc:
                entry["error"] = str(exc)
                raise
            finally:
                entry["done"] = True
                entry["changed"].set()

        entry["task"] = asyncio.create_task(pump())
        if timeout is not None:
            async def watch_timeout() -> None:
                try:
                    await asyncio.wait_for(asyncio.shield(entry["task"]), timeout)
                except asyncio.TimeoutError:
                    entry["timed_out"] = True
                    await self._stop(entry)
            entry["watchdog"] = asyncio.create_task(watch_timeout())
        return {"ok": True, "process_id": process_id,
                "output": f"Started background process {process_id}. Use operation=status to inspect its output and exit code; starting does not mean it is ready."}

    async def _stop(self, entry: dict[str, Any]) -> bool:
        async with entry["lock"]:
            if entry["proc"].returncode is None:
                await kill_process_tree(entry["proc"])
            try:
                await asyncio.wait_for(asyncio.shield(entry["task"]), 3)
            except Exception:
                entry["task"].cancel()
                await asyncio.gather(entry["task"], return_exceptions=True)
                return False
            return entry["proc"].returncode is not None

    async def status(self, process_id: str, wait: int = 0) -> dict[str, Any]:
        entry = self.processes.get(process_id)
        if entry is None:
            return {"ok": False, "output": f"No background process {process_id} in this agent run."}
        if wait and not entry["done"]:
            entry["changed"].clear()
            try:
                await asyncio.wait_for(entry["changed"].wait(), wait)
            except asyncio.TimeoutError:
                pass
        proc = entry["proc"]
        if entry["timed_out"]:
            state = "timed out"
        elif entry.get("error"):
            state = f"output collection failed: {entry['error']}"
        elif entry["stopped"]:
            state = f"stopped (exit code {proc.returncode})"
        elif entry["done"]:
            state = f"exited with code {proc.returncode}"
        else:
            state = "running"
        parts = [f"Background process {process_id}: {state}."]
        for name in ("stdout", "stderr"):
            buffer = entry["buffers"][name]
            size = entry["sizes"][name]
            if size:
                note = f" (truncated; showing last {len(buffer)} of {size} bytes)" if size > len(buffer) else ""
                parts.append(f"{name}{note}:\n{bytes(buffer).decode('utf-8', 'replace')}")
        return {"ok": not entry["timed_out"] and not entry.get("error") and (not entry["done"] or entry["stopped"] or proc.returncode == 0),
                "process_id": process_id, "output": "\n".join(parts)}

    async def stop(self, process_id: str) -> dict[str, Any]:
        entry = self.processes.get(process_id)
        if entry is None:
            return {"ok": False, "output": f"No background process {process_id} in this agent run."}
        if not entry["done"] or entry["proc"].returncode is None:
            if not await self._stop(entry):
                return {"ok": False, "output": f"Could not confirm that background process {process_id} and its output streams stopped."}
            entry["stopped"] = True
        return await self.status(process_id)

    async def close(self) -> None:
        self.closed = True
        outcomes = await asyncio.gather(*(self._stop(entry) for entry in self.processes.values()), return_exceptions=True)
        if any(outcome is not True for outcome in outcomes):
            log_warn("[agent] Could not confirm cleanup of every background command process.")
        watchdogs = [entry["watchdog"] for entry in self.processes.values() if "watchdog" in entry]
        for task in watchdogs:
            task.cancel()
        await asyncio.gather(*watchdogs, return_exceptions=True)


# A preview needs to survive a completed answer so a follow-up can use it.
# Only runs that actually opened a browser keep their managed processes alive.
_conversation_resources: dict[tuple[str, str], dict[str, Any]] = {}
CONVERSATION_IDLE_SECONDS = 30 * 60


async def acquire_conversation_resources(owner: str | None, conversation: str | None, root: str) -> tuple[tuple[str, str] | None, dict[str, Any]]:
    key = (owner, conversation) if owner and conversation else None
    entry = _conversation_resources.get(key) if key else None
    if entry and entry["root"] != os.path.realpath(root):
        await close_conversation_resources(owner, conversation)
        entry = None
    if entry is None:
        entry = {"root": os.path.realpath(root), "manager": BackgroundCommandManager(),
                 "browser_session": secrets.token_urlsafe(18), "browser": {"open": False}, "preview": None, "active": 0, "expiry": None, "closed": False}
        if key:
            _conversation_resources[key] = entry
    expiry = entry.get("expiry")
    if expiry and not expiry.done():
        expiry.cancel()
    entry["expiry"] = None
    entry["active"] += 1
    return key, entry


async def release_conversation_resources(key: tuple[str, str] | None, entry: dict[str, Any], *, cancelled: bool = False) -> None:
    entry["active"] = max(0, entry["active"] - 1)
    if entry["active"]:
        return
    if key is None or cancelled or entry["closed"] or not entry["browser"]["open"]:
        if key and _conversation_resources.get(key) is entry:
            _conversation_resources.pop(key, None)
        await dispose_conversation_resources(entry)
        return
    async def expire() -> None:
        await asyncio.sleep(CONVERSATION_IDLE_SECONDS)
        if _conversation_resources.get(key) is entry and entry["active"] == 0:
            _conversation_resources.pop(key, None)
            await dispose_conversation_resources(entry)
    entry["expiry"] = asyncio.create_task(expire())


async def close_conversation_resources(owner: str | None, conversation: str | None) -> None:
    if not owner or not conversation:
        return
    entry = _conversation_resources.pop((owner, conversation), None)
    if entry:
        entry["closed"] = True
        entry["browser"]["open"] = False
        if entry.get("expiry"):
            entry["expiry"].cancel()
        await dispose_conversation_resources(entry)


async def dispose_conversation_resources(entry: dict[str, Any]) -> None:
    try:
        if entry.get("preview"):
            await entry["preview"].close()
            entry["preview"] = None
    finally:
        await entry["manager"].close()


async def close_all_conversation_resources() -> None:
    keys = list(_conversation_resources)
    await asyncio.gather(*(close_conversation_resources(*key) for key in keys), return_exceptions=True)






# ─── Sub-agent delegation ───────────────────────────────────────────────


# ─── Tool execution ─────────────────────────────────────────────────────
async def execute_tool(
    root: str,
    call: dict[str, Any],
    auto_apply: bool,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    args = call.get("args") or {}
    tool = call["tool"]

    async def deny_out(msg: str) -> dict[str, Any]:
        return {"ok": False, "output": msg}

    # Game replay is an automatic verification path, not a model-facing tool.
    if tool not in {item["name"] for item in AGENT_TOOL_DEFS} and not (tool == "play_game" and (extra or {}).get("game_auto") is True):
        return await deny_out(f'Unknown or unavailable tool: "{tool}".')

    if tool == "browser":
        evidence = (extra or {}).get("browser_evidence")
        if (extra or {}).get("resources", {}).get("closed"):
            return await deny_out("The user closed this browser preview. Start a new message to open it again.")
        error = validate_browser_args(args)
        if error:
            if isinstance(evidence, dict) and args.get("operation") in ("click", "type"):
                evidence["failed_interaction"] = True
            return await deny_out(error)
        if isinstance(evidence, dict) and args["operation"] in ("click", "type") and not evidence["inspected"]:
            evidence["failed_interaction"] = True
            return await deny_out("Inspect the current page with browser {\"operation\":\"inspect\"} before clicking or typing; use a visible element and its selector from the result.")
        preview = None
        request = dict(args)
        if args["operation"] == "open":
            if "url" not in args:
                resources = (extra or {}).get("resources")
                if not resources:
                    return await deny_out("Static previews are only available during a Koding run.")
                path = args.get("path") or "index.html"
                target = await resolve_in_workspace(root, path)
                if target and os.path.isdir(target):
                    target = await resolve_in_workspace(root, os.path.join(path, "index.html"))
                if target and not os.path.isfile(target) and "path" not in args:
                    candidates = await find_workspace_files_by_basename(root, "index.html")
                    if len(candidates) > 1:
                        return await deny_out("Multiple index.html files found. Use list_files or glob and pass the desired path.")
                    target = await resolve_in_workspace(root, os.path.relpath(candidates[0], root)) if candidates else None
                if not target or not os.path.isfile(target) or not target.lower().endswith((".html", ".htm")):
                    return await deny_out(f"Cannot preview {path}: provide an existing workspace HTML file.")
                if is_user_rules_path(root, target):
                    return await deny_out("Cannot preview a protected rules file.")
                from .static_preview import StaticPreview
                try:
                    preview = StaticPreview(root, target, is_user_rules_path)
                except OSError as exc:
                    return await deny_out(f"Could not start the static preview server: {exc}")
                request.pop("path", None)
                request["url"] = preview.url
            try:
                url = urlsplit(request["url"])
                if url.scheme.lower() not in ("http", "https") or url.hostname not in ("localhost", "127.0.0.1", "::1") or url.username is not None or url.password is not None:
                    return await deny_out("The Koding browser only opens local HTTP(S) URLs without credentials.")
                _ = url.port  # reject invalid ports
            except ValueError:
                return await deny_out("Invalid browser URL.")
        try:
            result = await request_browser_action(request, extra or {})
        except BaseException:
            if preview:
                await preview.close()
            raise
        if (extra or {}).get("resources", {}).get("closed"):
            if preview:
                await preview.close()
            return await deny_out("The user closed this browser preview before the action completed.")
        browser_state = (extra or {}).get("browser_state")
        if result["ok"] and isinstance(browser_state, dict):
            if args["operation"] == "open":
                browser_state.update({"open": True, "url": request["url"]})
            elif args["operation"] == "close":
                browser_state.update({"open": False, "url": ""})
        if preview:
            if result["ok"]:
                old_preview = resources.get("preview")
                resources["preview"] = preview
                if old_preview:
                    await old_preview.close()
                result["output"] += f" Static preview URL: {preview.url}"
            else:
                await preview.close()
        if result["ok"] and isinstance(evidence, dict):
            operation = args["operation"]
            if operation == "open":
                evidence.update({"needs_observation": True, "inspected": False, "used": True, "closed_unverified": False})
                result["output"] += " Inspect the page before reporting what it shows."
            elif operation == "inspect":
                evidence.update({"needs_observation": False, "inspected": True, "used": True})
            elif operation == "screenshot" and result.get("imageData"):
                evidence.update({"needs_observation": False, "used": True})
            elif operation == "click":
                evidence.update({"needs_observation": True, "inspected": False, "used": True, "failed_interaction": False})
                result["output"] += " Inspect the updated page before another click or reporting the outcome."
            elif operation == "type":
                evidence.update({"needs_observation": True, "used": True, "failed_interaction": False})
            elif operation == "close":
                evidence["closed_unverified"] = evidence["needs_observation"]
                evidence["needs_observation"] = False
        elif isinstance(evidence, dict) and args["operation"] in ("click", "type"):
            evidence["failed_interaction"] = True
        return result

    if tool == "run_command":
        error = validate_command_args(args)
        if error:
            return await deny_out(error)
        operation = args.get("operation", "start")
        manager = (extra or {}).get("command_manager")
        if operation in ("status", "stop"):
            if manager is None:
                return await deny_out("Background processes are only available during their agent run.")
            if operation == "status":
                return await manager.status(args["process_id"], args.get("wait", 0))
            return await manager.stop(args["process_id"])
        command = args.get("command")
        cwd = args.get("cwd", ".")
        timeout = args.get("timeout", 120)
        if not isinstance(cwd, str) or not cwd.strip() or os.path.isabs(cwd):
            return await deny_out('run_command requires a workspace-relative "cwd".')
        directory = await resolve_in_workspace(root, cwd)
        if not directory or not os.path.isdir(directory):
            return await deny_out(f'run_command: working directory "{cwd}" is unavailable or outside the workspace. '
                                  'cwd is relative to the workspace root; use "." for the root or list_files to find a subfolder.')
        stop = (extra or {}).get("signal")
        if stop is not None and stop.is_set():
            raise asyncio.CancelledError()
        try:
            if args.get("background") is True:
                if manager is None:
                    return await deny_out("Background processes are only available during an agent run.")
                return await manager.start(command, directory, args.get("timeout"))
            proc = await asyncio.create_subprocess_shell(
                command, cwd=directory, stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                **process_group_options(),
            )
            return await collect_command_output(proc, timeout, stop)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"Could not start command: {e}")

    if tool == "list_files":
        tree = await list_workspace_tree(root)
        return {"ok": True, "output": f"Workspace files:\n{tree}"}

    if tool == "read_file":
        p = args.get("path") if isinstance(args.get("path"), str) else ""
        if not p:
            return await deny_out('read_file requires a "path" string argument.')
        target = await resolve_in_workspace(root, p)
        resolved_from: str | None = None
        if target:
            try:
                if not os.path.isfile(target):
                    target = None
            except OSError:
                target = None
        if not target:
            candidates = await find_workspace_files_by_basename(root, os.path.basename(p))
            if len(candidates) == 1:
                target = candidates[0]
                resolved_from = p
            elif len(candidates) > 1:
                rels = ", ".join(os.path.relpath(c, root).replace(os.sep, "/") for c in candidates)
                return await deny_out(f"{p} does not exist, and {len(candidates)} files share that name ({rels}). Read or list one of those to pick the right one.")
        if not target:
            return await deny_out(f"Could not find {p} inside the workspace ({root}). It may be in a subfolder — use list_files to see what exists, or ask the user to open the chat with the correct folder.")
        try:
            stat = os.stat(target)
            if os.path.isdir(target):
                return await deny_out(f"{p} is a directory. Use list_files instead.")
            offset = int(args.get("offset")) if isinstance(args.get("offset"), (int, float)) and args.get("offset") >= 0 else 0
            length = int(args.get("length")) if isinstance(args.get("length"), (int, float)) and args.get("length") > 0 else MAX_READ_BYTES
            # Models sometimes request absurdly small windows (200 bytes) and
            # then "read in slices", misreading each slice as a failure. Clamp
            # to a useful floor — a small file is ALWAYS returned whole.
            length = min(max(length, MIN_READ_BYTES), max(0, stat.st_size - offset))
            with open(target, "rb") as f:
                f.seek(offset)
                data = f.read(length)
            text = data.decode("utf-8", "replace")
            # Line numbers let the model use edit_lines — a region edit located by
            # number instead of by a byte-exact old_string. The numbering matches
            # _split_edit_lines in utils.py (a trailing newline is not a line).
            want_numbers = any(
                args.get(k) is True
                for k in ("numbers", "numbered", "lineNumbers", "line_numbers", "with_line_numbers", "withLineNumbers")
            )
            numbers_note = ""
            if want_numbers and text:
                start_line = 1
                if offset > 0:
                    try:
                        with open(target, "rb") as f:
                            start_line = f.read(offset).count(b"\n") + 1
                    except OSError:  # noqa: S110
                        start_line = 1
                numbered_lines = text.split("\n")
                if numbered_lines and numbered_lines[-1] == "":
                    numbered_lines = numbered_lines[:-1]
                text = "\n".join(f"{start_line + i:>6}| {line}" for i, line in enumerate(numbered_lines))
                numbers_note = (
                    " (line numbers are shown as `    12| code` — use them with edit_lines; "
                    "NEVER copy a number like `12| ` into the text of an edit)"
                )
            suffix = ""
            if offset > 0 or stat.st_size > offset + length:
                remaining = max(0, stat.st_size - (offset + length))
                suffix = (
                    f" (showing bytes {offset}-{offset + length} of {stat.st_size}; {remaining} bytes remain — "
                    f"call read_file with offset={offset + length} for the next part, or omit offset/length to get the whole file at once)"
                )
            actual = ""
            if resolved_from:
                actual = f' (resolved from "{resolved_from}" — the real path is {os.path.relpath(target, root).replace(os.sep, "/")})'
            return {"ok": True, "output": f"File {p}{suffix}{actual}{numbers_note}:\n{text}"}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"Could not read {p}: {e}")










    if tool == "search_files":
        q = args.get("query") if isinstance(args.get("query"), str) else ""
        if not q:
            return await deny_out('search_files requires a "query" string argument.')
        matches: list[str] = []
        limited = False
        case_sensitive = args.get("case_sensitive") is True
        needle = q if case_sensitive else q.lower()

        async def walk(dir: str, depth: int) -> None:
            nonlocal limited
            if depth > 8 or len(matches) >= MAX_SEARCH_MATCHES:
                limited = True
                return
            if is_protected_path(root, dir):
                return
            try:
                entries = os.listdir(dir)
            except OSError:
                return
            for name in entries:
                if len(matches) >= MAX_SEARCH_MATCHES:
                    limited = True
                    return
                if name.startswith(".") or name in IGNORE_DIRS:
                    continue
                full = os.path.join(dir, name)
                if os.path.islink(full) or is_protected_path(root, full):
                    continue
                if os.path.isdir(full):
                    await walk(full, depth + 1)
                else:
                    try:
                        with open(full, "r", encoding="utf-8", errors="replace") as stream:
                            for i, line in enumerate(stream):
                                if needle in (line if case_sensitive else line.lower()):
                                    rel = os.path.relpath(full, root).replace(os.sep, "/")
                                    matches.append(f"{rel}:{i + 1}: {line.strip()[:160]}")
                                    if len(matches) >= MAX_SEARCH_MATCHES:
                                        limited = True
                                        return
                    except OSError:  # noqa: S110
                        pass

        await walk(root, 0)
        note = "\n[Search may be incomplete: depth or 50-match limit reached.]" if limited else ""
        if not matches:
            return {"ok": True, "output": f'No matches for "{q}" in the workspace.' + note}
        return {"ok": True, "output": f'Matches for "{q}":\n' + "\n".join(matches) + note}



    if tool == "play_game":
        p = args.get("path") if isinstance(args.get("path"), str) else ""
        if not p:
            return await deny_out('play_game requires "path" — the game script to run (e.g. "snake.py").')
        res = await resolve_target_smart(root, p)
        if res.get("error"):
            return await deny_out(f"play_game: {res['error']}")
        target = res["target"]
        if not os.path.isfile(target):
            return await deny_out(f"play_game: {p} is not a file inside the workspace. Use glob or list_files to find the game script.")

        interp = find_python_interpreter(root)
        if not interp:
            return await deny_out("Automatic game check: no Python interpreter found. Set KASALIX_PYTHON or run the game manually.")

        def _clamp(value: Any, lo: int, hi: int, default: int) -> int:
            try:
                n = int(value)
            except (TypeError, ValueError):
                return default
            return max(lo, min(hi, n))

        frames = _clamp(args.get("frames"), 1, 3000, 120)
        wall_limit = _clamp(args.get("timeout"), 3, 180, 30)
        shot_every = _clamp(args.get("screenshotEvery"), 0, frames, 10)

        raw_inputs = args.get("inputs") if isinstance(args.get("inputs"), list) else []
        clean_inputs: list[dict[str, Any]] = []
        for entry in raw_inputs[:24]:
            if not isinstance(entry, dict):
                continue
            keys = entry.get("keys")
            if isinstance(keys, str):
                keys = [keys]
            if not isinstance(keys, list):
                keys = []
            clean_inputs.append({
                "frame": _clamp(entry.get("frame"), 0, frames, 0),
                "keys": [str(k) for k in keys][:8],
            })
        clean_inputs.sort(key=lambda e: e["frame"])

        frames_dir = os.path.join(root, ".kx_frames")
        workdir = tempfile.mkdtemp(prefix="kx-play-")
        harness_path = os.path.join(workdir, "harness.py")
        plan_path = os.path.join(workdir, "plan.json")
        result_path = os.path.join(workdir, "result.json")
        try:
            with open(harness_path, "w", encoding="utf-8") as f:
                f.write(HARNESS_SOURCE)
            game_args: list[str] = []
            if isinstance(args.get("args"), str) and args["args"].strip():
                try:
                    game_args = shlex.split(args["args"])
                except ValueError:
                    game_args = args["args"].split()
            with open(plan_path, "w", encoding="utf-8") as f:
                json.dump({
                    "target": target,
                    "frames": frames,
                    "screenshotEvery": shot_every,
                    "outDir": frames_dir,
                    "resultPath": result_path,
                    "wallLimit": wall_limit,
                    "fps": 60,
                    "inputs": clean_inputs,
                    "args": game_args,
                }, f)
        except OSError as e:
            shutil.rmtree(workdir, ignore_errors=True)
            return await deny_out(f"play_game: could not stage the harness: {e}")

        env = dict(os.environ)
        env["PYGAME_HIDE_SUPPORT_PROMPT"] = "1"
        stdout = b""
        stderr = b""
        try:
            proc = await asyncio.create_subprocess_exec(
                *interp, harness_path, plan_path,
                cwd=root,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                **process_group_options(),
            )
            try:
                stdout, stderr = await communicate_with_stop(proc, wall_limit + 20, (extra or {}).get("signal"))
            except asyncio.TimeoutError:
                pass
        except asyncio.CancelledError:
            shutil.rmtree(workdir, ignore_errors=True)
            raise
        except Exception as e:  # noqa: BLE001
            shutil.rmtree(workdir, ignore_errors=True)
            return await deny_out(f"play_game: failed to start the game harness: {e}")

        report: dict[str, Any] | None = None
        try:
            with open(result_path, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            report = loaded if isinstance(loaded, dict) else None
        except (OSError, ValueError):
            report = None
        shutil.rmtree(workdir, ignore_errors=True)

        label = os.path.relpath(target, root).replace(os.sep, "/")
        game_out = (stdout or b"").decode("utf-8", "replace").strip()
        game_err = (stderr or b"").decode("utf-8", "replace").strip()
        if report is None:
            tail = "\n".join(x for x in (game_out, game_err) if x) or "(no output)"
            return {"ok": False, "output": (
                f"play_game: {label} never reported back — it hung or died before the frames ran.\n"
                f"--- program output ---\n{tail[:MAX_OUTPUT_CHARS]}"
            )}

        lines: list[str] = []
        frames_run = report.get("frames") or 0
        crashed = bool(report.get("error"))
        if crashed:
            lines.append(f"play_game: {label} CRASHED after {frames_run} frame(s). Fix the cause below.")
            lines.append(str(report["error"])[:MAX_OUTPUT_CHARS])
        else:
            lines.append(
                f"play_game: ran {label} for {frames_run} frame(s) headless "
                f"(window {report.get('window') or '?'}, pygame {report.get('pygameVersion') or '?'})."
            )
        for note in report.get("notes") or []:
            lines.append(f"note: {note}")

        shots = report.get("shots") or []
        if not shots:
            if not crashed:
                lines.append(
                    "No frames were captured — the game never called display.flip()/update(), so nothing was drawn. "
                    "That is usually a real bug in the loop."
                )
        else:
            motion = False
            static = False
            lines.append(f"Captured {len(shots)} frame(s) into .kx_frames/ (changedPixels = pixels that differ from the previous capture):")
            for shot in shots:
                changed = shot.get("changedPixels")
                rel = os.path.relpath(str(shot.get("path")), root).replace(os.sep, "/")
                lines.append(f"  {rel}  changedPixels={changed}")
                if isinstance(changed, int):
                    motion = motion or changed > 0
                    static = static or changed == 0
            if motion and static:
                lines.append("MIXED: some frames changed and others were pixel-identical — check whether the game paused, the actor left the screen, or input stopped being applied.")
            elif motion:
                lines.append("MOTION CONFIRMED: the picture changes between captured frames, so the loop is actually rendering movement.")
            elif static:
                lines.append("NO MOTION between the captured frames. If this scene should be animating, that is a REAL BUG — the actor is not moving, is not being drawn, or is drawn off-screen. Do not report this as fixed.")
            lines.append("Captured frames are saved in the workspace for review.")

        state = report.get("state") if isinstance(report.get("state"), dict) else {}
        if state:
            lines.append(
                "Game state at exit (module-level variables — check score/lives/game-over here, not just pixels):"
            )
            for name, value in list(state.items())[:30]:
                lines.append(f"  {name} = {json.dumps(value)}")
            lines.append(
                "NOTE: only module-level names are visible. If a value you need is local to main(), "
                "assign it at module level or print it and read the program output below."
            )

        combined = "\n".join(x for x in (game_out, ("[stderr]\n" + game_err) if game_err else "") if x).strip()
        if combined:
            lines.append(f"--- program output ---\n{combined[:MAX_OUTPUT_CHARS]}")

        # Attach the final automatic replay frame to vision-capable models.
        image_payload: dict[str, Any] = {}
        vision_capable = bool((extra or {}).get("use_vision_model"))
        last_shot = str(shots[-1].get("path") or "") if shots else ""
        if last_shot and os.path.isfile(last_shot):
            rel_last = os.path.relpath(last_shot, root).replace(os.sep, "/")
            if vision_capable:
                try:
                    with open(last_shot, "rb") as f:
                        b64 = base64.b64encode(f.read()).decode()
                    if len(b64) * 3 // 4 // 1024 <= 3000:
                        image_payload["imageData"] = f"data:image/png;base64,{b64}"
                        lines.append(
                            f"The final frame ({rel_last}) is ATTACHED to this result as an image — LOOK at it: "
                            "judge the sprite/player position, the score and UI, the colours, and whether it matches "
                            "what the user asked for."
                        )
                    else:
                        lines.append(f"The final frame is too large to attach: {rel_last}.")
                except OSError:
                    lines.append(f"Could not attach {rel_last}.")

        return {"ok": not crashed, "output": "\n".join(lines), **image_payload}

    if tool == "edit_file":
        if not auto_apply:
            return await deny_out("edit_file is disabled — auto-apply mode is OFF. Include the change in your final answer using the EDIT code-block convention instead.")
        p = args.get("path") if isinstance(args.get("path"), str) else ""
        old_string = args.get("old_string") if isinstance(args.get("old_string"), str) else ""
        new_string = args.get("new_string") if isinstance(args.get("new_string"), str) else ""
        if not p or not old_string:
            return await deny_out('edit_file requires "path", "old_string" and "new_string" string arguments.')
        res = await resolve_target_smart(root, p)
        if res.get("error"):
            return await deny_out(res["error"])
        target = res["target"]
        resolved_note = f' (resolved from "{res["resolvedFrom"]}" — real path {os.path.relpath(target, root).replace(os.sep, "/")})' if res.get("resolvedFrom") else ""
        if is_user_rules_path(root, target):
            return await deny_out(f"Access denied: {p} is the USER RULES file — it is read-only for you.")
        try:
            try:
                with open(target, "r", encoding="utf-8", newline="") as f:
                    original_content = f.read()
            except OSError:
                return await deny_out(f"Could not read {p} — the file may not exist. Use write_file to create it.")
            result = search_replace_with_number_fallback(original_content, old_string, new_string)
            if not result.get("ok") or result.get("newContent") is None:
                return await deny_out(f"Edit failed: {result.get('error') or 'unknown error'}")
            cc = changed_line_count(original_content.replace("\r\n", "\n"), result["newContent"].replace("\r\n", "\n"))
            changed = cc["count"]
            total = cc["total"]
            if changed > max(20, int(total * 0.4)):
                return await deny_out(
                    f"Refusing this edit of {p}: it changes {changed} of {total} lines. "
                    "Use edit_lines with line numbers from read_file, or a smaller old_string with edit_file."
                )
            final_content = result["newContent"].replace("\r\n", "\n").replace("\n", "\r\n") if "\r\n" in original_content else result["newContent"]
            with open(target, "w", encoding="utf-8", newline="") as f:
                f.write(final_content)
            diff = summarize_diff(p, original_content, final_content)
            return {"ok": True, "output": f"Edited {p}.\n{diff}", "fileWrite": {"path": target, "changeType": "edited", "originalContent": original_content}}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"Failed to edit {p}: {e}")

    if tool == "edit_lines":
        if not auto_apply:
            return await deny_out(
                f"{tool} is disabled — auto-apply mode is OFF. Include the change in your final answer "
                "using the EDIT code-block convention instead."
            )
        p = _arg_str(args, "path", "file", "filePath", "file_path") or ""
        content_arg = _arg_str(args, "content", "new_content", "newContent", "new_string", "newString", "text", "replacement")
        if not p:
            return await deny_out(f'{tool} requires a "path" string argument.')
        if content_arg is None:
            return await deny_out(
                f'{tool} requires a "content" string argument (the NEW text for that region — pass "" to delete it).'
            )
        res = await resolve_target_smart(root, p)
        if res.get("error"):
            return await deny_out(res["error"])
        target = res["target"]
        resolved_note = f' (resolved from "{res["resolvedFrom"]}" — real path {os.path.relpath(target, root).replace(os.sep, "/")})' if res.get("resolvedFrom") else ""
        if is_user_rules_path(root, target):
            return await deny_out(f"Access denied: {p} is the USER RULES file — it is read-only for you.")
        try:
            try:
                with open(target, "r", encoding="utf-8", errors="replace", newline="") as f:
                    original_content = f.read()
            except OSError:
                return await deny_out(f"Could not read {p} — the file may not exist. Use write_file to create it.")

            start = first_present(args, "start", "start_line", "startLine", "startLineNumber", "first_line", "firstLine", "from_line", "line")
            end = first_present(args, "end", "end_line", "endLine", "last_line", "lastLine", "to_line")
            if start is None:
                return await deny_out(
                    f'edit_lines requires "start" (the 1-based line number where the change begins). '
                    'Get exact numbers from read_file with "numbers": true. Example: '
                    f'{{"tool": "edit_lines", "args": {{"path": "{p}", "start": 42, "end": 48, "content": "<new lines>"}}}}'
                )
            expect = _arg_str(args, "expect", "expected", "first_old_line", "firstLineText")
            result = apply_line_range(original_content, start, end, content_arg, expect)
            where = f"lines {start}" + (f"-{end}" if end is not None and end != start else "")

            if not result.get("ok") or result.get("newContent") is None:
                return await deny_out(f"Edit failed: {result.get('error') or 'unknown error'}")

            replaced = int(result.get("replaced") or 0)
            added = int(result.get("added") or 0)
            final_content = result["newContent"].replace("\r\n", "\n").replace("\n", "\r\n") if "\r\n" in original_content else result["newContent"]
            if final_content == original_content:
                return {"ok": True, "output": f"{p} already has exactly that content in {where} — no change needed."}
            with open(target, "w", encoding="utf-8", newline="") as f:
                f.write(final_content)
            diff = summarize_diff(p, original_content, final_content)
            summary = (
                f"{tool} on {p}{resolved_note}: replaced {where} ({replaced} line(s) removed, {added} line(s) added).\n{diff}"
            )
            if replaced >= 15:
                # The one thing a region edit can lose silently is text the model
                # never read. Say exactly how much went in one go.
                summary += (
                    f"\nNOTE: this removed {replaced} lines in a single edit. Re-read the file (read_file) and "
                    "confirm nothing you meant to keep is gone before you call this done."
                )
            return {"ok": True, "output": summary, "fileWrite": {"path": target, "changeType": "edited", "originalContent": original_content}}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"Failed to edit {p}: {e}")

    if tool == "write_file":
        if not auto_apply:
            return await deny_out("write_file is disabled — auto-apply mode is OFF. Include the file content in your final answer as a code block with the path as the first comment line.")
        p = args.get("path") if isinstance(args.get("path"), str) else ""
        content = args.get("content") if isinstance(args.get("content"), str) else ""
        if not p:
            return await deny_out('write_file requires "path" and "content" arguments.')
        exact = await resolve_in_workspace(root, p)
        if not exact:
            return await deny_out(f"Access denied: {p} is outside the workspace.")
        target = exact
        resolved_from: str | None = None
        if not (await is_file(exact)):
            candidates = await find_workspace_files_by_basename(root, os.path.basename(p))
            if len(candidates) == 1:
                target = candidates[0]
                resolved_from = p
            elif len(candidates) > 1:
                rels = ", ".join(os.path.relpath(c, root).replace(os.sep, "/") for c in candidates)
                return await deny_out(f"{p} does not exist, and {len(candidates)} files share that name ({rels}). Specify the full subfolder path.")
        resolved_note = f' (resolved from "{resolved_from}" — real path {os.path.relpath(target, root).replace(os.sep, "/")})' if resolved_from else ""
        if is_user_rules_path(root, target):
            return await deny_out(f"Access denied: {p} is the USER RULES file — it is read-only for you.")
        try:
            original_content: str | None = None
            change_type = "created"
            try:
                with open(target, "r", encoding="utf-8", newline="") as f:
                    original_content = f.read()
                change_type = "edited"
            except OSError:  # noqa: S110
                pass

            if change_type == "edited":
                orig = original_content or ""
                if orig == content:
                    return {"ok": True, "output": f"{p} already has exactly this content — no change needed."}
                norm_old = orig.replace("\r\n", "\n")
                norm_new = content.replace("\r\n", "\n")
                cc = changed_line_count(norm_old, norm_new)
                changed = cc["count"]
                total = cc["total"]
                is_small_edit = changed <= max(20, int(total * 0.4))
                if not is_small_edit and args.get("force") is not True:
                    return await deny_out(
                        f"Refusing to overwrite {p}: your version changes {changed} of {total} lines — that is a full rewrite, not an edit. "
                        "Do NOT retry write_file with tweaked content — it will be refused again. Instead, read the file first "
                        '({"tool": "read_file", "args": {"path": "' + p + '", "numbers": true}}) and then change ONLY the lines that are wrong, with ONE of these: '
                        '{"tool": "edit_lines", "args": {"path": "' + p + '", "start": <first line>, "end": <last line>, "content": "<new lines>"}} '
                        '(by line number — no old text to copy), '
                        'or {"tool": "edit_file", "args": {"path": "' + p + '", "old_string": "<the exact existing lines you want to change>", "new_string": "<the changed lines>"}}. '
                        "Only change the lines you intend to change."
                    )
                final_content = norm_new.replace("\n", "\r\n") if "\r\n" in orig else norm_new
                with open(target, "w", encoding="utf-8", newline="") as f:
                    f.write(final_content)
                hunks = cc.get("hunks")
                display_changed = sum(max(h["oldCount"], h["newCount"]) for h in hunks) if hunks else changed
                change_label = f"changed {display_changed} line" + ("s" if display_changed != 1 else "")
                return {"ok": True, "output": f"Updated {p} — {change_label}.\n{summarize_diff(p, orig, final_content)}", "fileWrite": {"path": target, "changeType": "edited", "originalContent": orig}}

            # New-file guard for multi-project roots
            rel_dir = os.path.relpath(os.path.dirname(target), root).replace(os.sep, "/")
            if rel_dir in ("", ".") and args.get("force") is not True:
                try:
                    entries = os.listdir(root)
                except OSError:
                    entries = []
                dirs = [
                    e for e in entries
                    if os.path.isdir(os.path.join(root, e))
                    and not e.startswith(".")
                    and e not in IGNORE_DIRS
                    and e.lower() not in PROTECTED_DIRS
                ]
                root_source = [
                    e for e in entries
                    if os.path.isfile(os.path.join(root, e))
                    and (e.split(".").pop() or "").lower() in LANGUAGE_EXT_MAP
                    and not e.startswith(".")
                ]
                # Asset-only subfolders (assets/, css/, js/, static/…) next to a
                # root-level entry file are the STANDARD single web project
                # layout — index.html at root + assets/ the agent just created
                # is NOT a multi-project repo. Only non-asset dirs count as
                # multi-project evidence.
                web_asset_dirs = {
                    "assets", "asset", "static", "public", "css", "js", "javascript",
                    "images", "image", "img", "styles", "stylesheets", "scripts",
                    "media", "fonts", "lib", "audio", "sound", "sounds", "data",
                }
                non_asset_dirs = [d for d in dirs if d.lower() not in web_asset_dirs]
                multi_project = len(non_asset_dirs) >= 2 or (len(non_asset_dirs) >= 1 and len(root_source) == 0)
                if multi_project:
                    return await deny_out(
                        f"Refusing to create {p} at the workspace ROOT — this looks like a multi-project repo ({', '.join(dirs[:6])}). "
                        "Pick the subdirectory the file belongs in and retry, OR if a root-level file is genuinely correct "
                        '(single project living at the root), retry the SAME call with "force": true, e.g. '
                        f'{{"tool": "write_file", "args": {{"path": "{p}", "content": "...", "force": true}}}}.'
                    )
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "w", encoding="utf-8", newline="") as f:
                f.write(content)
            return {"ok": True, "output": f"Created {p} ({len(content.encode('utf-8'))} bytes).", "fileWrite": {"path": target, "changeType": "created"}}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"Failed to write {p}: {e}")

    # ─── Live preview tools (Koding) ───────────────────────────────────
    # The agent can serve the workspace over a local HTTP server, have the
    # client open a real browser window, then screenshot it, evaluate JS in
    # it, and read its console — so it can TEST its own web work.





    if tool == "delete_file":
        if not auto_apply:
            return await deny_out("delete_file is disabled — auto-apply mode is OFF. Suggest the deletion in your final answer instead.")
        p = args.get("path") if isinstance(args.get("path"), str) else ""
        if not p:
            return await deny_out('delete_file requires a "path" string argument.')
        res = await resolve_target_smart(root, p)
        if res.get("error"):
            return await deny_out(res["error"])
        target = res["target"]
        if is_user_rules_path(root, target):
            return await deny_out(f"Access denied: {p} is the USER RULES file — it is read-only for you.")
        try:
            original_content: str | None = None
            try:
                with open(target, "r", encoding="utf-8", newline="") as f:
                    original_content = f.read()
            except OSError:  # noqa: S110
                pass
            os.remove(target)
            return {"ok": True, "output": f"Deleted {p}.", "fileWrite": {"path": target, "changeType": "deleted", "originalContent": original_content}}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"Failed to delete {p}: {e}")


    if tool == "rename_file":
        if not auto_apply:
            return await deny_out("rename_file is disabled — auto-apply mode is OFF.")
        from_path = args.get("from") if isinstance(args.get("from"), str) else ""
        to_path = args.get("to") if isinstance(args.get("to"), str) else ""
        if not from_path or not to_path:
            return await deny_out('rename_file requires "from" and "to" string arguments.')
        from_target = await resolve_target_smart(root, from_path)
        if from_target.get("error"):
            return await deny_out(from_target["error"])
        to_full = os.path.abspath(os.path.join(root, to_path))
        if not (await is_path_inside(root, to_full)):
            return await deny_out(f"Access denied: {to_path} is outside the workspace.")
        if is_protected_path(root, to_full):
            return await deny_out(f"Access denied: {to_path} is a protected directory.")
        if os.path.exists(to_full):
            return await deny_out(f"Cannot rename: {to_path} already exists.")
        if not os.path.isfile(from_target["target"]):
            return await deny_out("rename_file only supports files, not directories.")
        try:
            original_content: str | None = None
            try:
                with open(from_target["target"], "r", encoding="utf-8", newline="") as f:
                    original_content = f.read()
            except OSError:  # noqa: S110
                pass
            os.makedirs(os.path.dirname(to_full), exist_ok=True)
            os.rename(from_target["target"], to_full)
            return {"ok": True, "output": f"Renamed {from_path} → {to_path}", "fileWrites": [
                {"path": from_target["target"], "changeType": "deleted", "originalContent": original_content},
                {"path": to_full, "changeType": "created"},
            ]}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"Failed to rename {from_path} → {to_path}: {e}")










    if tool == "glob":
        pattern = args.get("pattern") if isinstance(args.get("pattern"), str) else ""
        if not pattern:
            return await deny_out('glob requires a "pattern" string argument (e.g. "**/*.py").')
        try:
            matches: list[str] = []
            limited = False

            def _glob_to_regex(p: str) -> re.Pattern:
                s = re.escape(p)
                s = s.replace(r"\*\*/", "{{GLOBSTAR_DIRS}}")
                s = s.replace(r"\*\*", "{{GLOBSTAR}}")
                s = s.replace(r"\*", "[^/]*")
                s = s.replace(r"\?", "[^/]")
                s = re.sub(r"\\\{([^}]+)\\\}", lambda m: "(" + "|".join(x.strip() for x in m.group(1).split(",")) + ")", s)
                s = s.replace("{{GLOBSTAR_DIRS}}", "(?:.*/)?")
                s = s.replace("{{GLOBSTAR}}", ".*")
                return re.compile("^" + s + "$")

            file_regex = _glob_to_regex(pattern.replace("\\", "/"))
            match_basename = "/" not in pattern.replace("\\", "/")

            async def walk(dir: str, depth: int) -> None:
                nonlocal limited
                if depth > 8 or len(matches) >= 200:
                    limited = True
                    return
                if is_protected_path(root, dir):
                    return
                try:
                    entries = os.listdir(dir)
                except OSError:
                    return
                for name in entries:
                    if len(matches) >= 200:
                        limited = True
                        return
                    if name in IGNORE_DIRS:
                        continue
                    full = os.path.join(dir, name)
                    if os.path.islink(full) or is_protected_path(root, full):
                        continue
                    rel = os.path.relpath(full, root).replace(os.sep, "/")
                    if os.path.isdir(full):
                        await walk(full, depth + 1)
                    elif file_regex.fullmatch(rel) or (match_basename and file_regex.fullmatch(name)):
                        matches.append(rel)

            await walk(root, 0)

            with_mtime: list[tuple[str, float]] = []
            for m in matches:
                try:
                    with_mtime.append((m, os.path.getmtime(os.path.join(root, m))))
                except OSError:
                    with_mtime.append((m, 0))
            with_mtime.sort(key=lambda x: -x[1])
            sorted_matches = [m for m, _ in with_mtime]
            note = "\n[Results may be incomplete: depth or 200-file limit reached.]" if limited else ""
            if not sorted_matches:
                return {"ok": True, "output": f'No files match pattern "{pattern}".' + note}
            return {"ok": True, "output": f'Found {len(sorted_matches)} file(s) matching "{pattern}":\n' + "\n".join(sorted_matches) + note}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"glob failed: {e}")


    names = ", ".join(t["name"] for t in AGENT_TOOL_DEFS)
    return await deny_out(f'Unknown tool "{tool}". Available: {names}')






# ─── Code-block file convention (auto-apply fallback) ────────────────────
BLOCK_FILE_PATH_RE = re.compile(r"^(?://|#|;|%|--|/\*|<!--)\s*([^\s]+?\.[a-zA-Z]\w*)\s*(?:\*/|-->)?$")
BLOCK_DELETE_PATH_RE = re.compile(r"^(?://|#|--)\s*DELETE:\s*([^\s]+)", re.I)
BLOCK_EDIT_PATH_RE = re.compile(r"^(?://|#|--|;|%|<!--)\s*EDIT:\s*([^\s]+?)(?:\s*-->)?$", re.I)
BLOCK_CODE_RE = re.compile(r"```(?:\w*)\s*\n([\s\S]*?)```")


def _block_looks_like_shell(first: str, block: str) -> bool:
    """Heuristic: a fenced block whose first line is a comment followed by
    shell-ish content is an EXAMPLE COMMAND, not a file to create. Previously
    'pip install pygame' under '# Use Python 3.11 interpreter' was guessed as
    a write to the last-mentioned .py file, then refused as a 'full rewrite'
    — burning the model's turn and confusing it into churn."""
    shell_tokens = (
        "pip ", "pip3 ", "python ", "py -", "python3 ", "node ", "npm ", "npx ",
        "bun ", "cargo ", "go ", "dotnet ", "git ", "cd ", "ls", "dir ",
        "where ", "which ", "curl ", "echo ", "export ", "set ",
        "--version", "-m ", "./", ".exe", ".bat", ".ps1",
    )
    lines = [l for l in block.split("\n") if l.strip()]
    if not lines:
        return False
    hits = sum(1 for l in lines[1:] if any(t in l.lower() for t in shell_tokens))
    return hits >= max(1, len(lines) - 1) // 2


def guess_filename_from_context(before_text: str) -> str | None:
    if not before_text:
        return None
    quote_matches = re.findall(r"`([\w./-]+\.[a-zA-Z]\w*)`", before_text)
    if quote_matches:
        return quote_matches[-1]
    patterns = [
        re.compile(r"(?:save|write|create|file|as|name[d]?|called|output|below as)[:\s]+([\w./-]+\.[a-zA-Z]\w*)", re.I),
        re.compile(r"([\w./-]+\.[a-zA-Z]\w*)\s*(?::|$)", re.M),
    ]
    for p in patterns:
        matches = list(p.finditer(before_text))
        if matches:
            return matches[-1].group(1)
    return None


def parse_code_block_files(content: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    segments = re.split(r"(```[\s\S]*?```)", content)
    for i, seg in enumerate(segments):
        if not seg.startswith("```"):
            continue
        inner = re.match(r"```(?:\w*)\s*\n([\s\S]*?)```", seg)
        if not inner:
            continue
        block = inner.group(1)
        lines = block.split("\n")
        first = (lines[0].strip() if lines else "") or ""

        del_m = BLOCK_DELETE_PATH_RE.match(first)
        if del_m:
            out.append({"type": "delete", "path": del_m.group(1)})
            continue

        edit_m = BLOCK_EDIT_PATH_RE.match(first)
        if edit_m:
            old_start = sep = new_start = -1
            for j in range(1, len(lines)):
                t = lines[j].strip()
                if old_start == -1 and re.match(r"^OLD:$", t, re.I):
                    old_start = j
                    continue
                if old_start != -1 and sep == -1 and re.match(r"^-{3,}$", t):
                    sep = j
                    continue
                if sep != -1 and re.match(r"^NEW:$", t, re.I):
                    new_start = j
                    break
            if old_start != -1 and sep != -1 and new_start != -1:
                old_string = "\n".join(lines[old_start + 1:sep]).strip()
                new_string = "\n".join(lines[new_start + 1:]).strip()
                if old_string:
                    out.append({"type": "edit", "path": edit_m.group(1), "oldString": old_string, "newString": new_string})
            continue

        path_m = BLOCK_FILE_PATH_RE.match(first)
        if path_m:
            out.append({"type": "create", "path": path_m.group(1), "content": "\n".join(lines[1:]).lstrip()})
            continue

        if _block_looks_like_shell(first, block):
            log_info(f"[parseCodeBlocks] Block {len(out)}: skipped — shell/example command block, not a file")
            continue

        prev_text = segments[i - 1] if i > 0 else ""
        guessed = guess_filename_from_context(prev_text)
        log_info(f"[parseCodeBlocks] Block {len(out)}: firstLine={first[:60]}, guessedPath={guessed}, prevTextLen={len(prev_text)}")
        if guessed:
            out.append({"type": "create", "path": guessed, "content": block.lstrip()})
    return out


async def apply_code_block_files(
    root: str,
    answer: str,
    on_file_written: Callable[[dict[str, Any]], None] | None = None,
) -> str:
    blocks = parse_code_block_files(answer)[:20]
    block_desc = ", ".join(str(b["type"]) + ":" + str(b["path"]) for b in blocks) or "none"
    log_info(f"[agent] parseCodeBlockFiles found {len(blocks)} block(s): {block_desc}")
    if not blocks:
        log_info("[agent] No blocks to apply — code blocks may not have matched the auto-apply format")
        return ""
    applied: list[str] = []
    failed: list[str] = []
    for b in blocks:
        if b["type"] == "delete":
            result = await execute_tool(root, {"tool": "delete_file", "args": {"path": b["path"]}}, True)
        elif b["type"] == "edit":
            result = await execute_tool(root, {"tool": "edit_file", "args": {"path": b["path"], "old_string": b.get("oldString"), "new_string": b.get("newString")}}, True)
        else:
            result = await execute_tool(root, {"tool": "write_file", "args": {"path": b["path"], "content": b.get("content") or ""}}, True)
        if result["ok"]:
            applied.append(b["path"])
            log_info(f"[agent] Auto-applied {b['type']}: {b['path']}")
            if result.get("fileWrite") and on_file_written:
                on_file_written(result["fileWrite"])
        else:
            first_line = result["output"].split("\n")[0]
            log_info(f"[agent] Auto-apply FAILED for {b['path']}: {first_line[:150]}")
            failed.append(f"{b['path']} ({first_line[:100]})")
    parts: list[str] = []
    if applied:
        parts.append(f"Auto-applied {len(applied)} file(s): {', '.join(applied)}")
    if failed:
        parts.append(f"Could not apply: {'; '.join(failed)}")
    return "\n".join(parts)


# ─── Narration: pre-tool prose from the model ───────────────────────────
def extract_narration(raw: str) -> str:
    """Pull the human-readable sentence(s) the model wrote BEFORE its tool
    call JSON — e.g. "Let me check the project structure first." — so the
    client can show it between timeline events. Returns '' when the response
    was pure JSON (nothing worth showing)."""
    # Find where the first tool-call construct starts and take everything before it.
    starts = []
    m = re.search(r'\{\s*"(?:tool|name)"\s*:', raw)
    if m:
        brace = raw.rfind("{", 0, m.end())
        if brace >= 0:
            starts.append(brace)
    m = re.search(r'<(?:invoke|tool)\s', raw, re.I)
    if m:
        starts.append(m.start())
    if not starts:
        return ""
    prose = raw[:min(starts)].strip()
    if not prose:
        return ""
    # Strip markdown fences the model may have wrapped around the JSON —
    # leftover ``` or ```json lines are noise, not narration.
    prose = re.sub(r"^```[a-zA-Z]*\s*$", "", prose, flags=re.M).strip()
    # Cap length — narration is a sentence or two, not an essay.
    if len(prose) > 300:
        prose = prose[:297].rstrip() + "…"
    return prose


# ─── Tool-call protocol parsing ─────────────────────────────────────────
def extract_tool_call(raw: str) -> dict[str, Any] | None:
    trimmed = raw.strip()
    start = trimmed.find("{")
    if start == -1:
        return None
    depth = 0
    in_string = False
    escaped = False
    for i in range(start, len(trimmed)):
        ch = trimmed[i]
        if in_string:
            if escaped:
                escaped = False
                continue
            if ch == "\\":
                escaped = True
                continue
            if ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                candidate = trimmed[start:i + 1]
                try:
                    parsed = json.loads(candidate)
                    if not parsed or not isinstance(parsed, dict):
                        raise json.JSONDecodeError("not an object", candidate, 0)
                    # Same dialect tolerance as extract_tool_calls — sub-agents
                    # must accept the OpenAI-style drift too.
                    tool_name = parsed.get("tool") or parsed.get("name") or parsed.get("function")
                    args_val = parsed.get("args")
                    if args_val is None:
                        args_val = parsed.get("arguments")
                    if args_val is None and isinstance(parsed.get("function"), dict):
                        fn = parsed["function"]
                        tool_name = tool_name or fn.get("name")
                        args_val = fn.get("arguments")
                    if (
                        isinstance(tool_name, str)
                        and isinstance(args_val, dict)
                        and any(t["name"] == tool_name for t in AGENT_TOOL_DEFS)
                    ):
                        return {"tool": tool_name, "args": args_val}
                except (json.JSONDecodeError, AttributeError):  # noqa: S110
                    pass
                # Same repair fallback as extract_tool_calls — sub-agents hit
                # the identical malformed-JSON failure modes. (Inside the
                # depth==0 branch: candidate only exists there.)
                repaired = repair_tool_json(candidate)
                if isinstance(repaired, dict):
                    r_tool = repaired.get("tool") or repaired.get("name") or repaired.get("function")
                    r_args = repaired.get("args")
                    if r_args is None:
                        r_args = repaired.get("arguments")
                    if (
                        isinstance(r_tool, str)
                        and isinstance(r_args, dict)
                        and any(t["name"] == r_tool for t in AGENT_TOOL_DEFS)
                    ):
                        return {"tool": r_tool, "args": r_args}
    calls = parse_xml_tool_calls(raw)
    if calls:
        return calls[0]
    return salvage_tool_call_heuristic(raw)


def parse_xml_tool_calls(raw: str) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    invoke_regex = re.compile(
        r'<invoke\s+name=["\']([^"\']+)["\']\s*>((?:<parameter\s+name=["\']([^"\']+)["\']\s*>([^<]*)</parameter>\s*)*)</invoke>',
        re.I,
    )
    for m in invoke_regex.finditer(raw):
        tool_name = m.group(1)
        if not any(t["name"] == tool_name for t in AGENT_TOOL_DEFS):
            continue
        args: dict[str, Any] = {}
        param_regex = re.compile(r'<parameter\s+name=["\']([^"\']+)["\']\s*>([^<]*)</parameter>', re.I)
        for pm in param_regex.finditer(m.group(2)):
            args[pm.group(1)] = pm.group(2)
        if args:
            results.append({"tool": tool_name, "args": args})
    if results:
        return results

    tool_tag_regex = re.compile(r'<tool\s+name=["\']([^"\']+)["\']\s*(?:args=["\']([^"\']*)["\'])?\s*/?>', re.I)
    for m in tool_tag_regex.finditer(raw):
        tool_name = m.group(1)
        if not any(t["name"] == tool_name for t in AGENT_TOOL_DEFS):
            continue
        args: dict[str, Any] = {}
        if m.group(2):
            for pair in m.group(2).split():
                eq = pair.find("=")
                if eq > 0:
                    args[pair[:eq]] = pair[eq + 1:]
        results.append({"tool": tool_name, "args": args})
    return results


# ─── JSON repair: salvage the near-misses models actually emit ──────────
# A backslash NOT starting a valid JSON string escape (" \ / b f n r t u or
# \uXXXX) is invalid JSON — models emit it constantly in write_file content
# (regexes like \d+\w+, Windows paths like C:\Games\X). json.loads rejects
# the WHOLE call over one such backslash, so we rewrite them as double
# backslashes before parsing. The pattern CONSUMES one escape candidate at a
# time — a pure lookahead would double the second backslash of a valid \\
# pair (scanning '\e' from the wrong offset).
_JSON_ESCAPE_PAIR = re.compile(r'\\u[0-9a-fA-F]{4}|\\["\\/bfnrtu]|\\.')


def fix_invalid_json_escapes(s: str) -> str:
    """Double every backslash that starts an invalid JSON escape."""

    def _fix(m: re.Match) -> str:
        tok = m.group(0)
        if len(tok) > 2 or tok[1] in '"\\/bfnrtu':
            return tok  # \uXXXX or a valid escape pair — keep as-is
        return "\\\\" + tok[1]  # invalid escape → double the backslash

    return _JSON_ESCAPE_PAIR.sub(_fix, s)


_UNESCAPE_MAP = {"n": "\n", "t": "\t", "r": "\r"}


def _lenient_unescape(v: str) -> str:
    """Single-pass unescape for salvaged string values. One scan (sequential
    .replace() passes mis-decode sequences like backslash-backslash-n), and
    escaped quotes ARE decoded — skipping them once wrote literal
    backslash-quotes (docstring corruption) into created files."""
    out: list[str] = []
    i = 0
    n = len(v)
    while i < n:
        ch = v[i]
        if ch == "\\" and i + 1 < n:
            out.append(_UNESCAPE_MAP.get(v[i + 1], v[i + 1]))
            i += 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def _scan_lenient_string(s: str) -> tuple[str, int] | None:
    """Scan a leniently-quoted string starting at s[0] (any quote char).
    Returns (decoded value, chars consumed) or None when s does not start
    with a quote. The value ends at an unescaped quote ONLY when it is
    followed by `, "key":` / `}` / end-of-input — a quote elsewhere is part
    of the value (print("hi")). Escapes are decoded in the same pass, so
    escaped quotes inside content (docstrings) become real quotes."""
    if not s or s[0] not in "\"'":
        return None
    quote = s[0]
    terminator = re.compile(r'\s*(?=,\s*["\'][a-zA-Z_][a-zA-Z0-9_]*["\']\s*:|\}|$)')
    out: list[str] = []
    i = 1
    n = len(s)
    while i < n:
        ch = s[i]
        if ch == "\\" and i + 1 < n:
            out.append(_UNESCAPE_MAP.get(s[i + 1], s[i + 1]))
            i += 2
            continue
        if ch == quote and terminator.match(s, i + 1):
            return "".join(out), i + 1
        out.append(ch)
        i += 1
    return "".join(out), n  # unterminated → truncated value


def salvage_tool_call_heuristic(raw: str) -> dict[str, Any] | None:
    """Last-resort salvage for tool calls json can never parse:
    unescaped quotes inside content (print("hi")) and truncated calls
    (the model ran out of tokens mid-write_file). Scans for the known
    key pattern and extracts values with a lenient string scanner."""
    m = re.search(r'["\']?(?:tool|name)["\']?\s*:\s*["\']([a-z_]+)["\']', raw)
    if not m:
        return None
    tool_name = m.group(1)
    if not any(t["name"] == tool_name for t in AGENT_TOOL_DEFS):
        return None
    # Do not heuristically salvage an incomplete shell command.
    if tool_name in EXECUTION_TOOLS:
        return None

    args: dict[str, Any] = {}
    # Match "key": <value> pairs; values are scanned leniently (the value
    # ends at ", <key>": or the closing }} — whichever comes first).
    key_spans = [(km.group(1), km.start()) for km in re.finditer(
        r'["\']?(args|arguments)["\']?\s*:\s*\{', raw)]
    body_start = key_spans[0][1] if key_spans else m.end()
    body = raw[body_start:]
    # Find simple string-valued args: "path": "...", "command": '...', etc.
    # Values may contain unescaped quotes — take up to the next quote that is
    # followed by optional whitespace and either another "key": pattern or the end.
    for km in re.finditer(r'["\']([a-zA-Z_][a-zA-Z0-9_]*)["\']\s*:\s*', body):
        key = km.group(1)
        if key in ("tool", "name", "args", "arguments"):
            continue
        rest = body[km.end():]
        # Value: quoted string (possibly broken). The lenient scanner keeps
        # unescaped quotes inside the value (print("hi")), decodes escapes
        # in one pass ("\" → real quote — docstrings survive), and tolerates
        # truncation (no closing quote).
        scanned = _scan_lenient_string(rest)
        if scanned is not None:
            args[key] = scanned[0]
            continue
        # Truncated / unquoted value (no opening quote): take the rest.
        tail = rest.rstrip()
        if tail and not tail.startswith(('"', "'")):
            continue
        args[key] = _lenient_unescape(tail.strip('"\'')) if tail else ""
    if not args:
        return None
    # Truncation vs. sloppiness: salvage runs on calls json could not parse.
    # A call that never closes (no final brace, ends mid-string) means the
    # model ran out of output tokens — for write_file that is a HALF file
    # waiting to happen. A call with balanced braces (unescaped quotes /
    # raw newlines) is sloppy but COMPLETE — fine to execute.
    stripped = raw.rstrip()
    if not stripped.endswith("}") and raw.count("{") > raw.count("}"):
        args["_truncated"] = True
    return {"tool": tool_name, "args": args}


def repair_tool_json(candidate: str) -> dict[str, Any] | None:
    """Try progressively more tolerant parses of a JSON-looking blob.
    Models constantly produce *almost*-valid JSON: trailing commas, single
    quotes, literal newlines inside strings (newlines not escaped as \\n),
    smart quotes, unquoted keys. Each failure means a retry round-trip
    (30-90s on a slow model), so repairing in place is a huge win."""
    attempts = [candidate]
    # 1) Strip markdown fences if the model wrapped the call in ```json
    fenced = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", candidate.strip())
    if fenced != candidate.strip():
        attempts.append(fenced)
    # 1.5) Invalid escape sequences (\\d in a regex, \\U in a Windows path):
    # json.loads rejects the whole call — double the backslashes and retry.
    attempts.append(fix_invalid_json_escapes(candidate))
    # 2) Common character-level fixes applied together
    repaired = candidate
    repaired = repaired.replace("\u201c", '"').replace("\u201d", '"')   # smart double quotes
    repaired = repaired.replace("\u2018", "'").replace("\u2019", "'")   # smart single quotes
    repaired = re.sub(r",\s*([}\]])", r"\1", repaired)                   # trailing commas
    # Unquoted keys: bare word followed by colon. The (?<=\{|,) lookahead
    # keeps us from touching string values that merely look like "word:".
    repaired = re.sub(r'(?<=[{,])\s*([A-Za-z_][A-Za-z0-9_]*)\s*:', r' "\1":', repaired)
    attempts.append(repaired)
    # 3) Single-quoted strings → double-quoted (only when no doubles inside)
    attempts.append(repaired.replace("'", '"'))
    # 4) Literal newlines inside the JSON are the #1 write_file killer:
    #    the model writes "content": "line1
    #    line2" with a raw newline. Escape them.
    def escape_literal_newlines(s: str) -> str:
        out = []
        in_string = False
        escaped = False
        for ch in s:
            if in_string:
                if escaped:
                    escaped = False
                    out.append(ch)
                    continue
                if ch == "\\":
                    escaped = True
                    out.append(ch)
                    continue
                if ch == '"':
                    in_string = False
                    out.append(ch)
                    continue
                if ch == "\n":
                    out.append("\\n")
                    continue
                if ch == "\t":
                    out.append("\\t")
                    continue
                out.append(ch)
            else:
                if ch == '"':
                    in_string = True
                out.append(ch)
        return "".join(out)
    for base in list(attempts):
        fixed = fix_invalid_json_escapes(base)
        attempts.append(fixed)
        attempts.append(escape_literal_newlines(fixed))
    # 5) Last resort: extract just the {...} object (prose wrapped around it)
    first = candidate.find("{")
    last = candidate.rfind("}")
    if first != -1 and last > first:
        inner = candidate[first:last + 1]
        attempts.append(escape_literal_newlines(inner))
        attempts.append(escape_literal_newlines(repaired_inner := re.sub(r",\s*([}\]])", r"\1", inner)))

    for attempt in attempts:
        try:
            parsed = json.loads(attempt)
            if isinstance(parsed, dict):
                return parsed
        except (json.JSONDecodeError, ValueError):
            continue
    return None


def balanced_json_object_at(text: str, start: int) -> tuple[int, str] | None:
    """Return (end_index, object_text) for the balanced {...} starting at `start`.

    Brace counting ignores braces inside JSON strings."""
    if start < 0 or start >= len(text) or text[start] != "{":
        return None
    depth = 0
    in_string = False
    escaped = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escaped:
                escaped = False
                continue
            if ch == "\\":
                escaped = True
                continue
            if ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i, text[start:i + 1]
    return None


def object_starts_from(text: str, pos: int = 0):
    """Yield indices of '{' that are NOT inside a JSON string."""
    in_string = False
    escaped = False
    for i in range(pos, len(text)):
        ch = text[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            continue
        if ch == "{":
            yield i


def parse_json_object(candidate: str) -> dict[str, Any] | None:
    """Strict parse first; on failure the repair layer salvages trailing
    commas, single quotes, literal newlines inside strings, fences and smart
    quotes. Most "malformed" calls are one of these — repairing beats a
    30-90s retry round."""
    try:
        parsed = json.loads(candidate)
    except (json.JSONDecodeError, AttributeError):
        parsed = repair_tool_json(candidate)
    return parsed if isinstance(parsed, dict) else None


def tool_call_from_dict(parsed: dict[str, Any] | None) -> dict[str, Any] | None:
    """Normalize the call dialects models drift into.

    Ours:      {"tool": "read_file", "args": {...}}
    OpenAI:    {"name": "read_file", "arguments": {...}}
    Nested:    {"function": {"name": "read_file", "arguments": {...}}}
    Accept all of them (and mixed pairs) — the INTENT is obvious, and
    rejecting it dumped raw JSON into the chat as "final output".
    """
    if not isinstance(parsed, dict):
        return None
    fn = parsed.get("function")
    tool_name = parsed.get("tool") or parsed.get("name")
    if tool_name is None and isinstance(fn, dict):
        tool_name = fn.get("name")
    args_val = parsed.get("args")
    if args_val is None:
        args_val = parsed.get("arguments")
    if args_val is None and isinstance(fn, dict):
        args_val = fn.get("arguments")
    if (
        isinstance(tool_name, str)
        and isinstance(args_val, dict)
        and any(t["name"] == tool_name for t in AGENT_TOOL_DEFS)
    ):
        return {"tool": tool_name, "args": args_val}
    return None


# The bracket / paren call syntaxes small models emit INSTEAD of JSON:
#   [read_file, {"path": "x.py"}]   [read_file {"path": "x.py"}]
#   read_file({"path": "x.py"})     read_file(path="x.py")     [git_status]
# These execute NOTHING if unhandled — the model believes it acted, the user
# just sees it TALK about reading or testing the file.
_PSEUDO_NAME_BEFORE_OBJECT = re.compile(r"([a-z_][a-z0-9_]*)[\"']?\s*[,:(]?\s*$", re.I)
_PSEUDO_KEYWORD_CALL = re.compile(r"\b([a-z_][a-z0-9_]*)\s*\(([^()]*)\)")
_PSEUDO_BARE_BRACKET = re.compile(r"\[\s*[\"']?([a-z_][a-z0-9_]*)[\"']?\s*\]")


def parse_pseudo_tool_calls(raw: str) -> list[dict[str, Any]]:
    """Salvage bracket/paren call syntaxes that are not JSON at all."""
    known = {t["name"] for t in AGENT_TOOL_DEFS}
    results: list[dict[str, Any]] = []

    # (1) an args object preceded by a known tool name: [name, {...}] / name({...})
    cursor = 0
    while cursor < len(raw):
        start = next(object_starts_from(raw, cursor), None)
        if start is None:
            break
        span = balanced_json_object_at(raw, start)
        if span is None:
            cursor = start + 1
            continue
        end, candidate = span
        cursor = end + 1
        parsed = parse_json_object(candidate)
        if not parsed or tool_call_from_dict(parsed):
            continue  # a real call — the JSON path already handled it
        m = _PSEUDO_NAME_BEFORE_OBJECT.search(raw[:start])
        if not m or m.group(1).lower() not in known:
            continue
        results.append({"tool": m.group(1).lower(), "args": parsed})
    if results:
        return results

    # (2) keyword-call form: read_file(path="x.py", query="...")
    for m in _PSEUDO_KEYWORD_CALL.finditer(raw):
        name = m.group(1).lower()
        if name not in known:
            continue
        kwargs: dict[str, Any] = {}
        for pair in re.finditer(r"([a-z_][a-z0-9_]*)\s*=\s*(\"[^\"]*\"|'[^']*'|[^,)]+)", m.group(2)):
            value = pair.group(2).strip()
            if len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0]:
                value = value[1:-1]
            kwargs[pair.group(1)] = value
        if kwargs:
            results.append({"tool": name, "args": kwargs})
    if results:
        return results

    # (3) bare bracket form with no args: [git_status] / [list_files]
    for m in _PSEUDO_BARE_BRACKET.finditer(raw):
        if m.group(1).lower() in known:
            results.append({"tool": m.group(1).lower(), "args": {}})
    return results


def extract_tool_calls(raw: str) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    trimmed = raw.strip()
    search_start = 0
    while search_start < len(trimmed):
        start = trimmed.find("{", search_start)
        if start == -1:
            break
        span = balanced_json_object_at(trimmed, start)
        if span is not None:
            end, candidate = span
            call = tool_call_from_dict(parse_json_object(candidate))
            if call:
                results.append(call)
                search_start = end + 1
                continue
        search_start = start + 1
    if results:
        return results
    # Last-ditch salvage for calls no JSON parser can recover (unescaped
    # quotes inside content, truncated output) — beats burning a retry
    # round-trip on a call whose INTENT is obvious.
    salvaged = salvage_tool_call_heuristic(raw)
    if salvaged:
        return [salvaged]
    # Bracket/paren syntaxes ([read_file, {...}]) are not JSON at all.
    pseudo = parse_pseudo_tool_calls(raw)
    if pseudo:
        return pseudo
    return parse_xml_tool_calls(raw)


def to_native_tool_history(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert complete recorded call/result pairs to Ollama's tool roles.

    Incomplete, denied, or compacted history remains text so a result is never
    invented and an unmatched native call is never sent to the model.
    """
    out: list[dict[str, Any]] = []
    index = 0
    while index < len(messages):
        message = messages[index]
        if message.get("role") != "assistant":
            out.append(message)
            index += 1
            continue
        calls = extract_tool_calls(str(message.get("content") or ""))
        if not calls or index + 1 >= len(messages):
            out.append(message)
            index += 1
            continue
        results: list[tuple[str, str]] = []
        cursor = index + 1
        while cursor < len(messages) and messages[cursor].get("role") == "user" and len(results) < len(calls):
            content = str(messages[cursor].get("content") or "")
            matches = list(re.finditer(r"\[TOOL RESULT — (\w+)\]", content))
            if not matches or matches[0].start() != 0:
                break
            for i, match in enumerate(matches):
                end = matches[i + 1].start() if i + 1 < len(matches) else len(content)
                results.append((match.group(1), content[match.end():end].strip()))
            cursor += 1
        if len(results) != len(calls) or [name for name, _ in results] != [call["tool"] for call in calls]:
            out.append(message)
            index += 1
            continue
        native = [{"type": "function", "function": {"name": call["tool"], "arguments": call["args"]}} for call in calls]
        out.append({"role": "assistant", "content": "", "tool_calls": native})
        out.extend({"role": "tool", "tool_name": name, "content": content} for name, content in results)
        index = cursor
    return out


def build_native_system_prompt(workspace_path: str, user_name: str) -> str:
    return (
        f"You are Koding, a coding agent helping {user_name} in {workspace_path}. "
        "Use the supplied tools to inspect files and make requested changes. "
        "A statement that you will act is not a tool call. Call tools when needed, "
        "inspect their results, and verify changes before reporting success. "
        "Use run_command for relevant tests or checks and report their actual results. "
        "For a static HTML page use browser open with path; do not guess a port or use a system browser. "
        "Inspect the page before clicking or typing and inspect the result afterward. "
        "Use targeted edits, respect the user's rules and permissions, and never invent tool results. "
        "When no tool is needed, answer normally or ask a necessary question."
    )


def build_structured_system_prompt(workspace_path: str, user_name: str, schemas: list[dict[str, Any]]) -> str:
    tools = []
    for schema in schemas:
        function = schema["function"]
        limit = 800 if function["name"] in ("browser", "run_command") else 220
        example = next((tool["args"] for tool in AGENT_TOOL_DEFS if tool["name"] == function["name"]), "")
        examples = f" Examples: {example}" if function["name"] in ("browser", "run_command") else ""
        tools.append(f"- {function['name']}: {function['description'][:limit]} Arguments: {json.dumps(function['parameters'], ensure_ascii=False)}{examples}")
    return (build_native_system_prompt(workspace_path, user_name)
        + '\nRespond with exactly one JSON object: {"action":"tool","tool":"name","args":{...}}, '
          '{"action":"final","message":"..."}, or {"action":"question","question":"..."}. '
          'Use a tool when work remains; do not claim to have acted without a tool result.\nAvailable tools:\n'
        + "\n".join(tools))


# ─── The agent loop ─────────────────────────────────────────────────────
def available_tools(auto_apply: bool) -> list[dict[str, Any]]:
    return [t for t in AGENT_TOOL_DEFS if auto_apply or not t["mutating"]]


def build_system_prompt(workspace_path: str, user_name: str, auto_apply: bool) -> str:
    tools = available_tools(auto_apply)
    tool_list = "\n".join(f"- {t['name']}: {t['description']}\n  Example arguments: {t['args']}" for t in tools)
    availability = "File edits are available." if auto_apply else "Read-only: file changes are unavailable."
    edit_guidance = ("EDITING AN EXISTING FILE: read it first, then use edit_file or edit_lines for focused changes. "
                     if auto_apply else "Read files to understand the project; do not change them. ")
    return (f"You are Koding, a coding agent helping {user_name} in {workspace_path}.\n"
        f"Available workspace tools:\n{tool_list}\n\n{availability}\n"
        'When using a tool, respond with one JSON object like {"tool":"read_file","args":{"path":"src/main.py"}}. '
        f"{edit_guidance}"
        "Respect workspace rules. "
        "If no tool is needed, answer normally or ask the user a question in your final response. "
        "Use run_command to verify relevant changes when appropriate; report the actual exit status and any failures. "
        "Use browser to inspect and interact with local web apps in the visible pane. "
        "Git-specific, web search, image generation, and subagent tools are unavailable. "
        "Automatic verification may report results separately; never claim a check ran without such a result.")


async def run_agent_loop(opts: dict[str, Any]) -> str:
    model = opts["model"]
    workspace_path = opts.get("workspacePath")
    auto_apply = opts.get("autoApply") is True
    user_name = opts.get("userName")
    signal: asyncio.Event | None = opts.get("signal")
    callbacks = opts.get("callbacks") or {}
    root = resolve_workspace_root(workspace_path)

    # No workspace → answer conversationally (streamed).
    if not root:
        _cb(opts, "onStage", "chat:thinking")
        out: list[str] = []
        await stream_chat(
            model,
            opts["messages"],
            lambda c: (out.append(c), _cb(opts, "onChunk", c)),
            StreamOptions(
                signal=signal,
                temperature=opts.get("temperature"),
                top_p=opts.get("top_p"),
                max_tokens=opts.get("max_tokens"),
                think=opts.get("think"),
                on_thinking=callbacks.get("onThinking"),
                base_url=opts.get("cloudEndpoint") or None,
                api_key=opts.get("cloudApiKey") or None,
                on_metrics=callbacks.get("onMetrics"),
            ),
        )
        return "".join(out)

    # ── Session log ────────────────────────────────────────────────────
    session_log = SessionLog(owner_id=opts.get("userId"), conversation_id=opts.get("conversationId"))
    await session_log.init()
    log_info(f"[agent] Session log: {session_log.get_file_path()}")

    _cb(opts, "onStage", "agent:thinking")

    file_tree = await list_workspace_tree(root)
    last_user_msg = next((m.get("content", "") for m in reversed(opts["messages"]) if m.get("role") == "user"), "") or ""
    try:
        referenced_files = await collect_referenced_files(last_user_msg, root)
    except Exception:  # noqa: BLE001
        referenced_files = ""
    # Automatic checks execute project code; restricted modes require an
    # explicit, approved tool call instead of running them behind the gate.
    unrestricted = (opts.get("toolPermission") or "auto") == "auto"
    verify = await detect_verify_command(root) if unrestricted else None
    # A playable pygame game in the workspace — replayed automatically after
    # every Python edit so behaviour claims are backed by an actual play test.
    game_target = await detect_game_target(root) if auto_apply and unrestricted else None
    # Automatic game replay state: how many times the game has been played this
    # run, the most recent verdict, and the bounded completion guard.
    game_verify_count = 0
    last_game_verdict: str | None = None
    last_game_failed = False
    game_stop_nudges = 0
    # Raw-image screenshots: when the CODE model itself is vision-capable,
    # screenshots and captured game frames go straight into its context as
    # images instead of being described by the separate vision model. Computed
    # early so the baseline game check can use it too.
    use_vision_model = False
    native_tools = False
    try:
        from .capabilities import get_model_capabilities

        capabilities = await get_model_capabilities(model)
        use_vision_model = bool(capabilities.get("vision"))
        native_tools = bool(capabilities.get("tools"))
    except Exception:  # noqa: BLE001
        use_vision_model = False
    project_rules = await read_project_rules(root)
    agent_memory = await read_agent_memory(root)
    project_config = await read_project_config(root)
    workspace_profile = await build_workspace_profile(root, (verify or {}).get("command"), project_rules, agent_memory, project_config)
    native_tools = native_tools or bool(opts.get("cloudEndpoint"))
    try:
        from .capabilities import recently_failed_tool_use
        if await recently_failed_tool_use(model, opts.get("cloudEndpoint")):
            native_tools = False
            log_info(f"[agent] Recent tool-use test failed for {model}; starting with fallback format")
    except Exception:  # noqa: BLE001
        pass
    schemas = native_tool_schemas(available_tools(auto_apply))
    protocol_state = {"mode": "native" if native_tools else "structured" if not opts.get("cloudEndpoint") else "text"}
    action_timeout, action_retry_limit = action_limits(root)
    _cb(opts, "onNarration", f"Tool-call mode: {protocol_state['mode']}. Action timeout: {action_timeout:g}s.")
    if protocol_state["mode"] == "native":
        base_prompt = build_native_system_prompt(root, user_name or "a user")
    elif protocol_state["mode"] == "structured":
        base_prompt = build_native_system_prompt(root, user_name or "a user")
    else:
        base_prompt = build_system_prompt(root, user_name or "a user", auto_apply)
    system = await with_ai_rules(base_prompt, "agent")

    # ── Resume state (from opts or latest session log) ────────────────
    resume_state = opts.get("resumeState") or {}
    last_user_msgs = [{"role": "user", "content": m.get("content", "")} for m in opts["messages"] if m.get("role") == "user"]
    if resume_state.get("history"):
        history: list[dict[str, str]] = [
            *resume_state["history"],
            *[{"role": "user", "content": "[RESUMING a previously stopped run] " + m["content"]} for m in last_user_msgs[-1:]],
        ]
    else:
        history = [
            {
                "role": "system",
                "content": system
                + "\n\n"
                + workspace_profile
                + "\n\nCURRENT WORKSPACE FILES:\n"
                + file_tree
                + (f"\n\n---\n\n[USER RULES — authoritative, written by the user. Follow them strictly. You can NEVER edit or override this file.]\n{project_rules}" if project_rules else "")
                + (f"\n\n---\n\n[AGENT MEMORY — your own notes from previous sessions (.agent-memory.md). Lower priority than user rules: if this contradicts a user rule, the user rule wins.]\n{agent_memory}" if agent_memory else "")
                + (f"\n\n---\n\n{opts.get('extraContext')}" if opts.get("extraContext") else "")
                + (f"\n\n{referenced_files}" if referenced_files else ""),
            },
            *opts["messages"],
        ]

    ground_truth_block = (
        "WORKSPACE GROUND TRUTH (the ONLY files that exist — never invent others):\n"
        + file_tree
        + "\n\n"
        + workspace_profile
    )

    # BASELINE VERIFY on fresh bug-hunting runs
    looks_like_bug_hunt = bool(re.search(r"\b(bug|fix|broken|error|not working|doesn't work|does not work|crash|fail|test|check|works\?|issue|wrong)\b", last_user_msg, re.I))
    if auto_apply and verify and not (resume_state.get("history") or []) and looks_like_bug_hunt:
        _cb(opts, "onStage", "agent:verify")
        verify_cap = 3000
        baseline_out = await _run_verify(verify["command"], root, verify_cap, signal)
        history.append({
            "role": "user",
            "content": f"[BASELINE VERIFICATION — run BEFORE any changes, current state of the project. {verify['label']} ({verify['command']})]\n{baseline_out}\n\nThis is the result of running the verify command before you changed anything. Use it to understand what currently works and what is broken. After you make changes, the same command runs automatically and you will see whether it passes.",
        })
        _cb(opts, "onAgentCommand", {"command": verify["command"], "output": baseline_out, "failed": baseline_out.startswith("FAILED")})

    if auto_apply and game_target and not (resume_state.get("history") or []) and looks_like_bug_hunt:
        # Reproduce the reported behaviour BEFORE touching anything, so the
        # model starts from evidence ("it really is stuck") rather than belief.
        _cb(opts, "onStage", "agent:verify")
        log_info(f"[agent] Baseline game check: playing {game_target['path']}")
        baseline_check = await run_game_check(root, game_target, use_vision_model=use_vision_model, signal=signal)
        last_game_verdict = baseline_check["verdict"]
        last_game_failed = not baseline_check["ok"]
        game_verify_count += 1
        history.append({"role": "user", "content": game_verify_message(baseline_check, game_target, baseline=True)})
        await session_log.log_verify(f"play_game {game_target['path']}", baseline_check["output"], baseline_check["ok"])
        _cb(opts, "onAgentCommand", {"command": f"python {game_target['path']} (headless autoplay)", "output": baseline_check["output"][:2000], "failed": not baseline_check["ok"]})

    # ── Planning phase ──────────────────────────────────────────────────
    plan_text = ""
    pending_plan_text = ""
    plan_mode = opts.get("planMode") or "off"

    if resume_state.get("pendingPlan") and not (resume_state.get("history") or []):
        plan_text = resume_state["pendingPlan"]
        pending_plan_text = ""
        log_info(f"[agent] Resuming with saved plan: {plan_text[:100]}")
        _cb(opts, "onPlan", plan_text)

    should_plan = (
        not plan_text
        and not (resume_state.get("history") or [])
        and plan_mode != "off"
        and (plan_mode == "on" or (plan_mode == "auto" and len(last_user_msg) > 200))
    )
    if should_plan:
        try:
            _cb(opts, "onStage", "agent:plan")
            await session_log.log_stage("agent:plan")
            plan_prompt = [
                {"role": "system", "content": system + "\n\n" + workspace_profile},
                *opts["messages"],
                {"role": "user", "content": last_user_msg + "\n\nCRITICAL: Output EXACTLY 2-5 numbered steps, each line like \"1. Short step description\" — nothing else. Example:\n1. Create the player class\n2. Add collision detection\n3. Write the game loop\nDo NOT write code, do NOT write prose, do NOT explain, do NOT repeat the numbers twice. ONLY output the numbered steps."},
            ]
            plan_chunks: list[str] = []
            await asyncio.wait_for(stream_chat_with_retry(opts, plan_prompt, plan_chunks.append, lambda _t: None), timeout=action_timeout)
            plan_raw = "".join(plan_chunks)
            plan_lines = [l.strip() for l in plan_raw.split("\n") if re.match(r"^\s*(?:\d+\s*[.)\]]?\s+\S|[-*•]\s+\S)", l.strip()) and len(l.strip()) <= 160]
            if len(plan_lines) < 2:
                bullet_lines = [l for l in plan_raw.split("\n") if re.match(r"^\s*\d+[.)\]]\s+", l.strip()) or re.match(r"^\s*[-*]\s+", l.strip())]
                if len(bullet_lines) >= 2:
                    plan_lines = [re.sub(r"^\s*\d+\s*[.)\]]?\s*", "", l.strip()) for l in bullet_lines]
            if plan_lines:
                plan_text = "\n".join(re.sub(r"^\s*(?:\d+\s*[.)\]]?|[-*•])\s*", "", l, flags=re.I).strip() for l in plan_lines)
                await session_log.log_plan(plan_text)
                log_info(f"[agent] Plan: {plan_text[:200]}")
                _cb(opts, "onPlan", plan_text)
        except asyncio.TimeoutError:
            if plan_mode == "on":
                message = f"Planning timed out after {action_timeout:g} seconds. Try a faster model or increase actionTimeoutSeconds in .agent-config.json."
                await session_log.log_message("assistant", message)
                await session_log.end()
                _cb(opts, "onStage", "agent:done")
                _cb(opts, "onChunk", message)
                return message
            _cb(opts, "onNarration", "Planning timed out; continuing without a plan.")
        except Exception as e:  # noqa: BLE001
            log_info(f"[agent] Planning phase failed (non-fatal): {e}")
    elif not plan_text:
        log_info(f"[agent] Plan mode: {plan_mode} — skipping planning phase")

    seen_calls: dict[str, int] = {}
    # Last outcome (ok?) per identical call — the identical-call guard must
    # never claim "kept failing" about calls that SUCCEEDED (three identical
    # successful reads are a loop, not failures — say THAT instead).
    seen_outcomes: dict[str, bool] = {}
    # Consecutive tool-failure tracker — breaks the edit-refusal churn where
    # the model retries a refused edit with a slightly different old_string
    # forever (the identical-call guard never trips because args change).
    fail_streak = 0
    last_fail_note = ""
    compact_notice_shown = False
    # Calls that returned a SUCCESSFUL no-op ("already has exactly this
    # content — no change needed", "preview already running"). The identical
    # call was NOT a failure — exclude it from the identical-call guard so a
    # no-op can never be misreported as "kept failing".
    noop_ok_calls: set[str] = set()
    # Self-sabotage guard state: files the model itself created/edited this run.
    # Deleting your own fresh work (write → delete → write churn) is almost
    # always a confused rewrite loop, not a user request.
    files_touched_this_run: set[str] = set()
    dirty_verify_paths: set[str] = set()
    verification_note = ""

    def record_file_write(write: dict[str, Any]) -> None:
        if write.get("path"):
            dirty_verify_paths.add(str(write["path"]))
        _cb(opts, "onFileWritten", write)
    mutation_failed_ever = False   # any mutation attempt failed at some point
    mut_attempt_failed_last = False  # the most recent tool round had a failed mutation
    mut_recovered_last = False     # a mutation succeeded after that failure
    mut_fail_counts: dict[str, int] = {}  # per-path mutation failure counts (recovery trigger)
    false_success_challenged = False  # one-shot: challenged a false completion claim at the final-answer path
    user_wants_deletion = bool(re.search(r"\b(delet?e|remove|get rid of|clean up)\b", last_user_msg, re.I))
    malformed_tool_calls = 0
    action_failures = 0

    async def action_failed(reason: str, notice: str | None = None) -> str | None:
        nonlocal action_failures
        action_failures += 1
        if action_failures <= action_retry_limit:
            _cb(opts, "onStage", "agent:retry")
            _cb(opts, "onNotice" if notice else "onNarration", f"{notice or reason} Retrying action ({action_failures}/{action_retry_limit}).")
            return None
        message = (f"I stopped because the model repeatedly failed to produce a usable tool action. {reason} "
                   "No unvalidated call was executed. Try a tool-capable coding model or simplify the request.")
        await session_log.log_message("assistant", message)
        await session_log.end()
        _cb(opts, "onStage", "agent:done")
        _cb(opts, "onChunk", message)
        return message
    # Separate budget for "the model replied with NOTHING but reasoning"
    # rounds (empty content, no tool call) — see the empty-response guard.
    empty_response_retries = 0
    # Separate budget for pure tool-FORMAT retries ("looked like a tool call
    # but was not valid JSON"). Previously this shared malformed_tool_calls
    # with the behavioral guards (false-success, promised-work, thinking-has-
    # code...), so a chatty run burned the format budget on behavior retries
    # and lost its chance to fix mere JSON formatting.
    malformed_format_retries = 0
    tool_argument_retries = 0
    completed_steps: list[str] = []
    reading_stage_fired = False

    def maybe_fire_reading() -> None:
        nonlocal reading_stage_fired
        if not reading_stage_fired:
            reading_stage_fired = True
            _cb(opts, "onStage", "agent:reading")

    def fire_resume_state() -> None:
        try:
            _cb(opts, "onResumeState", {
                "history": [{"role": m["role"], "content": m["content"]} for m in history[-60:]],
                **( {"pendingPlan": pending_plan_text} if pending_plan_text else {}),
            })
        except Exception as e:  # noqa: BLE001
            log_info(f"[agent] Failed to save resume state: {e}")

    # Plan-only mode: save the plan and exit
    if plan_mode == "on" and plan_text and not (resume_state.get("history") or []) and not resume_state.get("pendingPlan"):
        pending_plan_text = plan_text
        fire_resume_state()
        plan_lines_fmt = [re.sub(r"^\s*(?:\d+\s*[.)\]]?|[-*•])\s*", "", l.strip()) for l in plan_text.split("\n") if l.strip()]
        plan_response = "**Plan:**\n\n" + "\n".join(f"{i + 1}. {l}" for i, l in enumerate(plan_lines_fmt)) + '\n\nSay **"execute"** or **"go"** to start implementing.'
        await session_log.log_message("assistant", plan_response)
        await session_log.end()
        _cb(opts, "onStage", "agent:done")
        _cb(opts, "onChunk", plan_response)
        return plan_response

    # Loop budget: default MAX_ITERATIONS, but auto-EXTENDS while the run is
    # making progress (tools succeeding, new files touched) up to the hard cap.
    # Per-workspace override: .agent-config.json → "maxSteps": <number>.
    max_iterations = MAX_ITERATIONS
    try:
        cfg_path = Path(root) / ".agent-config.json"
        if cfg_path.exists():
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
            if isinstance(cfg.get("maxSteps"), int) and cfg["maxSteps"] > 0:
                max_iterations = min(cfg["maxSteps"], MAX_ITERATIONS_HARD_CAP)
    except Exception:  # noqa: BLE001
        pass

    resource_key, resources = await acquire_conversation_resources(opts.get("userId"), opts.get("conversationId"), root)
    command_manager = resources["manager"]
    browser_session = resources["browser_session"]
    if resources["browser"]["open"]:
        running = [f'{pid}: {entry["command"]} (cwd: {entry["cwd"]})' for pid, entry in command_manager.processes.items() if not entry["done"]]
        history.append({"role": "user", "content": "[EXISTING BROWSER PREVIEW] This chat has an open browser at "
                        + str(resources["browser"].get("url") or "an unknown URL")
                        + ". Use browser inspect to continue; running background processes: "
                        + ("; ".join(running) if running else "none") + ". Check their status before assuming they are ready."})
    browser_evidence = {"needs_observation": False, "inspected": False, "used": False, "closed_unverified": False, "failed_interaction": False, "failed_open": False}
    browser_inspection_nudges = 0
    browser_revision = 0
    last_browser_observation: str | None = None
    browser_interaction_keys: set[str] = set()

    def tracking_key(call: dict[str, Any]) -> str:
        key = f"{call['tool']}:{json.dumps(call['args'], sort_keys=True)}"
        if call["tool"] == "browser" and call["args"].get("operation") in ("inspect", "screenshot", "console"):
            return f"{key}:browser-state-{browser_revision}"
        return key

    def record_tool_outcome(call: dict[str, Any], result: dict[str, Any], key: str) -> None:
        nonlocal browser_revision, last_browser_observation
        previous = seen_outcomes.get(key)
        ok = bool(result["ok"])
        if call["tool"] == "browser" and previous is not None and previous != ok:
            seen_calls[key] = 1  # A recovered failure or new failure is not the old loop.
        seen_outcomes[key] = ok
        if call["tool"] != "browser" or not ok:
            return
        operation = call["args"].get("operation")
        if operation in ("open", "click", "type"):
            browser_revision += 1
        if operation in ("click", "type"):
            browser_interaction_keys.add(key)
        if operation == "inspect":
            observation = hashlib.sha256(str(result.get("output") or "").encode("utf-8")).hexdigest()
            if last_browser_observation is not None and observation != last_browser_observation:
                for interaction_key in browser_interaction_keys:
                    seen_calls.pop(interaction_key, None)
                browser_interaction_keys.clear()
                seen_calls[key] = 1
            last_browser_observation = observation
    browser_context = {"callbacks": opts.get("callbacks"), "userId": opts.get("userId"),
                       "conversationId": opts.get("conversationId"), "browserSession": browser_session,
                       "use_vision_model": use_vision_model, "signal": signal, "command_manager": command_manager,
                       "browser_state": resources["browser"], "resources": resources, "browser_evidence": browser_evidence}
    cancelled = False
    try:
        iter = 0
        while iter < max_iterations:
            iter += 1
            if signal is not None and signal.is_set():
                raise asyncio.CancelledError()
            pending_image: str | None = None  # raw screenshot for vision-capable models (this iteration)

            needs_summary = len(history) > MAX_HISTORY or sum(estimate_tokens(_IMAGE_MARKER_RE.sub("", str(m.get("content") or ""))) for m in history) > MAX_CONTEXT_TOKENS
            bounded_base = [history[0], *history[-(MAX_HISTORY - 1):]] if len(history) > MAX_HISTORY else history
            plan_block = (
                "\n\nYOUR PLAN (update as you complete steps):\n" + "\n".join(f"{i + 1}. [ ] {l}" for i, l in enumerate(plan_text.split("\n")))
                if (iter == 0 and plan_text)
                else ("\n\nCOMPLETED STEPS:\n" + "\n".join(f"- [x] {s}" for s in completed_steps) if completed_steps else "")
            )

            compact_result = prune_to_budget([
                {"role": "system", "content": ground_truth_block + plan_block},
                *([{"role": "system", "content": build_working_summary(history, opts["messages"], completed_steps, plan_text or "")}] if needs_summary else []),
                *bounded_base,
            ])
            bounded = compact_result["messages"]

            if compact_result["didCompact"] and iter > 0 and not compact_notice_shown:
                log_info(f"[agent] Context compacted: saved {compact_result['tokensSaved']} tokens ({compact_result['originalTokens']} → {compact_result['originalTokens'] - compact_result['tokensSaved']})")
                compact_notice_shown = True
                _cb(opts, "onChunk", "\n\n_⚙️ Context compacted to save space — older tool results were summarized._\n")

            _cb(opts, "onStage", "agent:thinking" if iter == 0 else "agent:working")

            chunks: list[str] = []
            thinking_chunks: list[str] = []
            round_meta: dict[str, Any] = {}
            try:
                await asyncio.wait_for(stream_chat_with_retry({**opts, "toolSchemas": schemas, "protocolState": protocol_state,
                    "roundMeta": round_meta, "actionRetryLimit": action_retry_limit, "actionRound": True}, bounded, chunks.append, thinking_chunks.append), timeout=action_timeout)
            except asyncio.TimeoutError:
                message = (f"I stopped waiting after {action_timeout:g} seconds for the model to produce an action. "
                    "No unfinished tool call was executed. Try a faster coding model or increase actionTimeoutSeconds in .agent-config.json.")
                await session_log.log_message("assistant", message)
                await session_log.end()
                _cb(opts, "onStage", "agent:done")
                _cb(opts, "onChunk", message)
                return message
            raw = "".join(chunks)

            if raw.startswith(("[INVALID NATIVE TOOL CALL]", "[INVALID STRUCTURED ACTION]")):
                malformed_tool_calls += 1
                stopped = await action_failed("The model returned invalid arguments or response format.")
                if stopped:
                    return stopped
                detail = raw.split("]", 1)[-1].strip()[:600]
                correctable = bool(re.search(r"\b(?:browser|run_command)\b", detail, re.I))
                if correctable and tool_argument_retries < 1:
                    tool_argument_retries += 1
                    _cb(opts, "onNarration", "The tool arguments were invalid; retrying with the specific error.")
                else:
                    fallback_after_invalid_action(protocol_state, opts, "The model returned an invalid tool action")
                history.append({"role": "assistant", "content": raw})
                history.append({"role": "user", "content": "[INVALID TOOL ARGUMENTS] The call did not run. " + detail
                    + ' For a static page use browser {"operation":"open","path":"index.html"}; '
                      'for page contents use {"operation":"inspect"}; for a click use {"operation":"click","selector":"<selector from inspect>"}. '
                      'For a background command use {"command":"...","background":true}. Use only arguments for the chosen operation.'})
                continue

            structured_final = bool(round_meta.get("structuredFinal"))
            tool_calls = [] if structured_final else extract_tool_calls(raw)
            tool_call = tool_calls[0] if len(tool_calls) == 1 else None

            # Truncated-generation guard: a salvaged MUTATING call means the
            # model ran out of tokens mid-JSON (unclosed content string).
            # Executing it would silently write a HALF file — the exact bug
            # behind "the file only has 32 lines / ends at 'cyan'". Refuse it
            # with instructions; the model retries in smaller pieces.
            truncated_calls = [
                tc for tc in tool_calls
                if (tc.get("args") or {}).pop("_truncated", None) and tc["tool"] in (MUTATING_TOOLS | EXECUTION_TOOLS)
            ]
            if truncated_calls:
                stopped = await action_failed("The tool call was cut off.")
                if stopped:
                    return stopped
                t_paths = ", ".join(str(tc["args"].get("path") or "unknown") for tc in truncated_calls)
                log_info(f"[agent] Refusing truncated tool call(s): {[tc['tool'] for tc in truncated_calls]} → {t_paths}")
                malformed_tool_calls += 1
                history.append({"role": "assistant", "content": raw})
                history.append({"role": "user", "content": (
                    "[TRUNCATED CALL] Your last tool call was cut off mid-JSON (you likely ran out of output tokens), "
                    f"so it was NOT executed ({t_paths}). Do NOT retry the same full call. "
                    "Instead: write files in SMALLER pieces — create the file with just the first part via write_file, then "
                    "append the rest with edit_lines (read_file with \"numbers\": true, then "
                    '{"tool": "edit_lines", "args": {"path": "<file>", "start": <last line + 1>, "end": <last line>, "content": "<next part>"}} — '
                    "that inserts new lines without copying the file back). Keep every single call "
                    "well under the output limit. If even one part is too big, split it again."
                )})
                _cb(opts, "onStage", "agent:working")
                continue
            if tool_calls:
                action_failures = 0
                tool_argument_retries = 0
            # Per-round mutation bookkeeping (drives the false-success guard):
            # paths a mutation was ATTEMPTED on vs paths where it actually
            # SUCCEEDED. A refused write_file must never count as "touched".
            mutated_attempted: set[str] = set()
            mutated_ok: set[str] = set()

            # Empty-response guard: reasoning-tuned local models sometimes put
            # their ENTIRE answer in the thinking channel and return an empty
            # content string — no text, no tool call. Unhandled, that fell
            # straight through to the final-answer path (nothing to send) and
            # the empty-reply rescue printed its "incomplete tool call / no
            # work had been done" dead-end on the very FIRST round, without
            # the model ever being asked to actually answer. Ask it to reply.
            if not tool_calls and not raw.strip():
                empty_response_retries += 1
                if empty_response_retries <= 2:
                    stopped = await action_failed("The model returned an empty response.", "The model sent no answer — asking it to reply.")
                    if stopped:
                        return stopped
                    fallback_after_invalid_action(protocol_state, opts, "The model returned no action")
                    log_info("[agent] Empty content with no tool call — nudging model to reply")
                    history.append({"role": "assistant", "content": raw or "(no answer)"})
                    history.append({"role": "user", "content": (
                        "[EMPTY REPLY] Your last response contained NO text and NO tool call — you reasoned but never answered. "
                        "Reply now with EITHER one valid JSON tool call "
                        '(e.g. {"tool": "read_file", "args": {"path": "snake.py"}}) '
                        "OR a short plain-text answer for the user. Do not reply with reasoning only."
                    )})
                    _cb(opts, "onStage", "agent:working")
                    continue
                log_info("[agent] Model kept returning empty content — falling back to an honest message")

            # Thinking is streamed live via the tap in stream_chat_with_retry —
            # no replay here (it would double-emit on the client).

            # Pre-tool prose ("Let me check the structure first") is emitted
            # later as a narration event, right before the tools run — not as
            # thinking, which would bury the model's words in the accordion.

            # Multiple VALID calls are accepted and executed sequentially (the
            # parallel branch below handles read-only batching). Only unparseable
            # responses count as malformed — a correct multi-call answer must
            # NOT burn a retry slot.

            if not structured_final and not tool_calls and malformed_tool_calls < 4:
                names = "|".join(re.escape(tool["name"]) for tool in available_tools(auto_apply))
                plain_tools = re.findall(r"\b(" + names + r")\b", raw)
                # An honest failure report naturally MENTIONS tool names ("my
                # write_file was refused")
                # — that is exactly what we asked the model to say, so never
                # punish it as "plain-text tool attempt".
                honest_failure_report = (
                    "{" not in raw
                    and bool(re.search(r"\b(failed|refused|unable|could not|couldn'?t|nothing (was|has) changed|not changed|did not (change|apply|write))\b", raw, re.I))
                )
                if plain_tools and not honest_failure_report:
                    unique_tools = list(dict.fromkeys(plain_tools))
                    if len(unique_tools) > 1:
                        malformed_tool_calls += 1
                        retry_msg = (
                            f"You output {len(unique_tools)} tool names as plain text, but you MUST call only ONE tool at a time using valid JSON. "
                            f'Respond with ONLY a single JSON object like: {{"tool": "{unique_tools[0]}", "args": {{}}}} '
                            "Choose the SINGLE most important tool and use proper JSON format. No markdown, no extra text."
                        )
                        history.append({"role": "assistant", "content": raw})
                        history.append({"role": "user", "content": retry_msg})
                        _cb(opts, "onStage", "agent:working")
                        continue

            looks_like_tool_attempt = not structured_final and not tool_calls and bool(
                re.search(r'\{\s*"tool"\s*:\s*"[a-z_]+"|\{\s*"?args"?\s*:', raw, re.I)
                # OpenAI-style dialect — also a tool attempt
                or re.search(r'\{\s*"name"\s*:\s*"[a-z_]+"|\{\s*"?arguments"?\s*:', raw, re.I)
                or re.search(r'"(args|arguments)"\s*:\s*\{\s*"(?:path|command|query|content|from|to|pattern)"', raw, re.I)
                # Bracket / paren call syntax — the model TRIED to act, and if
                # it slips past the salvagers the user must get a retry rather
                # than watching it TALK about reading or testing the file.
                or re.search(r'\[\s*["\']?[a-z_][a-z0-9_]*["\']?\s*[,\{\]]', raw)
                or re.search(r'\b[a-z_][a-z0-9_]*\s*\(\s*["\']?(?:path|command|query|code|url|pattern|old_string)["\']?\s*[=:]', raw, re.I)
            )
            code_block_rescue = looks_like_tool_attempt and malformed_format_retries >= 2 and "```" in raw
            if code_block_rescue:
                log_info("[agent] Tool-call retries exhausted but response contains code blocks — treating as final answer (auto-apply will process them)")
            elif looks_like_tool_attempt and malformed_format_retries < 4:
                malformed_format_retries += 1
                stopped = await action_failed("The model emitted an unparseable tool call.")
                if stopped:
                    return stopped
                _cb(opts, "onChunk", "\n\n_⚙️ Tool call was malformed — retrying with format instructions…_\n")
                retry_msg = (
                    "Your previous response looked like a tool call but was NOT valid JSON, so nothing was executed. "
                    'If you want to call a tool, respond with ONLY a single valid JSON object with NO code fences and NO extra text — '
                    'e.g. {"tool": "write_file", "args": {"path": "src/main.py", "content": "print(1)\\n"}} — and escape all quotes and newlines properly. '
                    "NEVER write a call as [read_file, {...}] or read_file(path=\"...\") — that syntax is NOT JSON and "
                    "executes NOTHING, so the work never happens. "
                    "If you do NOT want to call a tool, reply normally with your final answer."
                )
                history.append({"role": "assistant", "content": raw})
                history.append({"role": "user", "content": retry_msg})
                _cb(opts, "onStage", "agent:working")
                continue

            applied_note = ""
            if not tool_calls and auto_apply and unrestricted and not structured_final:
                applied_note = await apply_code_block_files(root, raw, record_file_write)
                if not applied_note and "```" in raw:
                    block_count = len(re.findall(r"```", raw)) // 2
                    log_info(f"[agent] Response contains {block_count} code block(s) but none matched auto-apply format — no files written")
                    if auto_apply and malformed_tool_calls < 4:
                        malformed_tool_calls += 1
                        retry_msg = (
                            "Your response contained code blocks but they were NOT auto-applied because no filename was detected. "
                            "To auto-apply, either: (1) start the code block with a comment like # filename.py, or "
                            '(2) use the write_file tool: {"tool": "write_file", "args": {"path": "filename.py", "content": "..."}}. '
                            "Retry with the correct format."
                        )
                        history.append({"role": "assistant", "content": raw})
                        history.append({"role": "user", "content": retry_msg})
                        _cb(opts, "onStage", "agent:working")
                        continue

            # False-success guard, part 1: claiming done while EVERY mutation
            # this run failed. The classic transcript: write refused → read_file
            # → another failed edit → "I have successfully added the menu
            # system" — with nothing on disk. files_touched_this_run is
            # success-based now, so refused writes no longer disarm this; and
            # the condition is ever-based, so an interleaved read-only round
            # can't reset it either. Real work landing (files_touched) keeps
            # legitimate wrap-ups allowed.
            claims_done = (
                not tool_calls and not applied_note and auto_apply
                and bool(re.search(r"\b(?:done|i'?ve|finished|completed|created|wrote|refactored|moved|extracted|split|committed|pushed|deployed|saved|updated|fixed|added|removed|deleted|renamed)\b", raw, re.I))
                and "```" not in raw
                and len(raw) < 3000
                and not files_touched_this_run  # real work already happened — a wrap-up is legitimate
                and not ((browser_evidence["used"] or browser_evidence["failed_open"] or browser_evidence["failed_interaction"])
                         and re.search(r"\b(?:browser|opened|loaded|inspected|clicked|pressed|typed|checked)\b", raw, re.I))
                and not (mutation_failed_ever and not mutated_ok)  # writes were attempted and EVERY one failed
            )
            if claims_done and malformed_tool_calls < 4:
                malformed_tool_calls += 1
                if mutation_failed_ever and not files_touched_this_run:
                    retry_msg = (
                        "Your write/edit attempts FAILED (see the tool results above) — NO file was changed this run. "
                        "Do NOT claim success. Either fix the problem with a tool call (edit_lines by line number, "
                        'or edit_file with a small old_string taken from the current file), '
                        "or if you genuinely cannot proceed, tell the user honestly what failed and stop."
                    )
                else:
                    retry_msg = (
                        "You said you were done but you did NOT actually call any tools. "
                        "You must use the available file tools to make changes — do NOT just describe what you did. "
                        'Respond with a JSON tool call like: {"tool": "write_file", "args": {"path": "filename.py", "content": "..."}}'
                    )
                history.append({"role": "assistant", "content": raw})
                history.append({"role": "user", "content": retry_msg})
                _cb(opts, "onStage", "agent:working")
                continue

            thinking_text = "".join(thinking_chunks)
            thinking_has_code = len(thinking_text) > 200 and bool(re.search(r"\b(import |class |def |function |const |let |var |#include)\b", thinking_text))
            response_is_empty = len(raw) < 500 and bool(re.search(r"\b(nothing|didn't|did not|no output|no code|no file|no result|pipeline didn't|cut off|cut short|stopped)\b", raw, re.I))
            if thinking_has_code and (not tool_calls or response_is_empty) and auto_apply and malformed_tool_calls < 4:
                malformed_tool_calls += 1
                retry_msg = (
                    "You wrote code in your thinking/reasoning but you must use the tools to actually create files. "
                    "Your thinking should only contain brief strategy notes (1-2 sentences), not code. "
                    "Use write_file or edit_file tools to create/modify files. "
                    'Respond with a JSON tool call like: {"tool": "write_file", "args": {"path": "filename.py", "content": "your code here"}}'
                )
                history.append({"role": "assistant", "content": raw})
                history.append({"role": "user", "content": retry_msg})
                _cb(opts, "onStage", "agent:working")
                continue

            # Promise-of-future-work guard: the model "plans out loud" ("I'll
            # create the game now") without calling any tool and ends the run —
            # the user gets words instead of files. Auto-apply, no writes yet → retry.
            promised_work = (
                not tool_calls and not applied_note and auto_apply
                and not completed_steps
                and bool(re.search(r"\b(?:i'?ll|i will|going to|let me|let['’]?s|next,? i|now,? i'?ll)\b", raw, re.I))
                and bool(re.search(r"\b(?:create|write|make|build|implement|add|generate)\b", raw, re.I))
                and "```" not in raw
                and len(raw) < 1500
            )
            if promised_work and malformed_tool_calls < 4:
                malformed_tool_calls += 1
                stopped = await action_failed("The model described work without calling a tool.")
                if stopped:
                    return stopped
                fallback_after_invalid_action(protocol_state, opts, "The model described work without calling a tool")
                retry_msg = (
                    "Do NOT describe what you will do — DO it now. "
                    "Your task is not finished: no files have been written yet. "
                    'Respond with a single JSON tool call, e.g. {"tool": "write_file", "args": {"path": "snake_game.py", "content": "..."}} '
                    "— and remember to escape newlines as \\n inside the JSON string."
                )
                history.append({"role": "assistant", "content": raw})
                history.append({"role": "user", "content": retry_msg})
                _cb(opts, "onStage", "agent:working")
                continue

            # "Talked instead of acting": the model narrates a read/check/test
            # ("Let me read snake_game.py and fix it") but emits NO valid tool
            # call, so nothing runs while the user is told it is investigating.
            # The promised_work guard above only covers create/write promises
            # and only before any work has been done, so it misses this.
            promised_action = (
                not tool_calls and not applied_note and auto_apply
                and bool(re.search(r"\b(?:i'?ll|i will|let me|let['’]?s|i'?m going to|i am going to|now i'?ll)\b", raw, re.I))
                and bool(re.search(r"\b(?:read|check|test|run|play|verify|inspect|examine|review|replay|try out)\b", raw, re.I))
                and not re.search(r"\blet me know\b", raw, re.I)
                and "```" not in raw
                and len(raw) < 1200
            )
            if promised_action and malformed_tool_calls < 4:
                malformed_tool_calls += 1
                stopped = await action_failed("The model described an action without calling a tool.")
                if stopped:
                    return stopped
                fallback_after_invalid_action(protocol_state, opts, "The model described an action without calling a tool")
                log_info("[agent] Promised a read/test with no tool call — nudging to actually act")
                history.append({"role": "assistant", "content": raw})
                history.append({"role": "user", "content": (
                    "You said you would read, check, test or run something — but you made NO valid tool call, "
                    "so NOTHING happened. Do not narrate; act. Respond with a single valid JSON tool call now, "
                    'e.g. {"tool": "read_file", "args": {"path": "snake_game.py"}} — plain JSON, no brackets, '
                    "no code fences, no extra text. Never claim you read, tested or verified anything without "
                    "a tool call that actually did it."
                )})
                _cb(opts, "onStage", "agent:working")
                continue

            refuses_tools = (
                not tool_calls and not applied_note and auto_apply
                and bool(re.search(r"\b(not a coding|shouldn'?t (write|create|use tool)|normal conversation|chatbot|copy (it|the|this)|save (it|the|this)|here is the code)\b", raw, re.I))
                and len(raw) < 2000
            )
            if refuses_tools and malformed_tool_calls < 4:
                malformed_tool_calls += 1
                retry_msg = (
                    "You ARE a coding agent. You MUST create files using the write_file tool. "
                    "This is NOT a normal conversation — you have file tools and MUST use them. "
                    'Respond with a JSON tool call: {"tool": "write_file", "args": {"path": "filename.py", "content": "..."}}'
                )
                history.append({"role": "assistant", "content": raw})
                history.append({"role": "user", "content": retry_msg})
                _cb(opts, "onStage", "agent:working")
                continue

            malformed_note = (
                "\n\n_(I tried to execute a tool call from your last response but it was not valid JSON, so nothing was executed.)_"
                if looks_like_tool_attempt and not tool_calls and malformed_format_retries >= 2
                else ""
            )

            if not tool_calls:
                original_final_raw = raw
                if browser_evidence["needs_observation"]:
                    honest_failure = bool(re.search(r"\b(?:could not|couldn't|unable|did not|didn't|not able|not)\b.{0,70}\b(?:inspect|check|verify|test|view)\b", raw, re.I))
                    if not honest_failure and browser_inspection_nudges < 2:
                        browser_inspection_nudges += 1
                        history.append({"role": "assistant", "content": raw})
                        history.append({"role": "user", "content": "[BROWSER VERIFICATION] Opening a page or clicking does not verify the result. Call browser inspect now to observe the current page, then report what actually happened. If inspection is unavailable, say so without claiming success."})
                        continue
                    if not honest_failure:
                        raw = ("I made file changes. " if files_touched_this_run else "") + "I could not verify the page or the last browser interaction. Please check the browser pane."
                elif browser_evidence["closed_unverified"]:
                    raw += "\n\nThe browser was closed before I could inspect the result."
                if (browser_evidence["failed_interaction"]
                        and re.search(r"\b(?:clicked|pressed|typed|tested|worked|working)\b", raw, re.I)
                        and not re.search(r"\b(?:failed|unable|could not|couldn't|did not|didn't|not able)\b", raw, re.I)):
                    raw = "I could not complete the browser interaction. The tool result explains what failed."
                if (browser_evidence["failed_open"]
                        and re.search(r"\b(?:opened|loaded|working|works|visible)\b", raw, re.I)
                        and not re.search(r"\b(?:failed|unable|could not|couldn't|did not|didn't|not able)\b", raw, re.I)):
                    raw = ("I made file changes, but " if files_touched_this_run else "") + "I could not open the page in the browser. The tool result explains what failed."
                if raw != original_final_raw:
                    chunks = [raw]
                if unrestricted and dirty_verify_paths:
                    checks = await detect_verify_for_paths(root, dirty_verify_paths)
                    dirty_verify_paths.clear()
                    results = []
                    failed_checks = []
                    for check in checks:
                        _cb(opts, "onStage", "agent:verify")
                        verify_out = await _run_verify(check["command"], check["cwd"], 3000, signal)
                        results.append(f"{check['label']} in {check['cwd']}:\n{verify_out}")
                        if verify_out.startswith("FAILED"):
                            failed_checks.append(check["label"])
                        await session_log.log_verify(check["command"], verify_out, not verify_out.startswith("FAILED"))
                        _cb(opts, "onAgentCommand", {"command": check["command"], "output": verify_out, "failed": verify_out.startswith("FAILED")})
                    verification_note = ("\n\nVerification: " + ("failed: " + ", ".join(failed_checks) if failed_checks else "passed: " + ", ".join(check["label"] for check in checks))) if checks else "\n\nVerification: no check was detected for the changed files."
                    if failed_checks:
                        history.append({"role": "assistant", "content": raw})
                        history.append({"role": "user", "content": "[FINAL VERIFICATION]\n" + "\n\n".join(results) + "\nThe check failed. Fix it or explain the failure."})
                        continue
                # Game-check guard: never let a run finish on a "fixed!" claim
                # while the LAST automatic play test still failed. Bounded (2
                # nudges) so an honest "it is still broken" reply can still ship.
                if (
                    auto_apply
                    and game_target
                    and last_game_failed
                    and game_stop_nudges < 2
                    and bool(re.search(
                        r"\b(?:done|fixed|fix|works|working|should be|now moves|moves now|solved|finished|completed|added|repaired|resolved)\b",
                        raw,
                        re.I,
                    ))
                ):
                    game_stop_nudges += 1
                    malformed_tool_calls += 1
                    log_info(
                        f"[agent] Completion claim while the last game check failed ({last_game_verdict}) — challenging"
                    )
                    history.append({"role": "assistant", "content": raw})
                    history.append({"role": "user", "content": (
                        f"[SYSTEM] The last automatic game check FAILED — when I played {game_target['path']} "
                        f"headlessly, {_GAME_VERDICT_LABELS.get(last_game_verdict or 'failed', 'it did not behave correctly')}. "
                        "You must NOT tell the user it is fixed, and never write \"it should be fixed now\" without a "
                        "passing check. Either make a corrected tool call now (it will be replayed and re-checked "
                        "automatically), or reply honestly that it is still broken and say what you found."
                    )})
                    _cb(opts, "onStage", "agent:working")
                    continue

                # False-success guard, part 2 (the catch-all): a completion
                # claim that reaches the final-answer path while EVERY mutation
                # this run failed must not ship as-is. claims_done (part 1)
                # challenges mid-loop; this covers the rounds where part 1's
                # malformed_tool_calls budget was already spent or the claim
                # wording dodged the keyword regex. One challenge max, then the
                # claim goes out anyway (guarded against loops).
                if (
                    auto_apply
                    and mutation_failed_ever
                    and not mutated_ok
                    and not files_touched_this_run
                    and not false_success_challenged
                    and bool(re.search(r"\b(?:done|i'?ve|finished|completed|created|wrote|successfully|fixed|added|implemented|updated|succeeded)\b", raw, re.I))
                ):
                    false_success_challenged = True
                    malformed_tool_calls += 1
                    log_info("[agent] False-success claim after total write failure — challenging once at final-answer path")
                    history.append({"role": "assistant", "content": raw})
                    history.append({"role": "user", "content": (
                        "[SYSTEM] Your write/edit attempts this run ALL FAILED (see the tool results above) — NO file was changed. "
                        "You must NOT tell the user the task succeeded. Either make a corrected tool call now, "
                        "or reply with an honest summary of what failed and why. Do not claim success."
                    )})
                    _cb(opts, "onStage", "agent:working")
                    continue
                await session_log.log_message("assistant", raw)
                await session_log.end()
                _cb(opts, "onStage", "agent:done")
                tool_json_start_re = re.compile(r"(?:^|\n)\s*\{\s*\"tool\"\s*:", re.I | re.M)
                tool_frag_re = re.compile(r'(?:^|\n)\s*\{?\s*(?:"?tool"?\s*:\s*"[a-z_]+"|"args"\s*:\s*\{|:\s*"[a-z_]+"\s*,\s*"args")', re.I | re.M)
                strip_start = -1
                if looks_like_tool_attempt:
                    m1 = tool_json_start_re.search(raw)
                    m2 = tool_frag_re.search(raw)
                    candidates = [m.start() for m in (m1, m2) if m]
                    # Cut the message at a tool-JSON fragment ONLY when the
                    # text before it is too short to be a real answer (<120
                    # chars). A fragment the model quoted mid-prose must not
                    # erase the whole message — that left "nothing" and fired
                    # the premature "Wrapping up…" rescue on healthy replies.
                    if candidates:
                        s = min(candidates)
                        if len(raw[:s].strip()) < 120:
                            # Essentially a bare tool call — strip it.
                            strip_start = s
                        # else: substantial prose precedes the fragment — the
                        # model is QUOTING a call inside its answer; stripping
                        # would erase the real reply and fire the premature
                        # "Wrapping up…" rescue on healthy runs.
                clean_raw = raw[:strip_start].strip() if strip_start >= 0 else raw
                clean_chunks = chunks
                if looks_like_tool_attempt and strip_start >= 0:
                    result_chunks: list[str] = []
                    pos = 0
                    for c in chunks:
                        if pos + len(c) <= strip_start:
                            result_chunks.append(c)
                        elif pos >= strip_start:
                            break
                        else:
                            before = c[:strip_start - pos]
                            if before.rstrip():
                                result_chunks.append(before.rstrip())
                        pos += len(c)
                    clean_chunks = result_chunks
                for c in clean_chunks:
                    _cb(opts, "onChunk", c)
                suffix = (("\n\n" + applied_note) if applied_note else "") + malformed_note + verification_note
                if suffix:
                    _cb(opts, "onChunk", suffix)
                    return ("".join(clean_chunks) or clean_raw) + suffix
                if ("".join(clean_chunks).strip() or clean_raw.strip()):
                    return "".join(clean_chunks) or clean_raw
                # ── Last-chance rescue: the "final answer" was EMPTY ──────
                # Every byte of the final reply was either a stripped tool-call
                # fragment or nothing at all (the model answered entirely
                # inside its thinking channel). Never dead-end the run here:
                # ask the model once more for a plain-text reply. When the run
                # actually DID something (tools ran, files were touched) that
                # reply is a wrap-up summary; with zero tool activity a
                # fabricated "here is what I did" would be a lie, so that
                # variant asks for an honest answer (or question) instead.
                had_tool_activity = bool(files_touched_this_run or completed_steps or seen_outcomes)
                log_info(f"[agent] Final answer was empty after stripping tool-call fragments (tool activity: {had_tool_activity}) — running rescue reply")
                _cb(opts, "onChunk", (
                    "\n\n_⚙️ Wrapping up…_\n" if had_tool_activity
                    else "\n\n_⚙️ No answer came back — asking the model to reply…_\n"
                ))
                rescue_system = (
                    "You are a coding agent finishing a task. Reply with a SHORT plain-text summary (2-4 sentences) of what you did and how to use the result. NO tool calls, NO JSON, NO code blocks, NO markdown headers."
                    if had_tool_activity
                    else "You are a coding agent. Your previous reply was EMPTY — it contained no text and no tool call. Reply to the user NOW with a short plain-text message (2-4 sentences): either answer them directly, or state honestly what you need to proceed. Do NOT claim any work you did not do. NO tool calls, NO JSON, NO code blocks."
                )
                rescue_user = (
                    "Your tool calls are done. Give your short final summary now in plain text."
                    if had_tool_activity
                    else "Reply now with your short plain-text message. No tool calls."
                )
                rescue_chunks: list[str] = []
                try:
                    await stream_chat(
                        model,
                        [
                            {"role": "system", "content": rescue_system},
                            *bounded[-8:],
                            {"role": "user", "content": rescue_user},
                        ],
                        lambda c: rescue_chunks.append(c),
                        StreamOptions(
                            signal=signal,
                            temperature=0.3,
                            max_tokens=3000,
                            think=False,
                            base_url=opts.get("cloudEndpoint") or None,
                            api_key=opts.get("cloudApiKey") or None,
                            on_metrics=(opts.get("callbacks") or {}).get("onMetrics"),
                        ),
                    )
                except asyncio.CancelledError:
                    raise
                except Exception as e:  # noqa: BLE001
                    log_info(f"[agent] Rescue summary failed: {e}")
                rescue_text = "".join(rescue_chunks).strip()
                if rescue_text:
                    await session_log.log_message("assistant", rescue_text)
                    await session_log.end()
                    _cb(opts, "onStage", "agent:done")
                    _cb(opts, "onChunk", rescue_text)
                    return rescue_text
                fallback = (
                    "I could not produce a final answer this time — the model kept replying without a usable answer or tool call. "
                    "Try rephrasing the request, or check Ollama Settings → Model Assignments and pick a stronger coding model for Koding."
                )
                await session_log.log_message("assistant", fallback)
                await session_log.end()
                _cb(opts, "onStage", "agent:done")
                _cb(opts, "onChunk", fallback)
                return fallback

            # ── Tool execution (single or multiple) ───────────────────
            is_single = len(tool_calls) == 1
            calls_to_run = tool_calls

            # Self-sabotage guard: block delete_file on files the model itself
            # wrote this run when the user never asked for a deletion.
            if not user_wants_deletion:
                blocked_deletes = [
                    tc for tc in calls_to_run
                    if tc["tool"] == "delete_file"
                    and str(tc["args"].get("path") or "").replace("\\", "/").lower() in files_touched_this_run
                ]
                if blocked_deletes:
                    paths = ", ".join(str(tc["args"].get("path")) for tc in blocked_deletes)
                    log_info(f"[agent] Blocked self-sabotage delete of own work: {paths}")
                    calls_to_run = [tc for tc in calls_to_run if tc not in blocked_deletes]
                    history.append({"role": "user", "content": (
                        f"[DELETE BLOCKED] You tried to delete {paths} — a file YOU created/edited in this run. "
                        "Do not delete your own work. If the file content is wrong, FIX it with edit_file or write_file "
                        "(keeping unchanged lines), or ask the user before deleting anything."
                    )})
                    if not calls_to_run:
                        continue

            for tc in calls_to_run:
                k = tracking_key(tc)
                if k in noop_ok_calls:
                    continue  # successful no-op — repeating it is not a failure
                seen_calls[k] = seen_calls.get(k, 0) + 1
                repeat_limit = (10 if tc["tool"] == "run_command" and tc["args"].get("operation") == "status"
                                else 6 if tc["tool"] == "browser" and tc["args"].get("operation") in ("click", "type")
                                else 3)
                if seen_calls[k] >= repeat_limit:
                    # Give up with an ACTIONABLE, HONEST message — never dump
                    # raw JSON at the user, and never claim "kept failing"
                    # about calls that actually succeeded (a successful read
                    # repeated 3× is a loop, not a failure).
                    attempted = str(tc["args"].get("path") or tc["args"].get("command") or tc["args"].get("query") or "the operation")
                    last_ok = seen_outcomes.get(k)
                    if last_ok is True:
                        msg = (
                            f"I paused: I repeated the same successful {tc['tool']} call on {attempted} several times, "
                            "which means I was looping instead of making progress. The call itself worked each time — "
                            "tell me how you'd like to proceed."
                        )
                    elif tc["tool"] == "write_file" and not files_touched_this_run:
                        msg = (
                            f"I stopped: my write_file calls for {attempted} kept being refused as full rewrites. "
                            "Tell me how you'd like to proceed — for example: keep the current file and list the exact changes "
                            "you want, or let me delete the file first and recreate it from scratch."
                        )
                    else:
                        msg = (
                            f"I stopped because my {tc['tool']} attempt on {attempted} kept failing the same way. "
                            "The tool result in the log above explains why. Tell me how you'd like to proceed — for example: "
                            "re-read the file and try a different approach, or run the step manually."
                        )
                    log_info(f"[agent] Identical-call guard tripped: {tc['tool']} x{seen_calls[k]}")
                    _cb(opts, "onStage", "agent:done")
                    _cb(opts, "onChunk", msg)
                    return msg


            proposed_calls = calls_to_run
            calls_to_run, permission_feedback = await authorize_tool_calls(calls_to_run, opts, signal, session_log)
            for denied in proposed_calls:
                if denied not in calls_to_run and denied["tool"] == "browser":
                    if denied["args"].get("operation") == "open":
                        browser_evidence["failed_open"] = True
                    elif denied["args"].get("operation") in ("click", "type"):
                        browser_evidence["failed_interaction"] = True
            if permission_feedback:
                history.append({"role": "assistant", "content": raw})
                history.append({"role": "user", "content": "\n".join(permission_feedback)})
            if not calls_to_run:
                continue

            _cb(opts, "onStage", "agent:tool")
            history.append({"role": "assistant", "content": raw})
            await session_log.log_message("assistant", raw)

            # Narration: the sentence(s) the model wrote before the tool call
            # ("Now let me write the snake movement function"). Emitted as its
            # own event so the client can show it between thinking and the
            # tool row — makes the run feel alive instead of
            # thinking -> tool -> thinking -> tool.
            narration = extract_narration(raw)
            if narration:
                _cb(opts, "onNarration", narration)

            has_mutating = any(tc["tool"] in MUTATING_TOOLS for tc in calls_to_run)
            all_read_only = all(tc["tool"] not in (MUTATING_TOOLS | EXECUTION_TOOLS) for tc in calls_to_run)

            if all_read_only and len(calls_to_run) > 1:
                _cb(opts, "onStage", "agent:tool-parallel")
                results: list[tuple[dict[str, Any], dict[str, Any]]] = []
                for tc in calls_to_run:
                    _cb(opts, "onToolStart", tc)
                    log_info(f"[agent] Tool call (parallel): {tc['tool']} {json.dumps(tc['args'])[:100]}")
                    await session_log.log_tool_call(tc["tool"], tc["args"])
                    r = await execute_tool(root, tc, auto_apply, extra=browser_context)
                    record_tool_outcome(tc, r, tracking_key(tc))
                    await session_log.log_tool_result(tc["tool"], r["output"], r["ok"])
                    _cb(opts, "onToolResult", {"tool": tc["tool"], "ok": r["ok"], "output": str(r["output"])[:2000]})
                    results.append((tc, r))
                result_parts = [f"[TOOL RESULT — {tc['tool']}]\n{r['output']}" for tc, r in results]
                combined = "\n\n".join(result_parts)
                parallel_img = next((r.get("imageData") for _, r in results if r.get("imageData")), None)
                if parallel_img:
                    combined += f"\n\n[image:{parallel_img}]"
                history.append({"role": "user", "content": combined})
                await session_log.log_message("user", "\n\n".join(result_parts))
                for tc, result in results:
                    if tc["tool"] in ("list_files", "read_file", "search_files"):
                        maybe_fire_reading()
                    for write in result.get("fileWrites", [result["fileWrite"]] if result.get("fileWrite") else []):
                        record_file_write(write)
            else:
                for tc in calls_to_run:
                    _cb(opts, "onToolStart", tc)
                    log_info(f"[agent] Tool call: {tc['tool']} {json.dumps(tc['args'])[:120]}")
                    await session_log.log_tool_call(tc["tool"], tc["args"])
                    outcome_key = tracking_key(tc)
                    result = await execute_tool(root, tc, auto_apply, extra=browser_context)
                    if tc["tool"] == "browser" and tc["args"].get("operation") == "open":
                        browser_evidence["failed_open"] = not result["ok"]
                    record_tool_outcome(tc, result, outcome_key)
                    # Raw screenshot for a vision-capable code model: the image
                    # rides on this variable into the ONE history append below
                    # (via the message marker the Ollama client converts — not
                    # into the client-visible output, the session log, or the
                    # saved resume state). This is the model's "eyes".
                    pending_image = result.get("imageData")
                    log_output = result["output"]
                    await session_log.log_tool_result(tc["tool"], log_output, result["ok"])
                    _cb(opts, "onToolResult", {"tool": tc["tool"], "ok": result["ok"], "output": str(result["output"])[:2000]})
                    # Track successful no-ops so the identical-call guard never
                    # mistakes a benign repeat ("already has exactly this
                    # content — no change needed") for a failure.
                    if result["ok"] and tc["tool"] in NOOP_OK_TOOLS:
                        out_str = str(result["output"])
                        if "no change needed" in out_str or "already running" in out_str:
                            noop_ok_calls.add(f"{tc['tool']}:{json.dumps(tc['args'], sort_keys=True)}")
                    # Success-based mutation tracking: only a tool result that
                    # actually changed (or correctly no-op'd) the file counts.
                    if tc["tool"] in MUTATING_TOOLS:
                        mp = str(tc["args"].get("path") or tc["args"].get("file") or "").replace("\\", "/").lower()
                        if mp:
                            mutated_attempted.add(mp)
                            if result["ok"] and "Refusing to overwrite" not in str(result["output"]):
                                mutated_ok.add(mp)
                                # Real progress: a mutation just landed. Repeats
                                # of earlier calls (re-running the same test
                                # command, re-reading the same file) are now
                                # responding to a CHANGED workspace — reset the
                                # identical-call counter so legitimate
                                # fix→verify→fix→verify cycles don't trip the
                                # loop guard mid-debugging.
                                seen_calls.clear()
                                # Same for the per-path failure count: failures
                                # from BEFORE this success are a stale pattern.
                                mut_fail_counts.pop(mp, None)
                    # Churn breaker: 3 consecutive tool failures → stop retrying.
                    # A refused edit retried with a tweaked old_string used to burn
                    # ALL remaining iterations (many minutes) without progress.
                    # Read/inspect tools legitimately "fail" while the model
                    # works toward a fix (file not created yet, empty search,
                    # a path it hasn't written) — counting them toward the
                    # churn breaker trips it on healthy runs and produced the
                    # "read_file kept failing" give-up. Only mutations and
                    # commands count as churn.
                    churn_capable = tc["tool"] in MUTATING_TOOLS
                    if not result["ok"] and churn_capable:
                        fail_streak += 1
                        last_fail_note = str(result["output"]).split("\n")[0][:200]
                        # Auto-recovery for the classic repeated-edit failure:
                        # the model re-sends an edit whose old_string no longer
                        # matches the real file (stale mental model, or it
                        # already applied it). Instead of letting it blindly
                        # retry, feed it the CURRENT file content — usually the
                        # next attempt then succeeds. Also covers write_file
                        # rewrite refusals: the model has no ground truth, so
                        # it keeps re-rolling full-file rewrites that get
                        # refused; seeing the real content flips it to edit_file.
                        wants_recovery = tc["tool"] in ("edit_file", "edit_lines") or (
                            tc["tool"] == "write_file" and "Refusing to overwrite" in str(result["output"])
                        )
                        # Count failures PER PATH across the run (a read_file
                        # between two refused writes resets the consecutive
                        # streak, which used to hide the pattern and starve
                        # auto-recovery). Requires ≥2 failures of mutation
                        # tools on the SAME path.
                        if tc["tool"] in ("edit_file", "edit_lines", "write_file"):
                            fp = str(tc["args"].get("path") or "").replace("\\", "/").lower()
                            if fp:
                                mut_fail_counts[fp] = mut_fail_counts.get(fp, 0) + 1
                        path_fail_count = mut_fail_counts.get(str(tc["args"].get("path") or "").replace("\\", "/").lower(), 0)
                        if wants_recovery and (fail_streak >= 2 or path_fail_count >= 2):
                            edit_path = str(tc["args"].get("path") or "")
                            try:
                                resolved = await resolve_target_smart(root, edit_path)
                                if resolved.get("target") and os.path.isfile(resolved["target"]):
                                    with open(resolved["target"], "r", encoding="utf-8", errors="replace") as f:
                                        current = f.read(6000)
                                    history.append({"role": "user", "content": (
                                        f"[AUTO-RECOVERY] Your write to {edit_path} keeps failing because it replaces most of the file. "
                                        f"Here is the CURRENT content of the file. Do NOT rewrite the whole file — call edit_file with a "
                                        f"small old_string taken EXACTLY from these existing lines, changing only what must change:\n\n{current}"
                                    )})
                                    log_info(f"[agent] Auto-recovery: injected current content of {edit_path} after repeated failure ({tc['tool']})")
                            except Exception:  # noqa: BLE001
                                pass
                        if fail_streak >= 4:
                            msg = (
                                f"I got stuck: {tc['tool']} kept failing ({last_fail_note}). "
                                "I've stopped to avoid burning time on repeated failed attempts. "
                                "Try rephrasing the task, ask me to take a different approach, "
                                "or run the step manually and tell me what happened."
                            )
                            log_info(f"[agent] Churn breaker tripped after {fail_streak} consecutive failures")
                            await session_log.log_message("assistant", msg)
                            await session_log.end()
                            _cb(opts, "onStage", "agent:done")
                            _cb(opts, "onChunk", f"\n\n_⚙️ {msg}_\n")
                            return msg
                    else:
                        fail_streak = 0
                    if tc["tool"] in ("list_files", "read_file", "search_files"):
                        maybe_fire_reading()
                    for write in result.get("fileWrites", [result["fileWrite"]] if result.get("fileWrite") else []):
                        record_file_write(write)
                    result_content = f"[TOOL RESULT — {tc['tool']}]\n{result['output']}"
                    if pending_image:
                        result_content += f"\n\n[image:{pending_image}]"
                        pending_image = None
                    history.append({"role": "user", "content": result_content})
                    await session_log.log_message("user", f"[TOOL RESULT — {tc['tool']}]\n{result['output']}")

            # Only SUCCESSFUL mutations count as touched work — a refused
            # rewrite left the file unchanged, so claiming "done" right after
            # is exactly the false-success the done-guard must catch.
            mut_attempt_failed_last = bool(mutated_attempted - mutated_ok)
            if mut_attempt_failed_last:
                mutation_failed_ever = True
            if mutation_failed_ever and mutated_ok:
                mut_recovered_last = True
            for tc in calls_to_run:
                if tc["tool"] in ("write_file", "edit_file", "edit_lines", "delete_file"):
                    touched = str(tc["args"].get("path") or "").replace("\\", "/").lower()
                    if touched and touched in mutated_ok:
                        files_touched_this_run.add(touched)
                if tc["tool"] in ("write_file", "edit_file", "edit_lines", "delete_file"):
                    touched_path = str(tc["args"].get("path") or "").replace("\\", "/").lower()
                    if touched_path in mutated_ok:
                        step = f"{tc['tool']}: {tc['args'].get('path') or tc['args'].get('from') or 'unknown'}"
                        if step not in completed_steps:
                            completed_steps.append(step)
                            await session_log.log_plan_update(f"Completed: {step}")


            # ── Automatic game replay after a Python edit ───────────────
            # Same idea as the verify command above, but for GAMES: a static
            # test suite cannot tell you whether the snake moves, so the game
            # is actually played and the result fed back. Bounded by
            # GAME_VERIFY_CAP so a fix→replay cycle cannot run away.
            game_edit = next(
                (
                    tc for tc in calls_to_run
                    if tc["tool"] in ("write_file", "edit_file", "edit_lines", "rename_file")
                    and str(tc["args"].get("path") or tc["args"].get("from") or "").lower().endswith(".py")
                ),
                None,
            )
            if auto_apply and game_target and game_edit and game_verify_count < GAME_VERIFY_CAP:
                game_verify_count += 1
                _cb(opts, "onStage", "agent:verify")
                log_info(f"[agent] Game check after {game_edit['tool']}: replaying {game_target['path']}")
                check = await run_game_check(root, game_target, use_vision_model=use_vision_model, signal=signal)
                last_game_verdict = check["verdict"]
                last_game_failed = not check["ok"]
                history.append({"role": "user", "content": game_verify_message(check, game_target)})
                await session_log.log_verify(f"play_game {game_target['path']}", check["output"], check["ok"])
                _cb(opts, "onAgentCommand", {"command": f"python {game_target['path']} (headless autoplay)", "output": check["output"][:2000], "failed": not check["ok"]})

            if iter >= max_iterations:
                # Budget exhausted THIS iteration — check progress before giving
                # up. Tools succeeding + work done = extend (up to hard cap).
                # Stalled runs (failures, repeated identical calls) fall out to
                # the honest "tell me to continue" message below.
                recent_success = fail_streak == 0
                did_work = bool(files_touched_this_run or completed_steps)
                stuck_repeating = len(seen_calls) > 0 and max(seen_calls.values()) >= 3 and len(files_touched_this_run) == 0
                if recent_success and did_work and not stuck_repeating and max_iterations < MAX_ITERATIONS_HARD_CAP:
                    max_iterations = min(max_iterations * 2, MAX_ITERATIONS_HARD_CAP)
                    log_info(f"[agent] Step budget extended to {max_iterations} — run is making progress")
                    history.append({"role": "user", "content": "[SYSTEM] Step budget extended automatically because you are making steady progress. Continue working toward the goal."})
                    continue
                # Budget exhausted and can't extend (stalled or at hard cap) —
                # exit to the honest "tell me to continue" message below.
                # (This break MUST live inside the if-block: a stray break at
                # loop-body level ended the run after a single iteration.)
                break

    except BaseException as e:
        cancelled = True
        fire_resume_state()
        raise
    finally:
        await release_conversation_resources(resource_key, resources, cancelled=cancelled or bool(signal and signal.is_set()))
        # Live preview is per-run: always closed when the agent loop ends
        # (done, stalled, errored, or cancelled) so no window or server
        # outlives the session.
        try:
            from .preview import stop_preview

            stop_preview()
        except Exception:  # noqa: BLE001
            pass

    # Budget exhausted for real — the in-loop extension only continues while
    # tools keep succeeding and new work is happening, so reaching here means
    # the final window stalled (repeated calls / failures). Ask the user.
    # If writes were attempted but ALL of them failed, say so honestly —
    # a generic "here is my progress" reads like the work landed when it didn't.
    if mutation_failed_ever and not files_touched_this_run:
        msg = (
            "I was not able to complete this request: my write/edit attempts kept failing "
            "(the tool results above explain why — usually a full-rewrite refusal). "
            "Nothing was changed on disk. Tell me how to proceed — for example I can re-read the "
            "current file and make small targeted edits, or you can point me at a different approach."
        )
    else:
        msg = "I reached the maximum number of steps for this request. Here is my progress so far — tell me to continue if you want me to keep going."
    fire_resume_state()
    await session_log.log_message("assistant", msg)
    await session_log.end()
    _cb(opts, "onStage", "agent:done")
    _cb(opts, "onChunk", msg)
    return msg


# ─── Automatic game verification (replay the game after Python edits) ───
GAME_NAME_HINTS = (
    "main.py", "game.py", "snake.py", "app.py", "run.py", "play.py",
    "pong.py", "tetris.py", "breakout.py", "flappy.py",
)

_GAME_VERDICT_LABELS = {
    "crash": "the game crashed",
    "no_motion": "the game ran but nothing on screen moved",
    "no_frames": "the game never drew a single frame",
    "unreported": "the game hung or died without reporting back",
    "failed": "the game check failed",
}


def _read_head(path: str, limit: int = 12000) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read(limit)
    except OSError:
        return ""


async def detect_game_target(root: str) -> dict[str, Any] | None:
    """Detect a playable pygame entry script so the loop can auto-play it.

    Returns a play plan {path, label, frames, inputs, screenshotEvery} or None.
    Disable with {"gameEnabled": false} in .agent-config.json, override the
    entry point with "gamePath", and script the controls with "gameInputs".
    """
    cfg: dict[str, Any] = {}
    try:
        loaded = json.loads((Path(root) / ".agent-config.json").read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            cfg = loaded
    except (OSError, ValueError):
        cfg = {}
    if cfg.get("gameEnabled") is False:
        return None

    def _int_or(value: Any, default: int) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    def _plan_for(path: str) -> dict[str, Any]:
        frames = max(20, min(3000, _int_or(cfg.get("gameFrames"), 120)))
        raw_inputs = cfg.get("gameInputs")
        inputs: list[dict[str, Any]] = []
        if isinstance(raw_inputs, list) and raw_inputs:
            for entry in raw_inputs[:24]:
                if not isinstance(entry, dict):
                    continue
                keys = entry.get("keys")
                if isinstance(keys, str):
                    keys = [keys]
                if not isinstance(keys, list):
                    keys = []
                inputs.append({
                    "frame": max(0, _int_or(entry.get("frame"), 0)),
                    "keys": [str(k) for k in keys][:8],
                })
        else:
            # No configured controls: sweep the four arrow keys across the run
            # so whatever direction the game listens for gets exercised.
            quarter = max(1, frames // 4)
            inputs = [
                {"frame": 0, "keys": ["right"]},
                {"frame": quarter, "keys": ["down"]},
                {"frame": quarter * 2, "keys": ["left"]},
                {"frame": quarter * 3, "keys": ["up"]},
            ]
        return {
            "path": path,
            "label": path,
            "frames": frames,
            "inputs": inputs,
            "screenshotEvery": max(1, min(frames, _int_or(cfg.get("gameScreenshotEvery"), max(1, frames // 6)))),
        }

    override = cfg.get("gamePath")
    if isinstance(override, str) and override.strip():
        rel = override.strip().replace("\\", "/")
        if os.path.isfile(os.path.join(root, rel)):
            return _plan_for(rel)

    best: tuple[int, str] | None = None
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = os.path.relpath(dirpath, root)
        depth = 0 if rel_dir == "." else rel_dir.replace("\\", "/").count("/") + 1
        dirnames[:] = [d for d in dirnames if d not in IGNORE_DIRS and not d.startswith(".")]
        if depth >= 2:
            dirnames[:] = []
        for name in filenames:
            if not name.endswith(".py"):
                continue
            full = os.path.join(dirpath, name)
            if is_protected_path(root, full):
                continue
            if not re.search(r"^\s*(?:import\s+pygame|from\s+pygame)\b", _read_head(full), re.M):
                continue
            score = (2 if name.lower() in GAME_NAME_HINTS else 0) + (1 if depth == 0 else 0) - min(depth, 2)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            if best is None or score > best[0] or (score == best[0] and rel < best[1]):
                best = (score, rel)
    if best is None:
        return None
    return _plan_for(best[1])


def classify_game_result(output: str, ok: bool) -> str:
    """Map a play_game report to a verdict the loop can act on."""
    if "never reported back" in output:
        return "unreported"
    if "CRASHED after" in output:
        return "crash"
    if "MOTION CONFIRMED" in output or "MIXED:" in output:
        return "motion"
    if "NO MOTION between" in output:
        return "no_motion"
    if "No frames were captured" in output:
        return "no_frames"
    return "ok" if ok else "failed"


async def run_game_check(
    root: str,
    game_target: dict[str, Any],
    *,
    frames: int | None = None,
    inputs: list[dict[str, Any]] | None = None,
    use_vision_model: bool = False,
    signal: asyncio.Event | None = None,
) -> dict[str, Any]:
    """Play the detected game headlessly and classify the outcome."""
    call_args: dict[str, Any] = {
        "path": game_target["path"],
        "frames": frames or game_target.get("frames") or 120,
        "inputs": inputs if inputs is not None else (game_target.get("inputs") or []),
        "screenshotEvery": game_target.get("screenshotEvery") or 10,
        "timeout": 30,
    }
    try:
        result = await execute_tool(
            root,
            {"tool": "play_game", "args": call_args},
            True,
            extra={"use_vision_model": use_vision_model, "game_auto": True, "signal": signal},
        )
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "verdict": "failed", "output": f"game check could not run: {e}"}
    output = str(result.get("output") or "")
    verdict = classify_game_result(output, bool(result.get("ok")))
    # NB: the TOOL reports ok=True for a clean no-motion run (nothing crashed).
    # For the loop, "ran but nothing moved" is still a FAILED check — that is
    # the exact user complaint this feature exists to catch.
    return {
        "ok": verdict in ("motion", "ok"),
        "verdict": verdict,
        "output": output,
    }


def game_verify_message(
    check: dict[str, Any], game_target: dict[str, Any], *, baseline: bool = False
) -> str:
    """The [GAME CHECK …] turn the model sees after every automatic replay."""
    label = game_target.get("path")
    reason = _GAME_VERDICT_LABELS.get(check["verdict"], "the game check failed")
    if baseline:
        outcome = "it ran and the picture changed" if check["ok"] else reason
        head = f"[BASELINE GAME CHECK — I played {label} headlessly BEFORE making any changes. Outcome: {outcome}.]"
        tail = (
            " Use this to reproduce the user's report before you change anything. "
            "After each Python edit the same check runs again automatically."
        )
    elif check["ok"]:
        head = f"[GAME CHECK PASSED — I replayed {label} headlessly after your edit: it ran and the picture changed.]"
        tail = (
            " If the behaviour the user reported is now correct, finish and say exactly what the check showed. "
            "If it is not, keep working — the game is replayed automatically after your next edit."
        )
    else:
        head = (
            f"[GAME CHECK FAILED — I replayed {label} headlessly after your edit and it did not behave "
            f"correctly ({reason}). Do NOT tell the user this is fixed.]"
        )
        tail = (
            " Fix the cause now: a corrected tool call will be replayed and re-checked automatically. "
            "Only claim success once a check passes. If this game legitimately opens on a static "
            "screen (a menu or title that never animates), say so and explain why no motion is expected."
        )
    return f"{head}\n{check['output']}\n{tail}"


async def _run_verify(command: str, root: str, cap: int, signal: asyncio.Event | None = None) -> str:
    """Run a verify command; returns capped output with FAILED prefix on error."""
    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            cwd=root,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            **process_group_options(),
        )
        try:
            stdout, stderr = await communicate_with_stop(proc, 60, signal)
        except asyncio.TimeoutError:
            return "FAILED (exit code ?):\nCommand timed out after 60 seconds"
        out = (stdout or b"").decode("utf-8", "replace") + (f"\n[stderr]\n{(stderr or b'').decode('utf-8', 'replace')}" if stderr else "")
        out = out.strip()
        if len(out) > cap:
            out = out[-cap:] + "\n...[output truncated]"
        if proc.returncode != 0:
            return f"FAILED (exit code {proc.returncode}):\n{out or '(no output)'}"
        return out or "(verify passed with no output)"
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        return f"FAILED (exit code ?):\n{msg[:cap]}"


# ─── Collect referenced files (approval mode) ───────────────────────────
async def collect_referenced_files(user_text: str, workspace_path: str | None) -> str:
    root = resolve_workspace_root(workspace_path)
    if not root:
        return ""
    ws_root: str = root

    path_re = re.compile(r"(?:^|[\s,(\"'`])([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+)")
    candidates: set[str] = set()
    for m in path_re.finditer(user_text):
        candidates.add(m.group(1).replace("\\", "/"))
    if not candidates:
        return ""

    files: list[str] = []

    async def walk(dir: str, depth: int) -> None:
        if depth > 4 or len(files) > 500:
            return
        try:
            entries = os.listdir(dir)
        except OSError:
            return
        for name in entries:
            if name.startswith(".") or name in IGNORE_DIRS:
                continue
            full = os.path.join(dir, name)
            if os.path.isdir(full):
                await walk(full, depth + 1)
            else:
                files.append(os.path.relpath(full, ws_root).replace(os.sep, "/"))

    await walk(ws_root, 0)

    referenced: set[str] = set()
    for cand in candidates:
        base = cand.split("/")[-1] or ""
        for f in files:
            if f == cand or f.endswith("/" + cand) or f.split("/")[-1] == base:
                referenced.add(f)
        if len(referenced) >= 6:
            break
    if not referenced:
        return ""

    parts: list[str] = []
    for rel in referenced:
        try:
            full = os.path.join(ws_root, rel)
            if os.path.isdir(full) or os.path.getsize(full) > MAX_READ_BYTES:
                continue
            with open(full, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
            parts.append(f"### {rel}\n```\n{content}\n```")
        except OSError:  # noqa: S110
            pass
    if not parts:
        return ""
    return "\n\n---\n\n[CURRENT FILE CONTENTS — read from disk, use as ground truth for edits]\n\n" + "\n\n".join(parts)
