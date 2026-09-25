"""Coding agent — mirrors backend/src/services/agent.ts.

The autonomous Koding agent loop: model-driven tool calling against a
workspace, with session logs, resume state, approvals, background processes,
and the full guarded tool catalog.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
from pathlib import Path
from typing import Any, Callable

from .ai_rules import with_ai_rules
from .game_harness import HARNESS_SOURCE
from .imagegen import get_generated_images_dir, sanitize_svg, save_artwork
from .logger import error as log_error, info as log_info, warn as log_warn
from .model_assignments import get_resolved_model
from .ollama_client import StreamOptions, stream_chat
from .search import get_web_context
from .services.project_rules import (
    append_agent_memory,
    find_agent_memory_file,
    read_agent_memory,
    read_project_config,
    read_project_rules,
)
from .services.session_log import SessionLog, list_session_logs, read_session_log
from .settings_store import get_cloud_settings
from .utils import (
    PROTECTED_DIRS,
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


async def stream_chat_with_retry(
    opts: dict[str, Any],
    messages: list[dict[str, str]],
    on_chunk: Callable[[str], None],
    on_thinking_chunk: Callable[[str], None],
) -> str:
    max_attempts = 3
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

        def thinking_tap(t: str) -> None:
            buffered_thinking.append(t)
            if live_thinking:
                try:
                    live_thinking(t)
                except Exception:  # noqa: BLE001
                    pass

        try:
            await stream_chat(
                opts["model"],
                messages,
                buffered.append,
                StreamOptions(
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
                ),
            )
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
                truncated = x["content"][:800] + "\n...[pruned to save context]"
                total -= _tok(x) - estimate_tokens(truncated)
                rest[i] = {**x, "content": truncated}
                did_compact = True

    # Phase 2: Smart compaction — summarize oldest tool results before dropping
    if total > MAX_CONTEXT_TOKENS:
        for i, x in enumerate(rest):
            if total <= MAX_CONTEXT_TOKENS:
                break
            if x.get("role") == "user" and x["content"].startswith("[TOOL RESULT") and _tok(x) > 200:
                tool_match = re.search(r"\[TOOL RESULT — (\w+)\]", x["content"])
                tool_name = tool_match.group(1) if tool_match else "tool"
                orig = _tok(x)
                summary = f"[TOOL RESULT — {tool_name}] (summarized from {orig} tokens) Output received and processed."
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


async def ask_user_question(question: str, opts: dict[str, Any]) -> str:
    import random

    key = opts.get("askKey") or f"ask-{int(time.time() * 1000)}-{''.join(random.choices('abcdefghijklmnopqrstuvwxyz0123456789', k=6))}"
    _cb(opts, "onQuestion", key, question)
    future: asyncio.Future = asyncio.get_running_loop().create_future()
    signal: asyncio.Event | None = opts.get("signal")
    _pending_questions[key] = {"future": future}

    signal_task: asyncio.Task | None = None
    if signal is not None:
        if signal.is_set():
            _pending_questions.pop(key, None)
            raise asyncio.CancelledError()
        signal_task = asyncio.create_task(signal.wait())

    try:
        if signal_task is not None:
            done, _ = await asyncio.wait({future, signal_task}, return_when=asyncio.FIRST_COMPLETED)
            if signal_task in done:
                _pending_questions.pop(key, None)
                raise asyncio.CancelledError()
            answer = await future
        else:
            answer = await future
    finally:
        if signal_task is not None:
            signal_task.cancel()
    return answer


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
    {"name": "read_file", "description": "Read the contents of a file inside the workspace. Always read a file BEFORE editing it so you know exactly what is in it. Do NOT pass offset/length for normal files — read the whole file in one call; offset/length is ONLY for files larger than 200KB.", "args": '{"path": "src/index.ts"} or {"path": "src/index.ts", "offset": 200000, "length": 100000}', "mutating": False},
    {"name": "search_files", "description": "Search the workspace for a text pattern. Returns matching file paths + line numbers. Use to find where things are defined.", "args": '{"query": "function render"}', "mutating": False},
    {"name": "run_command", "description": "Run a shell command inside the workspace directory (e.g. build, test, install). The command is sandboxed to the workspace. Output is capped. For long-running commands (servers, watchers), set background=true to run async and poll with __bg_status:id.", "args": '{"command": "bun run build", "background": false}', "mutating": False},
    {"name": "play_game", "description": "PLAY a game/interactive Python script headlessly to verify it WORKS — injects scripted keyboard input, steps the game loop for N frames, captures PNG frames, and MEASURES whether the picture actually changes between frames. Use this for pygame/SDL games instead of guessing: pass inputs to steer (e.g. hold right for 20 frames, then down), then read the captured frames with read_image to SEE the result. Reports frames run, any crash, and changed-pixels per frame — 'changedPixels: 0' between frames that should be animating is a REAL BUG (the actor is not moving or is drawn off-screen).", "args": '{"path": "snake.py", "frames": 120, "inputs": [{"frame": 0, "keys": ["right"]}, {"frame": 30, "keys": ["down"]}], "screenshotEvery": 10}', "mutating": False},
    {"name": "run_python", "description": "RUN a Python program to VERIFY it actually works — the fastest way to check a script you wrote or changed instead of guessing. Pass path (a .py file in the workspace) or code (an inline snippet). Runs with a timeout (games/event loops cannot hang the run), captures stdout/stderr + exit code, and by default sets HEADLESS graphics (SDL_VIDEODRIVER=dummy, matplotlib Agg) so pygame/SDL programs run with no monitor. Use this after writing or fixing any Python script, BEFORE you tell the user it works.", "args": '{"path": "snake.py"} or {"code": "import snake; print(snake.__file__)", "timeout": 15}', "mutating": False},
    {"name": "web_search", "description": "Search the live web and return current, real-time information (docs, APIs, syntax, news). Use when you need up-to-date knowledge that is not in your training data. Results are capped.", "args": '{"query": "python requests library latest API"}', "mutating": False},
    {"name": "draw_image", "description": "Draw or generate an image when the user asks for a picture/logo/icon/illustration (no text-to-image model exists, so you are the artist). Pass svg: ONE complete standalone SVG that DRAWS the request — not a prompt. Declare width=\"1024\" height=\"1024\" viewBox=\"0 0 1024 1024\"; flat vector style with rect/circle/ellipse/polygon/path and gradients in <defs>; background first, foreground last; NEVER use <text> (no fonts); under ~60 elements. The SVG is rasterized to PNG and the tool result tells you the EXACT markdown to embed in your reply.", "args": '{"svg": "<svg xmlns=\\"http://www.w3.org/2000/svg\\" width=\\"1024\\" height=\\"1024\\" viewBox=\\"0 0 1024 1024\\"><rect width=\\"1024\\" height=\\"1024\\" fill=\\"#223\\"/></svg>"}', "mutating": False},
    {"name": "gen_image", "description": "Generate an image file INSIDE the workspace (e.g. assets/icon.png, textures, mockups, sprites) that code in the project can reference. Same SVG-authoring rules as draw_image (one complete standalone SVG, 1024x1024, flat vector, no <text>). Pass path (destination inside the workspace, use an assets/ folder for media) and svg. The image is rasterized to PNG and written to that path — the tool result gives you the file path to reference in code.", "args": '{"path": "assets/car.png", "svg": "<svg xmlns=\\"http://www.w3.org/2000/svg\\" width=\\"1024\\" height=\\"1024\\" viewBox=\\"0 0 1024 1024\">...</svg>"}', "mutating": True},
    {"name": "read_image", "description": "Describe an image file inside the workspace using the vision model (e.g. screenshots, mockups, diagrams). Returns a detailed plain-text description.", "args": '{"path": "screenshots/ui.png"}', "mutating": False},
    {"name": "read_rules", "description": "Read BOTH the user rules file (.agent-rules.md) and the agent memory file (.agent-memory.md). USER RULES are authoritative — written by the user, follow them strictly, and you can NEVER edit them. AGENT MEMORY is your own notes from previous sessions — lower priority, and if your memory contradicts a user rule, the user rule wins. Read this when you start a task or whenever you are unsure about conventions.", "args": "{}", "mutating": False},
    {"name": "update_memory", "description": "Append a durable lesson to YOUR OWN memory file (.agent-memory.md) so it is remembered across sessions (e.g. \"the test command is python -m unittest\", \"use snake_case\"). Duplicates are skipped. You can only write to your memory file — the USER RULES file (.agent-rules.md) is read-only for you and you can never edit it. Use sparingly — only durable, reusable project knowledge, not one-off task notes.", "args": '{"rule": "The test command is: python -m unittest"}', "mutating": True},
    {"name": "ask_user", "description": "Ask the user a short clarifying question mid-task when you genuinely cannot proceed (ambiguous requirements, conflicting instructions, a destructive action you must not assume). The run pauses until the user answers. Use ONLY for questions you cannot answer yourself from the workspace, your rules, or memory — never ask about things you can check yourself.", "args": '{"question": "Should the new module be TypeScript or plain JavaScript?"}', "mutating": False},
    {"name": "git_status", "description": "Show the current git repository state (branch, staged/unstaged changes, untracked files). Run this before committing so you know what changed. Returns an error if the workspace is not a git repo.", "args": "{}", "mutating": False},
    {"name": "git_diff", "description": "Show the exact changes (diff) of files in the workspace. Use this to review your own work and to write an accurate commit message. Returns an error if the workspace is not a git repo.", "args": "{}", "mutating": False},
    {"name": "git_commit", "description": "Stage ALL changes and create a LOCAL git commit with the given summary. ALWAYS write a concise, accurate summary (what changed and why) based on your diff — never generic text like \"update files\". Uses \"Koding\" as the author unless you pass a name. IMPORTANT: commits are LOCAL ONLY — this tool NEVER pushes to GitHub or any remote, so never claim to have pushed anything. Returns an error if the workspace is not a git repo or there is nothing to commit.", "args": '{"summary": "Raise max connections to 500 and add retry logic"} or {"summary": "...", "name": "User Name"}', "mutating": True},
    {"name": "edit_file", "description": "SURGICAL edit of an existing file: replace an exact snippet (old_string) with new content (new_string). Use this for SMALL changes to existing files instead of rewriting the whole file. old_string must appear exactly once in the file (or differ only in whitespace). ONLY available in auto-apply mode. After a successful edit the result includes a diff summary.", "args": '{"path": "src/app.ts", "old_string": "const x = 1;", "new_string": "const x = 2;"}', "mutating": True},
    {"name": "write_file", "description": "Create a NEW file. If the file already exists, only YOUR CHANGED LINES are applied and everything else in the file is preserved exactly (safe to pass the full new file content — a version that rewrites most of the file is refused). ONLY available in auto-apply mode — the file is written immediately and can be reverted by the user.", "args": '{"path": "src/app.ts", "content": "..."}', "mutating": True},
    {"name": "delete_file", "description": "Delete a file inside the workspace. ONLY available in auto-apply mode — the deletion happens immediately and can be reverted by the user.", "args": '{"path": "src/old.ts"}', "mutating": True},
    {"name": "delegate_to_subagent", "description": "Delegate a focused sub-task to a sub-agent that runs independently. The sub-agent gets its own context and tool access. Use type to spawn specialized agents: \"explore\" (fast read-only search), \"plan\" (architecture planning), \"reviewer\" (code review). Returns the sub-agent's final answer.", "args": '{"task": "Run all tests and report which ones fail", "type": "explore|plan|reviewer|general", "model": "optional - use a different model"}', "mutating": True},
    {"name": "rename_file", "description": "Rename or move a file inside the workspace. The original file is deleted and the new path is created with the same content. Both paths must be inside the workspace. Can be reverted by the user.", "args": '{"from": "src/old.ts", "to": "src/new.ts"}', "mutating": True},
    {"name": "read_url", "description": "Fetch a web page and return its readable text content. Use when you need to read specific documentation, API references, or tutorials. Returns extracted text (scripts/styles stripped). Max 20000 chars.", "args": '{"url": "https://docs.python.org/3/library/tkinter.html"}', "mutating": False},
    {"name": "find_references", "description": "Find all usages of a name (function, class, variable, import) across the workspace. Returns file paths and line numbers. Use before renaming or refactoring to understand impact.", "args": '{"query": "functionName"}', "mutating": False},
    {"name": "refactor_rename", "description": "Rename a symbol (function, class, variable, import) across ALL files in the workspace. Performs find-and-replace with word-boundary matching. Shows a summary of all changes. Revertable.", "args": '{"oldName": "oldFunction", "newName": "newFunction"}', "mutating": True},
    {"name": "create_directory", "description": "Create a directory (and any missing parent directories) inside the workspace. Use before write_file when the target folder does not exist yet.", "args": '{"path": "src/components"}', "mutating": True},
    {"name": "file_exists", "description": "Check if a file or directory exists inside the workspace. Returns true/false and the type (file or directory). Use before editing to confirm a file is there.", "args": '{"path": "src/app.ts"}', "mutating": False},
    {"name": "read_url_image", "description": "Download an image from a URL and save it to the workspace. Returns the local path. Use for fetching logos, mockups, screenshots, etc.", "args": '{"url": "https://example.com/logo.png", "saveAs": "assets/logo.png"}', "mutating": True},
    {"name": "diff_files", "description": "Compare two files and show the differences. Can compare two workspace files, or compare a file against a string. Returns a unified diff.", "args": '{"fileA": "src/old.ts", "fileB": "src/new.ts"} or {"fileA": "src/app.ts", "contentB": "new content..."}', "mutating": False},
    {"name": "replace_in_file", "description": "Find and replace ALL occurrences of a string in a file. Simpler than edit_file when you want to replace every instance. Supports regex.", "args": '{"path": "src/app.ts", "find": "oldFunction", "replace": "newFunction"}', "mutating": True},
    {"name": "count_lines", "description": "Count lines, words, and characters in a file or across multiple files. Use to understand codebase size before making changes.", "args": '{"path": "src/"} or {"path": "src/app.ts"}', "mutating": False},
    {"name": "glob", "description": "Fast file pattern matching. Find files by name/extension pattern (e.g. \"**/*.tsx\", \"src/**/*.ts\", \"*.json\"). Returns matching paths sorted by modification time. ALWAYS use this instead of list_files when searching for files by extension or name pattern — it is much faster.", "args": '{"pattern": "**/*.py"}', "mutating": False},
    {"name": "multi_edit", "description": "Apply multiple surgical edits to a SINGLE file in one atomic operation. All edits are applied in order — if any fails, none are applied. Use this when you need to change several places in the same file. Each edit is the same as edit_file (old_string → new_string).", "args": '{"path": "src/app.ts", "edits": [{"old_string": "const x = 1;", "new_string": "const x = 2;"}, {"old_string": "foo();", "new_string": "bar();"}]}', "mutating": True},
    {"name": "preview_start", "description": "Start a live local preview of the workspace (or a subfolder) so you can TEST your web work: it serves the files on http://127.0.0.1 and the client opens a real browser window showing the page. The page auto-reloads when files change. You can then use preview_screenshot / preview_eval / preview_console to verify the result. Use for HTML/CSS/JS apps, canvas games, SPAs, etc. Call preview_stop when done (or to restart after changing the entry file).", "args": '{"entry": "index.html"}', "mutating": False},
    {"name": "preview_stop", "description": "Stop the live preview server and close the preview window. Call this when you are done testing or when the run ends.", "args": "{}", "mutating": False},
    {"name": "preview_screenshot", "description": "Capture a PNG screenshot of the live preview window so you can SEE the page. If you support vision the image is placed directly into your context — judge layout, colors and content from it. Otherwise a detailed text description is returned. Requires the preview window to be open (preview_start).", "args": '{}', "mutating": False},
    {"name": "preview_eval", "description": "Run JavaScript inside the live preview page and return the JSON value of the last expression (e.g. check a game variable, read DOM state, verify an element exists). Requires the preview window to be open (preview_start).", "args": '{"code": "document.querySelectorAll(\'.tile\').length"}', "mutating": False},
    {"name": "preview_console", "description": "Read the live preview page's console output (log/warn/error, plus any uncaught errors). ALWAYS check this after preview_screenshot — it reveals JS errors invisible in a static screenshot. Requires the preview window to be open (preview_start).", "args": '{}', "mutating": False},
]

TOOL_JSON_EXAMPLES = f"""Available tools — to use one, respond with ONLY a single JSON object, no markdown, no other text:

{{"tool": "list_files", "args": {{}}}}
{{"tool": "read_file", "args": {{"path": "src/index.ts"}}}}
{{"tool": "search_files", "args": {{"query": "function render"}}}}
{{"tool": "run_command", "args": {{"command": "bun run build"}}}}
{{"tool": "run_command", "args": {{"command": "npm start", "background": true}}}} — long-running commands run async; poll with __bg_status:id
{{"tool": "run_python", "args": {{"path": "snake.py", "timeout": 15}}}} — RUN a workspace Python script to verify it (headless by default); use {{"code": "..."}} for an inline snippet
{{"tool": "play_game", "args": {{"path": "snake.py", "frames": 120, "screenshotEvery": 20}}}} — PLAY a game headlessly: inject input, capture frames, measure pixel motion (then read_image them)
{{"tool": "edit_file", "args": {{"path": "src/app.ts", "old_string": "const x = 1;", "new_string": "const x = 2;"}}}}
{{"tool": "write_file", "args": {{"path": "src/app.ts", "content": "..."}}}} — for an EXISTING file only your changed lines are applied; the rest is preserved
{{"tool": "delete_file", "args": {{"path": "src/old.ts"}}}}
{{"tool": "gen_image", "args": {{"path": "assets/icon.png", "svg": "<svg ...>...</svg>"}}}} — write a project image asset (same SVG rules as draw_image)
{{"tool": "git_status", "args": {{}}}}
{{"tool": "git_diff", "args": {{}}}}
{{"tool": "git_commit", "args": {{"summary": "Raise max connections to 500"}}}}
{{"tool": "read_rules", "args": {{}}}}
{{"tool": "update_memory", "args": {{"rule": "The test command is: python -m unittest"}}}}
{{"tool": "ask_user", "args": {{"question": "TypeScript or JavaScript?"}}}}
{{"tool": "delegate_to_subagent", "args": {{"task": "Run the test suite and report failures"}}}}
{{"tool": "delegate_to_subagent", "args": {{"task": "Search for deprecated APIs in the codebase", "model": "qwen3:8b"}}}}
{{"tool": "rename_file", "args": {{"from": "src/old.ts", "to": "src/new.ts"}}}}
{{"tool": "read_url", "args": {{"url": "https://docs.python.org/3/library/tkinter.html"}}}}
{{"tool": "find_references", "args": {{"query": "functionName"}}}}
{{"tool": "refactor_rename", "args": {{"oldName": "oldFunction", "newName": "newFunction"}}}}
{{"tool": "create_directory", "args": {{"path": "src/components"}}}}
{{"tool": "file_exists", "args": {{"path": "src/app.ts"}}}}
{{"tool": "read_url_image", "args": {{"url": "https://example.com/logo.png", "saveAs": "assets/logo.png"}}}}
{{"tool": "diff_files", "args": {{"fileA": "src/old.ts", "fileB": "src/new.ts"}}}}
{{"tool": "replace_in_file", "args": {{"path": "src/app.ts", "find": "oldFunction", "replace": "newFunction"}}}}
{{"tool": "count_lines", "args": {{"path": "src/app.ts"}}}}
{{"tool": "glob", "args": {{"pattern": "**/*.py"}}}}
{{"tool": "glob", "args": {{"pattern": "src/**/*.tsx"}}}}
{{"tool": "multi_edit", "args": {{"path": "src/app.ts", "edits": [{{"old_string": "const x = 1;", "new_string": "const x = 2;"}}, {{"old_string": "foo();", "new_string": "bar();"}}]}}}}"""


# ─── Workspace listing ──────────────────────────────────────────────────
async def list_workspace_tree(root: str) -> str:
    lines: list[str] = []

    async def walk(dir: str, depth: int) -> None:
        if depth > 3 or len(lines) > 400:
            return
        if is_protected_path(root, dir):
            return
        try:
            entries = os.listdir(dir)
        except OSError:
            return
        entries.sort(key=lambda n: (not os.path.isdir(os.path.join(dir, n)), n.lower()))
        for name in entries:
            if name.startswith(".") or name in IGNORE_DIRS:
                continue
            full = os.path.join(dir, name)
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
    return "\n".join(lines) if lines else "(empty workspace)"


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
        lines.append(f"- Verify command: {verify_command} (auto-run after every file change to check your work)")
    lines.append(
        f"- User rules: {project_rules if project_rules else 'none yet — the user can create .agent-rules.md for standing instructions'}"
    )
    lines.append(
        f"- Agent memory: {agent_memory if agent_memory else 'none yet — use update_memory to save durable project knowledge'}"
    )
    lines.append(f"- PROTECTED directories (NEVER read, list, search, edit, commit, or run commands referencing them — they are server internals): {protected_dirs_label()}")
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
async def describe_image(target: str) -> str:
    with open(target, "rb") as f:
        b64 = f.read()
    import base64

    b64_str = base64.b64encode(b64).decode()
    ext_match = re.search(r"\.(png|jpe?g|gif|webp|bmp)$", target, re.I)
    ext = (ext_match.group(1) if ext_match else "png").lower()
    mime = {
        "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "gif": "image/gif", "webp": "image/webp", "bmp": "image/bmp",
    }.get(ext, "image/png")
    resolved = await get_resolved_model("vision")
    vision_model = resolved["model"]
    vision_source = resolved["source"]
    cloud_settings = await get_cloud_settings() if vision_source == "cloud" else None
    log_info(f"[agent] Vision model: {vision_model} (source: {vision_source})")
    description: list[str] = []

    await stream_chat(
        vision_model,
        [
            {"role": "system", "content": "You are a vision description assistant. Describe what you see in the image in plain text: layout, colors, text content, structure, UI elements. Be specific and technical. 2-4 paragraphs, no code blocks."},
            {"role": "user", "content": f"Describe this image: [image:data:{mime};base64,{b64_str}]"},
        ],
        description.append,
        StreamOptions(
            think=False,
            base_url=(cloud_settings or {}).get("cloudEndpoint") or None,
            api_key=(cloud_settings or {}).get("cloudApiKey") or None,
        ),
    )
    return "".join(description).strip() or "(vision model returned no description)"


# ─── Git helpers ────────────────────────────────────────────────────────
MUTATING_TOOLS = {"edit_file", "write_file", "delete_file", "gen_image"}

# Tools that REUSE an existing no-op call. The identical-call guard counts
# ALL repeats of the same call — but "already has exactly this content" is a
# SUCCESS, so the model must not be punished for repeating it (that exact
# false give-up shipped to a user: two write_file calls, second returned
# no-op, guard tripped with "kept failing the same way" for a call that
# never failed).
NOOP_OK_TOOLS = {"write_file"}


def git_exclude_args() -> list[str]:
    args = ["--", "."]
    for d in PROTECTED_DIRS:
        args.append(f":(exclude){d}")
    return args


async def run_git(root: str, args: list[str]) -> str:
    quoted = []
    for a in args:
        if re.fullmatch(r"[A-Za-z0-9_./:=@%+,-]+", a):
            quoted.append(a)
        else:
            quoted.append('"' + a.replace('"', "'") + '"')
    cmd = "git " + " ".join(quoted)
    try:
        proc = await asyncio.create_subprocess_shell(
            cmd,
            cwd=root,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
        except asyncio.TimeoutError:
            proc.kill()
            raise RuntimeError("git command timed out")
        out = (stdout or b"").decode("utf-8", "replace")
        err = (stderr or b"").decode("utf-8", "replace")
        return (out + (f"\n[stderr]\n{err}" if err else "")).strip()
    except asyncio.CancelledError:
        raise
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(str(e)) from e


# ─── Sub-agent delegation ───────────────────────────────────────────────
async def run_sub_agent(
    root: str,
    task: str,
    model: str | None,
    parent_opts: dict[str, Any],
    auto_apply: bool,
) -> str:
    sub_system = f"You are a focused sub-agent. Your task: {task}\n\nYou have the same tools as the parent agent. Complete the task and respond with your findings/results. Be concise — the parent agent is waiting for your output."
    file_tree = await list_workspace_tree(root)
    ground_truth = "WORKSPACE FILES:\n" + file_tree

    sub_messages = [
        {"role": "system", "content": sub_system + "\n\n" + ground_truth},
        {"role": "user", "content": task},
    ]
    sub_model = model or parent_opts.get("model")
    output = ""
    sub_history: list[dict[str, str]] = list(sub_messages)

    for _iter in range(10):
        bounded = prune_to_budget(sub_history)["messages"]
        chunks: list[str] = []
        try:
            await stream_chat_with_retry(
                {**parent_opts, "model": sub_model},
                bounded,
                chunks.append,
                lambda _t: None,
            )
        except Exception as e:  # noqa: BLE001
            output += f"\n[Sub-agent error: {e}]"
            break
        raw = "".join(chunks)
        tool_call = extract_tool_call(raw)
        if not tool_call:
            output = raw
            break
        result = await execute_tool(root, tool_call, auto_apply)
        sub_history.append({"role": "assistant", "content": raw})
        sub_history.append({"role": "user", "content": f"[TOOL RESULT — {tool_call['tool']}]\n{result['output']}"})
    return output or "(sub-agent completed with no output)"


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
            return {"ok": True, "output": f"File {p}{suffix}{actual}:\n{text}"}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"Could not read {p}: {e}")

    if tool == "web_search":
        q = args.get("query") if isinstance(args.get("query"), str) else ""
        if not q:
            return await deny_out('web_search requires a "query" string argument.')
        try:
            ctx = await get_web_context(q)
            if not ctx:
                return {"ok": True, "output": "Web search returned no results for that query."}
            capped = ctx[:MAX_OUTPUT_CHARS] + "\n...[truncated]" if len(ctx) > MAX_OUTPUT_CHARS else ctx
            return {"ok": True, "output": f"[WEB SEARCH RESULTS — CURRENT AND LIVE]\n{capped}"}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"Web search failed: {e}")

    if tool == "draw_image":
        svg = args.get("svg") if isinstance(args.get("svg"), str) else ""
        svg = svg.strip()
        if not svg:
            return await deny_out('draw_image requires an "svg" string argument containing a complete standalone SVG document.')
        check = sanitize_svg(svg)
        if not check.get("ok"):
            return await deny_out(f"Your SVG was rejected: {check.get('error')} Rewrite it to fix the problem, then call the tool again.")
        try:
            art = await save_artwork(svg)
            return {
                "ok": True,
                "output": f'Image drawn and saved as "{art["filename"]}" ({"raster PNG" if art.get("png") else "SVG"}). In your next message to the user, include this EXACT markdown so the image displays: ![Generated image](/api/generated/{art["filename"]})',
            }
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"Could not save the image: {e}")

    if tool == "gen_image":
        if not auto_apply:
            return await deny_out("gen_image is disabled — auto-apply mode is OFF.")
        p = args.get("path") if isinstance(args.get("path"), str) else ""
        svg = (args.get("svg") if isinstance(args.get("svg"), str) else "").strip()
        if not p or not svg:
            return await deny_out('gen_image requires "path" (destination inside the workspace, e.g. assets/car.png) and "svg" arguments.')
        if not re.search(r"\.(png|jpe?g|webp|svg)\s*$", p, re.I):
            return await deny_out(f"gen_image path must end in an image extension (.png, .jpg, .webp, .svg) — got: {p}")
        exact = await resolve_in_workspace(root, p)
        if not exact:
            return await deny_out(f"Access denied: {p} is outside the workspace.")
        check = sanitize_svg(svg)
        if not check.get("ok"):
            return await deny_out(f"Your SVG was rejected: {check.get('error')} Rewrite it to fix the problem, then call the tool again.")
        try:
            art = await save_artwork(svg)
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"Could not generate the image: {e}")
        # Locate the actual rendered file (PNG when rasterization succeeded)
        source_name = str(art.get("filename") or "")
        source_path = Path(get_generated_images_dir()) / source_name
        try:
            target_rel = os.path.relpath(exact, root).replace(os.sep, "/")
            target_dir = os.path.dirname(exact)
            if target_dir:
                os.makedirs(target_dir, exist_ok=True)
            if source_path.exists() and source_name.lower().endswith((".png", ".svg")):
                if source_name.lower().endswith(".png") and p.lower().endswith((".jpg", ".jpeg")):
                    target_rel = target_rel.rsplit(".", 1)[0] + ".png"
                    exact = os.path.splitext(exact)[0] + ".png"
                shutil.copyfile(source_path, exact)
                os.remove(source_path)
                size_kb = os.path.getsize(exact) / 1024
                return {
                    "ok": True,
                    "output": (
                        f"Image generated and saved to {target_rel} ({size_kb:.1f} KB). "
                        f"Reference it from code as '{target_rel}' — use a relative path exactly like that. "
                        "A copy also appears in the chat gallery."
                    ),
                    "fileWrite": {"path": target_rel, "changeType": "created", "originalContent": None},
                }
            return await deny_out("Rasterization unavailable — the image could not be written to the workspace. Try a simpler SVG.")
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"Could not save the image to {p}: {e}")

    if tool == "read_image":
        p = args.get("path") if isinstance(args.get("path"), str) else ""
        if not p:
            return await deny_out('read_image requires a "path" string argument.')
        target = await resolve_in_workspace(root, p)
        if not target:
            return await deny_out(f"Access denied: {p} is outside the workspace.")
        try:
            stat = os.stat(target)
            if stat.st_size > 10 * 1024 * 1024:
                return await deny_out(f"{p} is {stat.st_size / 1024 / 1024:.1f}MB — too large to describe (max 10MB).")
            description = await describe_image(target)
            return {"ok": True, "output": f"Vision description of {p}:\n{description}"}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"Could not describe {p}: {e}")

    if tool == "read_rules":
        rules = await read_project_rules(root)
        memory = await read_agent_memory(root)
        parts: list[str] = []
        if rules:
            parts.append(f"[USER RULES — authoritative, written by the user. Follow them strictly. You can NEVER edit or override this file.]\n{rules}")
        else:
            parts.append("[USER RULES] No user rules file exists yet (.agent-rules.md). The user can create one to give you standing instructions.")
        if memory:
            memory_path = await find_agent_memory_file(root)
            parts.append(f"[AGENT MEMORY — your own notes from previous sessions ({memory_path}). Lower priority than user rules: if this contradicts a user rule, the user rule wins.]\n{memory}")
        else:
            parts.append("[AGENT MEMORY] No memory saved yet — use update_memory when you learn something durable about the project.")
        return {"ok": True, "output": "\n\n".join(parts)}

    if tool == "update_memory":
        rule = args.get("rule") if isinstance(args.get("rule"), str) else ""
        if not rule.strip():
            return await deny_out('update_memory requires a "rule" string argument.')
        try:
            file_path = await append_agent_memory(root, rule)
            return {"ok": True, "output": f"Memory saved to {os.path.basename(file_path)} (your own notes — lower priority than user rules). It will apply from now on."}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"Failed to update memory: {e}")

    if tool == "git_status":
        try:
            out = await run_git(root, ["status", "--short", "--branch", *git_exclude_args()])
            return {"ok": True, "output": out or "(clean working tree — nothing changed)"}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"git status failed (is this a git repository?): {e}")

    if tool == "git_diff":
        try:
            exclude = git_exclude_args()
            staged = await run_git(root, ["diff", "--cached", "--stat", *exclude])
            unstaged = await run_git(root, ["diff", "--stat", *exclude])
            hunks = ""
            try:
                raw_hunks = await run_git(root, ["diff", "-U0", *exclude])
                hunks = f"\n[CHANGED LINES]\n{raw_hunks[:2000]}" if raw_hunks.strip() else ""
            except Exception:  # noqa: BLE001
                pass
            out = (f"[STAGED]\n{staged}\n" if staged else "") + (f"[UNSTAGED]\n{unstaged}\n" if unstaged else "") + hunks
            if not out.strip():
                status = ""
                try:
                    status = await run_git(root, ["status", "--short", *exclude])
                except Exception:  # noqa: BLE001
                    pass
                out = (f"No tracked changes yet — new/untracked files present:\n{status}\n(use git_commit to stage and commit them)"
                       if status.strip() else "(working tree is clean) — nothing to diff.")
            capped = out[:MAX_OUTPUT_CHARS] + "\n...[truncated]" if len(out) > MAX_OUTPUT_CHARS else out
            return {"ok": True, "output": capped}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"git diff failed (is this a git repository?): {e}")

    if tool == "git_commit":
        summary = args.get("summary") if isinstance(args.get("summary"), str) else ""
        summary = summary.strip()
        if not summary:
            return await deny_out('git_commit requires a "summary" string argument (what changed and why).')
        try:
            status = await run_git(root, ["status", "--short"])
            if not status.strip():
                return {"ok": True, "output": "Nothing to commit — the working tree is clean."}
            author = args.get("name") if isinstance(args.get("name"), str) and args.get("name").strip() else "Koding"
            email = "agent@kasalix.local"
            await run_git(root, ["add", "-A", *git_exclude_args()])
            staged = await run_git(root, ["diff", "--cached", "--name-only", *git_exclude_args()])
            if not staged.strip():
                return {"ok": True, "output": "Nothing to commit — the only changed files are in protected server directories (not tracked by the agent)."}
            await run_git(root, [
                "-c", f"user.name={author}",
                "-c", f"user.email={email}",
                "commit", "-m", summary.replace('"', "'"),
                "--author", f"{author} <{email}>",
            ])
            log_text = ""
            try:
                log_text = await run_git(root, ["log", "-1", "--stat", "--oneline"])
            except Exception:  # noqa: BLE001
                pass
            return {"ok": True, "output": f"Committed LOCALLY as {author} — this was NOT pushed to GitHub or any remote (this tool never pushes).\n{log_text[:MAX_OUTPUT_CHARS]}"}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"git commit failed (is this a git repository?): {e}")

    if tool == "search_files":
        q = args.get("query") if isinstance(args.get("query"), str) else ""
        if not q:
            return await deny_out('search_files requires a "query" string argument.')
        matches: list[str] = []

        async def walk(dir: str, depth: int) -> None:
            if depth > 4 or len(matches) >= MAX_SEARCH_MATCHES:
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
                    try:
                        if os.path.getsize(full) > MAX_READ_BYTES:
                            continue
                        content = open(full, "r", encoding="utf-8", errors="replace").read()
                        lines = content.split("\n")
                        for i, line in enumerate(lines):
                            if q.lower() in line.lower():
                                rel = os.path.relpath(full, root).replace(os.sep, "/")
                                matches.append(f"{rel}:{i + 1}: {line.strip()[:160]}")
                                if len(matches) >= MAX_SEARCH_MATCHES:
                                    return
                    except OSError:  # noqa: S110
                        pass

        await walk(root, 0)
        if not matches:
            return {"ok": True, "output": f'No matches for "{q}" in the workspace.'}
        return {"ok": True, "output": f'Matches for "{q}":\n' + "\n".join(matches)}

    if tool == "run_command":
        cmd = args.get("command") if isinstance(args.get("command"), str) else ""
        if not cmd:
            return await deny_out('run_command requires a "command" string argument.')
        dangerous = re.compile(r"\b(rm\s+-[rf]\s+/|format\s+[c-z]:\s*/q|dd\s+if=|mkfs\.|fdisk|shutdown\s+-[rh]\s+-t\s+0|del\s+/f\s+/s)", re.I)
        escapes_workspace = (
            re.compile(r"(^|[;&|])\s*cd\s+(\.\.|~|/|\\\\|[A-Za-z]:[\\/])", re.I).search(cmd)
            or re.compile(r"[A-Za-z]:[\\/][^\s\"']*").search(cmd)
            or re.compile(r"\$HOME|%USERPROFILE%|%APPDATA%|%LOCALAPPDATA%|%TEMP%|%WINDIR%|%SYSTEM32%", re.I).search(cmd)
        )
        tokens = cmd.split()
        touches_protected = any(
            _token_touches_protected(tok)
            for tok in tokens
        )
        touches_rules = any(
            _token_touches_rules(tok)
            for tok in tokens
        )
        if dangerous.search(cmd) or escapes_workspace or touches_protected or touches_rules:
            return await deny_out(f"Command blocked for security (must stay inside the workspace and must not touch protected directories or the USER RULES file: {protected_dirs_label()}).")

        is_background = args.get("background") is True
        if is_background:
            bg_id = f"bg-{int(time.time() * 1000)}-{''.join(__import__('random').choices('abcdefghijklmnopqrstuvwxyz0123456789', k=4))}"
            try:
                child = await asyncio.create_subprocess_shell(
                    cmd,
                    cwd=root,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
            except Exception as e:  # noqa: BLE001
                return await deny_out(f"Failed to start command: {e}")
            bg_entry = {"child": child, "output": "", "exitCode": None, "done": False}
            background_processes[bg_id] = bg_entry

            async def _pump(proc: asyncio.subprocess.Process, entry: dict[str, Any]) -> None:
                assert proc.stdout is not None and proc.stderr is not None
                async def _read(stream: Any) -> None:
                    while True:
                        chunk = await stream.readline()
                        if not chunk:
                            break
                        entry["output"] += chunk.decode("utf-8", "replace")
                try:
                    await asyncio.gather(_read(proc.stdout), _read(proc.stderr))
                    entry["exitCode"] = await proc.wait()
                except Exception:  # noqa: BLE001
                    entry["exitCode"] = -1
                finally:
                    entry["done"] = True

            asyncio.create_task(_pump(child, bg_entry))
            return {"ok": True, "output": f'Command started in background (ID: {bg_id}). Use run_command with {{"command": "__bg_status:{bg_id}"}} to check status/output.'}

        if cmd.startswith("__bg_status:"):
            bg_id = cmd.replace("__bg_status:", "")
            bg = background_processes.get(bg_id)
            if not bg:
                return await deny_out(f"No background process found with ID: {bg_id}")
            capped = bg["output"][-MAX_OUTPUT_CHARS:] + "\n...[truncated]" if len(bg["output"]) > MAX_OUTPUT_CHARS else bg["output"]
            if bg["done"]:
                background_processes.pop(bg_id, None)
                return {"ok": bg.get("exitCode") == 0, "output": f"[Background process {bg_id} completed with exit code {bg.get('exitCode')}]\n{capped or '(no output)'}"}
            return {"ok": True, "output": f"[Background process {bg_id} still running]\n{capped or '(no output yet)'}"}

        try:
            proc = await asyncio.create_subprocess_shell(
                cmd,
                cwd=root,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=600)
            except asyncio.TimeoutError:
                proc.kill()
                return await deny_out("Command timed out after 10 minutes.")
            out = (stdout or b"").decode("utf-8", "replace") + (f"\n[stderr]\n{(stderr or b'').decode('utf-8', 'replace')}" if stderr else "")
            out = out.strip()
            capped = out[-MAX_OUTPUT_CHARS:] + "\n...[output truncated]" if len(out) > MAX_OUTPUT_CHARS else out
            return {"ok": True, "output": capped or "(command finished with no output)"}
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            capped = msg[-MAX_OUTPUT_CHARS:] + "\n...[output truncated]" if len(msg) > MAX_OUTPUT_CHARS else msg
            return {"ok": False, "output": f"Command exited with code ?:\n{capped}"}

    if tool == "run_python":
        p = args.get("path") if isinstance(args.get("path"), str) else ""
        code = args.get("code") if isinstance(args.get("code"), str) else ""
        if not p and not code:
            return await deny_out('run_python requires either "path" (a .py file in the workspace) or "code" (an inline snippet).')

        interp = find_python_interpreter(root)
        if not interp:
            return await deny_out("No Python interpreter found. Check `python --version` with run_command, or set KASALIX_PYTHON to a python.exe path.")

        timeout_raw = args.get("timeout")
        try:
            timeout = float(timeout_raw) if timeout_raw is not None else 20.0
        except (TypeError, ValueError):
            timeout = 20.0
        timeout = max(2.0, min(timeout, 120.0))

        # Headless is the DEFAULT — the whole point is running GUI/game scripts
        # with no monitor attached. Pass headless:false to opt out.
        headless = args.get("headless") is not False

        extra_args: list[str] = []
        raw_args = args.get("args")
        if isinstance(raw_args, str) and raw_args.strip():
            try:
                extra_args = shlex.split(raw_args)
            except ValueError:
                extra_args = raw_args.split()

        temp_file: str | None = None
        if p:
            res = await resolve_target_smart(root, p)
            if res.get("error"):
                return await deny_out(f"run_python: {res['error']}")
            target = res["target"]
            if not os.path.isfile(target):
                return await deny_out(f"run_python: {p} is not a file inside the workspace. Use glob or list_files to find the script.")
            cmd = [*interp, target, *extra_args]
            label = os.path.relpath(target, root).replace(os.sep, "/")
        else:
            try:
                fd, temp_file = tempfile.mkstemp(prefix=".kx_run_", suffix=".py", dir=root)
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(code)
            except OSError as e:  # noqa: BLE001
                return await deny_out(f"run_python: could not stage the snippet: {e}")
            cmd = [*interp, temp_file, *extra_args]
            label = "(inline snippet)"

        env = dict(os.environ)
        if headless:
            env.setdefault("SDL_VIDEODRIVER", "dummy")
            env.setdefault("SDL_AUDIODRIVER", "dummy")
            env["PYGAME_HIDE_SUPPORT_PROMPT"] = "1"
            env.setdefault("MPLBACKEND", "Agg")
            env.pop("DISPLAY", None)

        stdin_raw = args.get("stdin")
        stdin_bytes = stdin_raw.encode("utf-8") if isinstance(stdin_raw, str) and stdin_raw else None

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=root,
                stdin=asyncio.subprocess.PIPE if stdin_bytes else None,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
            )
        except Exception as e:  # noqa: BLE001
            if temp_file:
                try:
                    os.remove(temp_file)
                except OSError:  # noqa: S110
                    pass
            return await deny_out(f"run_python: failed to start Python: {e}")

        timed_out = False
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(input=stdin_bytes), timeout=timeout)
            exit_code = proc.returncode
        except asyncio.TimeoutError:
            timed_out = True
            try:
                proc.kill()
            except (ProcessLookupError, OSError):  # noqa: S110
                pass
            try:
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=5)
            except Exception:  # noqa: BLE001
                stdout, stderr = b"", b""
            exit_code = proc.returncode
        except Exception as e:  # noqa: BLE001
            if temp_file:
                try:
                    os.remove(temp_file)
                except OSError:  # noqa: S110
                    pass
            return await deny_out(f"run_python: {label} could not run: {e}")

        if temp_file:
            try:
                os.remove(temp_file)
            except OSError:  # noqa: S110
                pass

        out_txt = (stdout or b"").decode("utf-8", "replace").strip()
        err_txt = (stderr or b"").decode("utf-8", "replace").strip()
        chunks: list[str] = []
        if out_txt:
            chunks.append(out_txt)
        if err_txt:
            chunks.append(f"[stderr]\n{err_txt}")
        body = "\n".join(chunks) or "(no output)"
        if len(body) > MAX_OUTPUT_CHARS:
            if exit_code not in (0, None):
                body = "...[earlier output truncated]\n" + body[-MAX_OUTPUT_CHARS:]
            else:
                body = body[:MAX_OUTPUT_CHARS] + "\n...[later output truncated]"

        if timed_out:
            return {
                "ok": True,
                "output": (
                    f"run_python: {label} was STILL RUNNING after {timeout:.0f}s and was stopped (no crash). "
                    "That is normal for a game/event loop — it started and kept going. "
                    "To actually prove behaviour, write a small smoke test that runs a few frames/inputs and asserts state, then run that.\n"
                    f"--- output so far ---\n{body}"
                ),
            }
        if exit_code == 0:
            return {"ok": True, "output": f"run_python: {label} exited 0 (ran successfully).\n--- output ---\n{body}"}
        return {
            "ok": False,
            "output": (
                f"run_python: {label} FAILED with exit code {exit_code}. "
                "Read the traceback/output below, fix the CAUSE, then run it again to confirm.\n"
                f"--- output ---\n{body}"
            ),
        }

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
            return await deny_out("play_game: no Python interpreter found. Set KASALIX_PYTHON, or run the game manually with run_command.")

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
            )
            try:
                stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=wall_limit + 20)
            except asyncio.TimeoutError:
                try:
                    proc.kill()
                except (ProcessLookupError, OSError):  # noqa: S110
                    pass
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
            lines.append("Open the frames with read_image to SEE what the game actually looks like.")

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

        # Give the model EYES on the game it just played. When the CODE model
        # itself is vision-capable the final frame rides along as a real image
        # (same mechanism as preview_screenshot — much more accurate than a
        # description). Otherwise the assigned vision model describes it — but
        # only for a direct call: the automatic replays just need the verdict,
        # and describing every one of them would be slow and wasteful.
        image_payload: dict[str, Any] = {}
        auto_replay = bool((extra or {}).get("game_auto"))
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
                        lines.append(f"The final frame is too large to attach — open {rel_last} with read_image.")
                except OSError:
                    lines.append(f"Could not attach {rel_last} — open it with read_image.")
            elif not auto_replay:
                try:
                    description = await describe_image(last_shot)
                    lines.append(f"What the final frame looks like (vision model):\n{description}")
                except Exception as e:  # noqa: BLE001
                    lines.append(f"(Could not describe {rel_last}: {e} — open it with read_image.)")

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
            return await deny_out(f"Access denied: {p} is the USER RULES file — it is read-only for you. The user edits it themselves. Save project knowledge to your own memory file (.agent-memory.md) with update_memory instead.")
        try:
            try:
                with open(target, "r", encoding="utf-8") as f:
                    original_content = f.read()
            except OSError:
                return await deny_out(f"Could not read {p} — the file may not exist. Use write_file to create it.")
            result = apply_search_replace(original_content, old_string, new_string)
            if not result.get("ok") or result.get("newContent") is None:
                return await deny_out(f"Edit failed: {result.get('error') or 'unknown error'}")
            cc = changed_line_count(original_content.replace("\r\n", "\n"), result["newContent"].replace("\r\n", "\n"))
            changed = cc["count"]
            total = cc["total"]
            if changed > max(20, int(total * 0.4)):
                return await deny_out(
                    f"Refusing this edit of {p}: it changes {changed} of {total} lines — that replaces most of the file instead of a targeted change. Use a SMALLER old_string that matches only the lines you are changing (include a couple of surrounding lines for uniqueness). If the USER really asked to rewrite the whole file, describe the new version in your final message and let the user apply it, instead of rewriting it yourself."
                )
            final_content = result["newContent"].replace("\r\n", "\n").replace("\n", "\r\n") if "\r\n" in original_content else result["newContent"]
            with open(target, "w", encoding="utf-8") as f:
                f.write(final_content)
            diff = summarize_diff(p, original_content, final_content)
            return {"ok": True, "output": f"Edited {p}.\n{diff}", "fileWrite": {"path": p, "changeType": "edited", "originalContent": original_content}}
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
            return await deny_out(f"Access denied: {p} is the USER RULES file — it is read-only for you. The user edits it themselves. Save project knowledge to your own memory file (.agent-memory.md) with update_memory instead.")
        try:
            original_content: str | None = None
            change_type = "created"
            try:
                with open(target, "r", encoding="utf-8") as f:
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
                        "Do NOT retry write_file with tweaked content — it will be refused again. Instead call edit_file: "
                        'first read_file to see the real content, then {"tool": "edit_file", "args": {"path": "' + p + '", "old_string": "<the exact existing lines you want to change>", "new_string": "<the changed lines>"}}. '
                        "Only change the lines you intend to change and include a couple of surrounding lines for uniqueness."
                    )
                final_content = norm_new.replace("\n", "\r\n") if "\r\n" in orig else norm_new
                with open(target, "w", encoding="utf-8") as f:
                    f.write(final_content)
                hunks = cc.get("hunks")
                display_changed = sum(max(h["oldCount"], h["newCount"]) for h in hunks) if hunks else changed
                change_label = f"changed {display_changed} line" + ("s" if display_changed != 1 else "")
                return {"ok": True, "output": f"Updated {p} — {change_label}.\n{summarize_diff(p, orig, final_content)}", "fileWrite": {"path": p, "changeType": "edited", "originalContent": orig}}

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
            with open(target, "w", encoding="utf-8") as f:
                f.write(content)
            return {"ok": True, "output": f"Created {p} ({len(content.encode('utf-8'))} bytes).", "fileWrite": {"path": p, "changeType": "created"}}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"Failed to write {p}: {e}")

    # ─── Live preview tools (Koding) ───────────────────────────────────
    # The agent can serve the workspace over a local HTTP server, have the
    # client open a real browser window, then screenshot it, evaluate JS in
    # it, and read its console — so it can TEST its own web work.
    if tool == "preview_start":
        root_real = os.path.realpath(root)
        entry = str(args.get("entry") or "").strip()
        entry_abs: str | None = None
        if entry:
            if re.search(r"^https?://", entry, re.I):
                return await deny_out("preview_start: entry must be a file path inside the workspace, not a URL.")
            entry_res = await resolve_in_workspace(root, entry)
            if not entry_res or not await is_file(entry_res):
                return await deny_out(f"preview_start: entry file not found: {entry}")
            entry_abs = os.path.realpath(entry_res)
            if os.path.commonpath([entry_abs, root_real]) != root_real:
                return await deny_out(f"preview_start: entry is outside the workspace: {entry}")
        # If the entry is a file, serve its containing directory (typical:
        # the workspace root); if it is a folder, serve that folder.
        serve_root = os.path.dirname(entry_abs) if entry_abs else root_real
        if os.path.commonpath([serve_root, root_real]) != root_real:
            serve_root = root_real
        from .preview import client_call, ensure_watcher, start_preview, wait_for_window_registered

        info = start_preview(serve_root)
        ensure_watcher(serve_root)
        if not info.get("ok"):
            return await deny_out(f"preview_start failed: {info.get('error')}")
        rel = os.path.relpath(serve_root, root_real).replace(os.sep, "/")
        entry_name = os.path.basename(entry_abs) if entry_abs else "index.html"
        base, _, query = info["url"].partition("?")
        page_url = f"{base}{'' if rel == '.' else rel + '/'}{entry_name}" + (f"?{query}" if query else "")
        try:
            open_result = await client_call({"type": "open", "url": page_url})
        except Exception as e:  # noqa: BLE001
            return {"ok": True, "output": (
                f"Preview server running at {page_url} (serving {'the workspace root' if rel == '.' else rel}). "
                f"No desktop client preview bridge responded ({e}) — the user can open that URL in a browser, "
                "but screenshot/eval/console verification needs the Kasalix client's preview window. "
                "Ask the user to open the Kasalix client, then call preview_start again."
            )}
        if not await wait_for_window_registered(8):
            return {"ok": True, "output": (
                f"Preview server running at {page_url} — the window was requested but the page has not connected yet. "
                "Wait a moment and use preview_screenshot / preview_console; if they fail, call preview_start again."
            )}
        if open_result.get("hidden"):
            return {"ok": True, "output": (
                f"Preview is LIVE (headless): {page_url}\n"
                "The user has hidden the preview window, so your verification runs invisibly — screenshot/eval/console all work "
                "normally, nothing appears on their screen. Mention in your final answer that the user can open "
                f"{page_url} in a browser to see the result. Call preview_stop when you are done."
            )}
        return {"ok": True, "output": (
            f"Preview is LIVE: {page_url}\n"
            "A preview window is open on the user's screen showing your work (it auto-reloads on file changes). "
            "Verify it with preview_screenshot and preview_console, interact via preview_eval. "
            "Call preview_stop when you are done."
        )}

    if tool == "preview_stop":
        from .preview import get_preview_session, stop_preview

        had = get_preview_session() is not None
        stop_preview()
        return {"ok": True, "output": "Preview stopped and window closed." if had else "No preview was running."}

    if tool == "preview_screenshot":
        from .preview import client_call, get_preview_session

        session = get_preview_session()
        if session is None:
            return await deny_out("No preview is running. Call preview_start first.")
        if not session.window_registered.is_set():
            return await deny_out("The preview window is not connected. Call preview_start again to open it.")
        try:
            data = await client_call({"type": "capture"}, timeout=15)
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"Screenshot capture failed: {e} — the preview window may be closed; call preview_start to reopen it.")
        img_path = str(data.get("path") or "")
        if not img_path or not os.path.isfile(img_path):
            return await deny_out("Screenshot capture returned no image — the preview window may be closed. Call preview_start to reopen it.")
        # Raw image path: when the CODE model is vision-capable, feed the
        # screenshot straight into its context (much more accurate than a
        # vision model's text description). Otherwise fall back to the
        # assigned vision model describing it.
        use_vision_model = bool((extra or {}).get("use_vision_model"))
        if use_vision_model:
            try:
                with open(img_path, "rb") as f:
                    b64 = base64.b64encode(f.read()).decode()
                size_kb = len(b64) * 3 // 4 // 1024
                if size_kb <= 3000:
                    return {
                        "ok": True,
                        "output": (
                            f"Screenshot captured ({size_kb} KB) — the image is attached to this tool result. "
                            "Look at it: verify layout, colors, and that the UI matches what was asked. "
                            "Then use preview_console to check for JS errors and preview_eval for state checks."
                        ),
                        "imageData": f"data:image/png;base64,{b64}",
                    }
                log_info(f"[agent] Screenshot too large for raw image ({size_kb} KB) — using vision-model description")
            except Exception as e:  # noqa: BLE001
                log_info(f"[agent] Raw screenshot read failed ({e}) — using vision-model description")
        desc = await describe_image(img_path)
        return {"ok": True, "output": f"Screenshot captured ({img_path}). What the page looks like:\n\n{desc}"}

    if tool == "preview_eval":
        from .preview import client_call, get_preview_session

        session = get_preview_session()
        if session is None:
            return await deny_out("No preview is running. Call preview_start first.")
        if not session.window_registered.is_set():
            return await deny_out("The preview window is not connected. Call preview_start again to open it.")
        code = args.get("code") if isinstance(args.get("code"), str) else ""
        if not code.strip():
            return await deny_out('preview_eval requires a "code" string (JavaScript to run in the preview page).')
        if len(code) > 10000:
            return await deny_out("preview_eval code too long (max 10000 chars).")
        try:
            data = await client_call({"type": "eval", "code": code}, timeout=10)
        except asyncio.TimeoutError:
            return await deny_out("preview_eval timed out (10s) — the expression may loop forever or the window was closed.")
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"preview_eval failed: {e}")
        return {"ok": True, "output": f"Eval result: {data.get('value')}"}

    if tool == "preview_console":
        from .preview import get_preview_session

        session = get_preview_session()
        if session is None:
            return await deny_out("No preview is running. Call preview_start first.")
        if not session.console:
            return {"ok": True, "output": "Console is empty — no console output or errors captured so far. (If the page just loaded, interact first or check preview_screenshot.)"}
        lines = [f"[{m['level']}] {m['text']}" for m in session.console[-80:]]
        errors = sum(1 for m in session.console if m["level"] == "error")
        return {"ok": True, "output": (f"Console ({len(session.console)} entries, {errors} error(s)):\n" + "\n".join(lines))}

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
            return await deny_out(f"Access denied: {p} is the USER RULES file — it is read-only for you. The user edits it themselves. Save project knowledge to your own memory file (.agent-memory.md) with update_memory instead.")
        try:
            original_content: str | None = None
            try:
                with open(target, "r", encoding="utf-8") as f:
                    original_content = f.read()
            except OSError:  # noqa: S110
                pass
            os.remove(target)
            return {"ok": True, "output": f"Deleted {p}.", "fileWrite": {"path": p, "changeType": "deleted", "originalContent": original_content}}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"Failed to delete {p}: {e}")

    if tool == "delegate_to_subagent":
        if not auto_apply:
            return await deny_out("delegate_to_subagent is disabled — auto-apply mode is OFF.")
        task = args.get("task") if isinstance(args.get("task"), str) else ""
        if not task.strip():
            return await deny_out('delegate_to_subagent requires a "task" string argument describing the sub-task.')
        sub_model = args.get("model") if isinstance(args.get("model"), str) and args.get("model").strip() else None
        sub_type = args.get("type") if isinstance(args.get("type"), str) else "general"
        file_tree = await list_workspace_tree(root)
        ground_truth = "WORKSPACE FILES:\n" + file_tree
        if sub_type == "explore":
            sub_system = f"You are an EXPLORE sub-agent — fast read-only codebase search. Your task: {task}\n\nYou can ONLY read files and search. You CANNOT write, edit, or delete anything.\nSearch thoroughly: use glob, grep, read_file, list_files. Report all findings concisely.\n\n{ground_truth}"
        elif sub_type == "plan":
            sub_system = f"You are a PLAN sub-agent — architecture planning. Your task: {task}\n\nExplore the codebase and produce a detailed implementation plan. You CANNOT write code — only read files and output a plan.\nFormat your plan as numbered steps with file paths.\n\n{ground_truth}"
        elif sub_type == "reviewer":
            sub_system = f"You are a CODE REVIEW sub-agent. Your task: {task}\n\nRead the specified files, review the code for bugs, style issues, and improvements. You CANNOT write code — only read and report.\nBe specific: reference file paths and line numbers.\n\n{ground_truth}"
        else:
            sub_system = f"You are a focused sub-agent. Your task: {task}\n\nYou have the same tools as the parent agent. Complete the task and respond with your findings/results. Be concise — the parent agent is waiting for your output.\n\n{ground_truth}"
        try:
            sub_result = await run_sub_agent(
                root, task, sub_model,
                {"model": sub_model or "default", "messages": [{"role": "system", "content": sub_system}], "autoApply": auto_apply, "callbacks": {"onStage": lambda _s: None, "onChunk": lambda _c: None}},
                auto_apply,
            )
            return {"ok": True, "output": f"[SUB-AGENT ({sub_type}) RESULT]\n{sub_result}"}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"Sub-agent failed: {e}")

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
        try:
            original_content: str | None = None
            try:
                with open(from_target["target"], "r", encoding="utf-8") as f:
                    original_content = f.read()
            except OSError:  # noqa: S110
                pass
            os.makedirs(os.path.dirname(to_full), exist_ok=True)
            os.rename(from_target["target"], to_full)
            return {"ok": True, "output": f"Renamed {from_path} → {to_path}", "fileWrite": {"path": to_path, "changeType": "created", "originalContent": original_content}}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"Failed to rename {from_path} → {to_path}: {e}")

    if tool == "read_url":
        url = args.get("url") if isinstance(args.get("url"), str) else ""
        if not url:
            return await deny_out('read_url requires a "url" string argument.')
        if not re.match(r"^https?://", url, re.I):
            return await deny_out("URL must start with http:// or https://")
        try:
            import httpx

            async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
                res = await client.get(url, headers={"User-Agent": "Koding/1.0 (agent read_url)"})
            if res.status_code >= 400:
                return await deny_out(f"HTTP {res.status_code}: {res.reason_phrase}")
            html = res.text
            text = re.sub(r"<script[\s\S]*?</script>", " ", html, flags=re.I)
            text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.I)
            text = re.sub(r"<nav[\s\S]*?</nav>", " ", text, flags=re.I)
            text = re.sub(r"<header[\s\S]*?</header>", " ", text, flags=re.I)
            text = re.sub(r"<footer[\s\S]*?</footer>", " ", text, flags=re.I)
            text = re.sub(r"<[^>]+>", " ", text)
            text = re.sub(r"\s+", " ", text).strip()
            capped = text[:MAX_OUTPUT_CHARS] + "\n...[truncated]" if len(text) > MAX_OUTPUT_CHARS else text
            return {"ok": True, "output": f"[URL: {url}]\n{capped or '(page returned empty content)'}"}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"Failed to fetch {url}: {e}")

    if tool == "find_references":
        query = args.get("query") if isinstance(args.get("query"), str) else ""
        if not query.strip():
            return await deny_out('find_references requires a "query" string argument.')
        try:
            results: list[str] = []
            ignored = {"node_modules", ".git", "dist", "build", ".cache", "__pycache__", "vendor", ".venv", "venv"}

            async def walk(dir: str, depth: int) -> None:
                if depth > 6 or len(results) > MAX_SEARCH_MATCHES:
                    return
                if is_protected_path(root, dir):
                    return
                try:
                    entries = os.listdir(dir)
                except OSError:
                    return
                for name in entries:
                    if name.startswith(".") or name in ignored:
                        continue
                    full = os.path.join(dir, name)
                    if os.path.isdir(full):
                        await walk(full, depth + 1)
                    else:
                        try:
                            content = open(full, "r", encoding="utf-8", errors="replace").read()
                            lines = content.split("\n")
                            for i, line in enumerate(lines):
                                if query in line:
                                    rel = os.path.relpath(full, root).replace(os.sep, "/")
                                    results.append(f"{rel}:{i + 1}: {line.strip()[:120]}")
                                    if len(results) >= MAX_SEARCH_MATCHES:
                                        return
                        except OSError:  # noqa: S110
                            pass

            await walk(root, 0)
            if not results:
                return {"ok": True, "output": f'No references to "{query}" found in the workspace.'}
            return {"ok": True, "output": f'Found {len(results)} reference(s) to "{query}":\n' + "\n".join(results)}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"find_references failed: {e}")

    if tool == "refactor_rename":
        if not auto_apply:
            return await deny_out("refactor_rename is disabled — auto-apply mode is OFF.")
        old_name = args.get("oldName") if isinstance(args.get("oldName"), str) else ""
        new_name = args.get("newName") if isinstance(args.get("newName"), str) else ""
        if not old_name or not new_name:
            return await deny_out('refactor_rename requires "oldName" and "newName" string arguments.')
        if old_name == new_name:
            return await deny_out("oldName and newName are the same — nothing to do.")
        try:
            changed: list[str] = []
            ignored = {"node_modules", ".git", "dist", "build", ".cache", "__pycache__", "vendor", ".venv", "venv"}
            pattern = re.compile(r"\b" + re.escape(old_name) + r"\b")

            async def walk(dir: str, depth: int) -> None:
                if depth > 6:
                    return
                if is_protected_path(root, dir):
                    return
                try:
                    entries = os.listdir(dir)
                except OSError:
                    return
                for name in entries:
                    if name.startswith(".") or name in ignored:
                        continue
                    full = os.path.join(dir, name)
                    if os.path.isdir(full):
                        await walk(full, depth + 1)
                    else:
                        try:
                            content = open(full, "r", encoding="utf-8", errors="replace").read()
                            if not pattern.search(content):
                                continue
                            new_content = pattern.sub(new_name, content)
                            with open(full, "w", encoding="utf-8") as f:
                                f.write(new_content)
                            rel = os.path.relpath(full, root).replace(os.sep, "/")
                            count = len(pattern.findall(content))
                            changed.append(f"{rel} ({count} occurrence{'s' if count != 1 else ''})")
                        except OSError:  # noqa: S110
                            pass

            await walk(root, 0)
            if not changed:
                return {"ok": True, "output": f'No occurrences of "{old_name}" found — nothing renamed.'}
            return {"ok": True, "output": f'Renamed "{old_name}" → "{new_name}" in {len(changed)} file(s):\n' + "\n".join(changed)}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"refactor_rename failed: {e}")

    if tool == "create_directory":
        if not auto_apply:
            return await deny_out("create_directory is disabled — auto-apply mode is OFF.")
        p = args.get("path") if isinstance(args.get("path"), str) else ""
        if not p:
            return await deny_out('create_directory requires a "path" string argument.')
        target = os.path.abspath(os.path.join(root, p))
        if not (await is_path_inside(root, target)):
            return await deny_out(f"Access denied: {p} is outside the workspace.")
        if is_protected_path(root, target):
            return await deny_out(f"Access denied: {p} is a protected directory.")
        try:
            os.makedirs(target, exist_ok=True)
            return {"ok": True, "output": f"Created directory {p}"}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"Failed to create {p}: {e}")

    if tool == "file_exists":
        p = args.get("path") if isinstance(args.get("path"), str) else ""
        if not p:
            return await deny_out('file_exists requires a "path" string argument.')
        target = os.path.abspath(os.path.join(root, p))
        if not (await is_path_inside(root, target)):
            return await deny_out(f"Access denied: {p} is outside the workspace.")
        try:
            stat = os.stat(target)
            kind = "directory" if os.path.isdir(target) else "file"
            size = "" if os.path.isdir(target) else f" ({os.path.getsize(target) / 1024:.1f}KB)"
            return {"ok": True, "output": f"{p} exists — {kind}{size}"}
        except OSError:
            return {"ok": True, "output": f"{p} does not exist"}

    if tool == "read_url_image":
        if not auto_apply:
            return await deny_out("read_url_image is disabled — auto-apply mode is OFF.")
        url = args.get("url") if isinstance(args.get("url"), str) else ""
        save_as = args.get("saveAs") if isinstance(args.get("saveAs"), str) else ""
        if not url:
            return await deny_out('read_url_image requires a "url" string argument.')
        if not save_as:
            return await deny_out('read_url_image requires a "saveAs" string argument (local path to save to).')
        if not re.match(r"^https?://", url, re.I):
            return await deny_out("URL must start with http:// or https://")
        save_target = os.path.abspath(os.path.join(root, save_as))
        if not (await is_path_inside(root, save_target)):
            return await deny_out(f"Access denied: {save_as} is outside the workspace.")
        try:
            import httpx

            async with httpx.AsyncClient(timeout=15, follow_redirects=True) as client:
                res = await client.get(url)
            if res.status_code >= 400:
                return await deny_out(f"HTTP {res.status_code}: {res.reason_phrase}")
            content_type = res.headers.get("content-type", "")
            if "image" not in content_type:
                return await deny_out(f"URL is not an image (content-type: {content_type})")
            data = res.content
            os.makedirs(os.path.dirname(save_target), exist_ok=True)
            with open(save_target, "wb") as f:
                f.write(data)
            return {"ok": True, "output": f"Downloaded {url} → {save_as} ({len(data) / 1024:.1f}KB)", "fileWrite": {"path": save_as, "changeType": "created"}}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"Failed to download {url}: {e}")

    if tool == "diff_files":
        file_a = args.get("fileA") if isinstance(args.get("fileA"), str) else ""
        file_b = args.get("fileB") if isinstance(args.get("fileB"), str) else ""
        content_b = args.get("contentB") if isinstance(args.get("contentB"), str) else ""
        if not file_a:
            return await deny_out('diff_files requires a "fileA" argument.')
        target_a = await resolve_in_workspace(root, file_a)
        if not target_a:
            return await deny_out(f"Access denied: {file_a} is outside the workspace.")
        try:
            with open(target_a, "r", encoding="utf-8") as f:
                content_a = f.read()
            if content_b:
                b_content = content_b
            elif file_b:
                target_b = await resolve_in_workspace(root, file_b)
                if not target_b:
                    return await deny_out(f"Access denied: {file_b} is outside the workspace.")
                with open(target_b, "r", encoding="utf-8") as f:
                    b_content = f.read()
            else:
                return await deny_out('diff_files requires either "fileB" or "contentB" argument.')
            return {"ok": True, "output": summarize_diff(file_a, content_a, b_content)}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"diff_files failed: {e}")

    if tool == "replace_in_file":
        if not auto_apply:
            return await deny_out("replace_in_file is disabled — auto-apply mode is OFF.")
        p = args.get("path") if isinstance(args.get("path"), str) else ""
        find = args.get("find") if isinstance(args.get("find"), str) else ""
        replace = args.get("replace") if isinstance(args.get("replace"), str) else ""
        if not p or not find:
            return await deny_out('replace_in_file requires "path" and "find" arguments.')
        target = await resolve_in_workspace(root, p)
        if not target:
            return await deny_out(f"Access denied: {p} is outside the workspace.")
        if is_user_rules_path(root, target):
            return await deny_out(f"Access denied: {p} is the USER RULES file — read-only.")
        try:
            with open(target, "r", encoding="utf-8") as f:
                original_content = f.read()
            use_regex = args.get("regex") is True
            if use_regex:
                pattern = re.compile(find)
                count = len(pattern.findall(original_content))
                new_content = pattern.sub(replace, original_content)
            else:
                count = original_content.count(find)
                new_content = original_content.replace(find, replace)
            if count == 0:
                return {"ok": True, "output": f'No occurrences of "{find}" found in {p} — nothing replaced.'}
            with open(target, "w", encoding="utf-8") as f:
                f.write(new_content)
            return {"ok": True, "output": f'Replaced {count} occurrence(s) of "{find}" → "{replace}" in {p}', "fileWrite": {"path": p, "changeType": "edited", "originalContent": original_content}}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"replace_in_file failed: {e}")

    if tool == "count_lines":
        p = args.get("path") if isinstance(args.get("path"), str) else ""
        if not p:
            return await deny_out('count_lines requires a "path" argument.')
        target = os.path.abspath(os.path.join(root, p))
        if not (await is_path_inside(root, target)):
            return await deny_out(f"Access denied: {p} is outside the workspace.")
        try:
            if os.path.isfile(target):
                with open(target, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()
                lines = content.count("\n") + 1
                words = len(content.split())
                return {"ok": True, "output": f"{p}: {lines} lines, {words} words, {len(content)} chars"}
            total_lines = total_words = total_files = 0
            ignored = {"node_modules", ".git", "dist", "build", ".cache", "__pycache__", "vendor", ".venv"}

            async def walk(dir: str, depth: int) -> None:
                nonlocal total_lines, total_words, total_files
                if depth > 4:
                    return
                if is_protected_path(root, dir):
                    return
                try:
                    entries = os.listdir(dir)
                except OSError:
                    return
                for name in entries:
                    if name.startswith(".") or name in ignored:
                        continue
                    full = os.path.join(dir, name)
                    if os.path.isdir(full):
                        await walk(full, depth + 1)
                    else:
                        try:
                            content = open(full, "r", encoding="utf-8", errors="replace").read()
                            total_lines += content.count("\n") + 1
                            total_words += len(content.split())
                            total_files += 1
                        except OSError:  # noqa: S110
                            pass

            await walk(target, 0)
            return {"ok": True, "output": f"{p}: {total_files} files, {total_lines} lines, {total_words} words"}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"count_lines failed: {e}")

    if tool == "glob":
        pattern = args.get("pattern") if isinstance(args.get("pattern"), str) else ""
        if not pattern:
            return await deny_out('glob requires a "pattern" string argument (e.g. "**/*.py").')
        try:
            matches: list[str] = []
            ignore = {"node_modules", ".git", "dist", "build", ".cache", "__pycache__", "vendor", ".venv", ".next", ".output", "coverage"}

            def _glob_to_regex(p: str) -> re.Pattern:
                s = re.escape(p)
                s = s.replace(r"\*\*", "{{GLOBSTAR}}")
                s = s.replace(r"\*", "[^/]*")
                s = s.replace(r"\?", "[^/]")
                s = re.sub(r"\\\{([^}]+)\\\}", lambda m: "(" + "|".join(x.strip() for x in m.group(1).split(",")) + ")", s)
                s = s.replace("{{GLOBSTAR}}", ".*")
                return re.compile("^" + s + "$")

            parts = pattern.split("/")
            has_dir_prefix = len(parts) > 1 and "*" not in parts[0]
            search_root = os.path.join(root, parts[0]) if has_dir_prefix else root
            file_pattern = "/".join(parts[1:]) if has_dir_prefix else pattern
            file_regex = _glob_to_regex(file_pattern)

            async def walk(dir: str, depth: int) -> None:
                if depth > 8 or len(matches) >= 200:
                    return
                if is_protected_path(root, dir):
                    return
                try:
                    entries = os.listdir(dir)
                except OSError:
                    return
                for name in entries:
                    if name in ignore:
                        continue
                    full = os.path.join(dir, name)
                    rel = os.path.relpath(full, root).replace(os.sep, "/")
                    if os.path.isdir(full):
                        await walk(full, depth + 1)
                    elif file_regex.search(name) or file_regex.search(rel):
                        matches.append(rel)

            if has_dir_prefix:
                if not os.path.isdir(search_root):
                    return {"ok": True, "output": f'No matches for "{pattern}" — directory does not exist.'}
                await walk(search_root, 0)
            else:
                await walk(root, 0)

            with_mtime: list[tuple[str, float]] = []
            for m in matches:
                try:
                    with_mtime.append((m, os.path.getmtime(os.path.join(root, m))))
                except OSError:
                    with_mtime.append((m, 0))
            with_mtime.sort(key=lambda x: -x[1])
            sorted_matches = [m for m, _ in with_mtime]
            if not sorted_matches:
                return {"ok": True, "output": f'No files match pattern "{pattern}".'}
            return {"ok": True, "output": f'Found {len(sorted_matches)} file(s) matching "{pattern}":\n' + "\n".join(sorted_matches)}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"glob failed: {e}")

    if tool == "multi_edit":
        if not auto_apply:
            return await deny_out("multi_edit is disabled — auto-apply mode is OFF.")
        p = args.get("path") if isinstance(args.get("path"), str) else ""
        edits = args.get("edits") if isinstance(args.get("edits"), list) else []
        if not edits and isinstance(args.get("changes"), list):
            edits = args["changes"]  # common dialect drift: "changes" instead of "edits"
        if not edits and isinstance(args.get("replacements"), list):
            edits = args["replacements"]
        if not p and isinstance(args.get("file"), str):
            p = args["file"]  # dialect drift: "file" instead of "path"
        if not p or not edits:
            return await deny_out(
                'multi_edit requires "path" and "edits" (array of {"old_string", "new_string"}). '
                'Example: {"tool": "multi_edit", "args": {"path": "main.py", "edits": [{"old_string": "x = 1", "new_string": "x = 2"}]}} '
                "— each edit needs BOTH old_string and new_string as strings."
            )
        res = await resolve_target_smart(root, p)
        if res.get("error"):
            return await deny_out(res["error"])
        target = res["target"]
        if is_user_rules_path(root, target):
            return await deny_out(f"Access denied: {p} is the USER RULES file — it is read-only for you.")
        try:
            with open(target, "r", encoding="utf-8") as f:
                content = f.read()
            original_content = content
            applied_count = 0
            for i, edit in enumerate(edits):
                if not isinstance(edit, dict):
                    return await deny_out(f"Edit #{applied_count + 1}: invalid edit object — must be {{\"old_string\": ..., \"new_string\": ...}}.")
                # Accept the camelCase / snake_case drift models emit.
                old_string = edit.get("old_string") if isinstance(edit.get("old_string"), str) else (edit.get("oldString") if isinstance(edit.get("oldString"), str) else "")
                new_string = edit.get("new_string") if isinstance(edit.get("new_string"), str) else (edit.get("newString") if isinstance(edit.get("newString"), str) else "")
                if not old_string:
                    return await deny_out(f"Edit #{applied_count + 1}: old_string is empty.")
                if old_string == new_string:
                    return await deny_out(f"Edit #{applied_count + 1}: old_string and new_string are identical.")
                result = apply_search_replace(content, old_string, new_string)
                if not result.get("ok") or result.get("newContent") is None:
                    return await deny_out(f"Edit #{applied_count + 1} failed: {result.get('error') or 'old_string not found'}. All {applied_count} previous edits were rolled back.")
                content = result["newContent"]
                applied_count += 1
            final_content = content.replace("\r\n", "\n").replace("\n", "\r\n") if "\r\n" in original_content else content
            with open(target, "w", encoding="utf-8") as f:
                f.write(final_content)
            cc = changed_line_count(original_content.replace("\r\n", "\n"), final_content.replace("\r\n", "\n"))
            changed = cc["count"]
            return {"ok": True, "output": f"Applied {applied_count} edit(s) to {p} — changed {changed} line(s).", "fileWrite": {"path": p, "changeType": "edited", "originalContent": original_content}}
        except Exception as e:  # noqa: BLE001
            return await deny_out(f"multi_edit failed: {e}")

    names = ", ".join(t["name"] for t in AGENT_TOOL_DEFS)
    return await deny_out(f'Unknown tool "{tool}". Available: {names}')


def _token_touches_protected(tok: str) -> bool:
    t = re.sub(r'^["\'(`]+|["\')]`]+$', "", tok)
    if not t:
        return False
    lower = t.lower()
    for d in PROTECTED_DIRS:
        dl = d.lower()
        if (
            lower == dl
            or lower.startswith(dl + "/")
            or lower.startswith(dl + "\\")
            or lower.startswith("./" + dl + "/")
            or lower.startswith("./" + dl + "\\")
            or lower.startswith("../" + dl + "/")
            or lower.startswith("../" + dl + "\\")
            or lower.startswith("..\\" + dl + "/")
            or lower.startswith("..\\" + dl + "\\")
            or lower == "../" + dl
            or lower == "..\\" + dl
        ):
            return True
    return False


def _token_touches_rules(tok: str) -> bool:
    t = re.sub(r'^["\'(`]+|["\')]`]+$', "", tok)
    if not t:
        return False
    lower = t.lower().replace("\\", "/")
    for f in USER_RULES_FILENAMES:
        fl = f.lower()
        if lower == fl or lower.endswith("/" + fl) or lower.startswith("./" + fl):
            return True
    return False


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


# ─── The agent loop ─────────────────────────────────────────────────────
def available_tools(auto_apply: bool) -> list[dict[str, Any]]:
    return [t for t in AGENT_TOOL_DEFS if auto_apply or not t["mutating"]]


def build_system_prompt(workspace_path: str, user_name: str, auto_apply: bool) -> str:
    tools = available_tools(auto_apply)
    tool_list = "\n".join(f"- {t['name']}: {t['description']}\n  Example: {t['args']}" for t in tools)
    # Per-tool JSON examples were defined but never included — models produced
    # far more malformed calls without them (no worked examples to copy).
    examples = TOOL_JSON_EXAMPLES
    availability = (
        "FULL — you CAN and SHOULD execute real commands (python, py -3.11, pip, node, npm, git, dir/ls) "
        "with the run_command tool, and RUN Python scripts you wrote with the run_python tool. "
        "If the user asks you to run, test, or install something, call the tool — "
        "NEVER claim you cannot run commands or execute code. Results come back to you as tool output."
        if auto_apply
        else "read-only (no run_command)"
    )
    return f"""## YOU ARE KODING — A CODING AGENT ##
Workspace: {workspace_path}

You have {len(tools)} tools. Use them — respond with ONLY a single JSON object.
{tool_list}

TOOL CALL FORMAT (the ONLY accepted one):
{{"tool": "<tool_name>", "args": {{...}} }}
Example: {{"tool": "read_file", "args": {{"path": "src/main.py"}}}}
NEVER use other key names like "name" or "arguments" — only "tool" and "args".
Respond with ONLY the JSON object — no markdown fences, no explanation before or after.
NEVER write a call as [read_file, {{"path": "x.py"}}] or read_file(path="x.py") or <read_file> —
those are NOT valid JSON and execute NOTHING. You would only be TALKING about reading or
testing the file while the user sees no tool run. Always use {{"tool": "...", "args": {{...}}}}.
JSON rules: NO trailing commas, ALL keys in double quotes, newlines inside strings MUST be escaped as \\n.
HOW THE CONVERSATION WORKS: your tool calls and their results appear in the history as
[TOOL RESULT] user-messages — those are YOUR actions coming back to you, not the user
speaking. Only real user messages (without the [TOOL RESULT]/[SYSTEM] prefix) are from
the human.

{examples}

AVAILABILITY: {availability}

YOU ARE THE AGENT, NOT THE USER. In your private thinking, refer to YOURSELF as the one
acting: "I'll check the file", "my edit failed", "let me fix the old_string". The user
requested the task — everything in the tool history (tool calls, results, edits, commands)
was done BY YOU. NEVER write "the user tried to edit" or "they encountered an error" —
you made those tool calls and you hit those errors. The user only sends plain messages.

TESTING YOUR WEB WORK (HTML/CSS/JS): you CAN see and verify what you build — you are not
limited to writing code blind. For any web page or browser app: after writing the files,
call preview_start {{"entry": "index.html"}} to open a live preview window of the page,
then preview_screenshot to SEE it (the screenshot is attached to the tool result as an
image — analyze what is ACTUALLY visible in it, never assume the page rendered as
code intended), preview_console to check for JS errors, and
preview_eval to inspect or interact with the page (e.g. read game state, click buttons by
dispatching events, query DOM). Fix what you see until it works, then preview_stop. Do
this BEFORE telling the user you are done. Preview needs the desktop client running; if
it is unavailable, fall back to run_command checks or carefully reviewing the code.

VERIFYING PYTHON / DESKTOP / CLI PROGRAMS: you can RUN what you build — never guess whether
a fix worked. After writing or changing a Python script (or any program you can execute),
verify it with run_python BEFORE you report success:
- {{"tool": "run_python", "args": {{"path": "snake.py"}}}} runs the script HEADLESS (SDL video
  + audio set to dummy, matplotlib Agg) with a timeout, and returns the exit code plus
  stdout/stderr. Use "code" for a one-off inline snippet.
- exit code 0 = it ran. A traceback or nonzero exit = it is STILL BROKEN — read the traceback,
  fix the CAUSE, then run it again. Do not report a fix you have not run.
- "STILL RUNNING after Ns (no crash)" means it started and looped without crashing — normal
  for a game. To prove BEHAVIOUR, write a tiny smoke test (e.g. tests/smoke.py) that imports
  the module, steps the update/event loop a few frames, feeds synthetic input, and asserts
  state (assert player.x > 0, assert len(enemies) == 3) — then run THAT with run_python.
  That turns "I think it's fixed" into "I ran it and it works".
- If a needed package is missing, check with run_command (python --version, pip show pygame)
  and report honestly — never claim you tested something you could not run. run_python
  automatically prefers a virtualenv inside the workspace (venv/.venv), so the project's
  own packages are used when present.

PLAYING GAMES AND INTERACTIVE APPS (pygame/SDL): when the user reports a game BEHAVIOUR
bug ("the snake isn't moving", "the player won't jump"), you must reproduce it by actually
PLAYING the game — reading the code again will not settle it. Use play_game:
{{"tool": "play_game", "args": {{"path": "snake.py", "frames": 120,
 "inputs": [{{"frame": 0, "keys": ["right"]}}, {{"frame": 40, "keys": ["down"]}}],
 "screenshotEvery": 20}}}}
- It runs the game headless with a deterministic clock, HOLDS the keys you specify from each
  frame onward (input changes replace the held set), auto-quits at the frame limit, and
  captures PNG frames.
- It reports changedPixels per captured frame — how many pixels differ from the previous
  capture. If frames that should be animating show changedPixels=0, the thing the user
  complained about IS still broken; fix it and play again.
- To SEE the game: if your model can view images, the FINAL frame is attached to the
  play_game result directly — look at it and judge sprite position, score/UI and rendering.
  Otherwise call read_image on the captured .kx_frames/*.png paths.
- It also dumps the game's module-level variables at exit (score, lives, game_over,
  player position...) so you can check game LOGIC, not just pixels. If the value you need
  is local to main(), ask the game to print it (its stdout is shown to you) — or keep the
  state in a module-level name.
- A headless game check ALSO runs AUTOMATICALLY after you edit a .py file, and its result
  arrives as a [GAME CHECK ...] message. Treat [GAME CHECK FAILED] as a real bug: fix the
  cause and the game is replayed for you. Never claim the behaviour is fixed while the last
  check failed, and never write "it should be fixed now".
- Only claim a behaviour is fixed after play_game shows motion AND the frames look right.
  If the game cannot run here (no pygame), say so honestly instead of guessing.
STOP WHEN IT IS FIXED: once your verification passes you are DONE. Do not keep rewriting a
working fix just because you cannot see the window, and NEVER write "it should be fixed now"
as a substitute for running it. If you changed code and your run succeeds, say exactly what
you ran and what it proved, then stop."""


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

    # ── Auto-create rules & memory files if missing ────────────────────
    rules_path = os.path.join(root, ".agent-rules.md")
    memory_path = os.path.join(root, ".agent-memory.md")
    if not os.path.exists(rules_path):
        with open(rules_path, "w", encoding="utf-8") as f:
            f.write("# Project Rules\n\nAdd project-specific instructions below. Global AI rules are in AI_RULES.md.\n")
        log_info(f"[agent] Auto-created .agent-rules.md in {root}")
    if not os.path.exists(memory_path):
        with open(memory_path, "w", encoding="utf-8") as f:
            f.write("# Agent Memory\n\n_Durable notes from previous sessions. The AI appends lessons here (build commands, framework conventions, gotchas).\n")
        log_info(f"[agent] Auto-created .agent-memory.md in {root}")

    # ── Session log ────────────────────────────────────────────────────
    session_log = SessionLog()
    await session_log.init()
    log_info(f"[agent] Session log: {session_log.get_file_path()}")

    _cb(opts, "onStage", "agent:thinking")

    file_tree = await list_workspace_tree(root)
    last_user_msg = next((m.get("content", "") for m in reversed(opts["messages"]) if m.get("role") == "user"), "") or ""
    try:
        referenced_files = await collect_referenced_files(last_user_msg, root)
    except Exception:  # noqa: BLE001
        referenced_files = ""
    verify = await detect_verify_command(root)
    # A playable pygame game in the workspace — replayed automatically after
    # every Python edit so behaviour claims are backed by an actual play test.
    game_target = await detect_game_target(root) if auto_apply else None
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
    try:
        from .capabilities import get_model_capabilities

        use_vision_model = bool((await get_model_capabilities(model)).get("vision"))
    except Exception:  # noqa: BLE001
        use_vision_model = False
    project_rules = await read_project_rules(root)
    agent_memory = await read_agent_memory(root)
    project_config = await read_project_config(root)
    workspace_profile = await build_workspace_profile(root, (verify or {}).get("command"), project_rules, agent_memory, project_config)
    system = await with_ai_rules(build_system_prompt(root, user_name or "a user", auto_apply), "agent")

    # ── Resume state (from opts or latest session log) ────────────────
    resume_state = opts.get("resumeState") or {}
    session_log_history: list[dict[str, str]] = []
    if not (resume_state.get("history") or []):
        try:
            log_list = await list_session_logs()
            if log_list:
                events = await read_session_log(log_list[0]["runId"])
                session_log_history = [
                    {"role": e["role"], "content": e["content"]}
                    for e in events
                    if e.get("type") == "message" and e.get("role") and e.get("content")
                ]
                if session_log_history:
                    log_info(f"[agent] Resumed {len(session_log_history)} messages from session log {log_list[0]['runId']}")
        except Exception as e:  # noqa: BLE001
            log_info(f"[agent] Could not resume from session log: {e}")

    last_user_msgs = [{"role": "user", "content": m.get("content", "")} for m in opts["messages"] if m.get("role") == "user"]
    if resume_state.get("history"):
        history: list[dict[str, str]] = [
            *resume_state["history"],
            *[{"role": "user", "content": "[RESUMING a previously stopped run] " + m["content"]} for m in last_user_msgs[-1:]],
        ]
    elif session_log_history:
        history = [
            *session_log_history,
            *[{"role": "user", "content": "[RESUMING from session log] " + m["content"]} for m in last_user_msgs[-1:]],
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
        baseline_out = await _run_verify(verify["command"], root, verify_cap)
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
        baseline_check = await run_game_check(root, game_target, use_vision_model=use_vision_model)
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
            await stream_chat_with_retry(opts, plan_prompt, plan_chunks.append, lambda _t: None)
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
    preview_start_count = 0
    preview_redirect_injected = False
    # Self-sabotage guard state: files the model itself created/edited this run.
    # Deleting your own fresh work (write → delete → write churn) is almost
    # always a confused rewrite loop, not a user request.
    files_touched_this_run: set[str] = set()
    mutation_failed_ever = False   # any mutation attempt failed at some point
    mut_attempt_failed_last = False  # the most recent tool round had a failed mutation
    mut_recovered_last = False     # a mutation succeeded after that failure
    mut_fail_counts: dict[str, int] = {}  # per-path mutation failure counts (recovery trigger)
    false_success_challenged = False  # one-shot: challenged a false completion claim at the final-answer path
    user_wants_deletion = bool(re.search(r"\b(delet?e|remove|get rid of|clean up)\b", last_user_msg, re.I))
    malformed_tool_calls = 0
    # Separate budget for "the model replied with NOTHING but reasoning"
    # rounds (empty content, no tool call) — see the empty-response guard.
    empty_response_retries = 0
    # Separate budget for pure tool-FORMAT retries ("looked like a tool call
    # but was not valid JSON"). Previously this shared malformed_tool_calls
    # with the behavioral guards (false-success, promised-work, thinking-has-
    # code...), so a chatty run burned the format budget on behavior retries
    # and lost its chance to fix mere JSON formatting.
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

    try:
        iter = 0
        while iter < max_iterations:
            iter += 1
            if signal is not None and signal.is_set():
                raise asyncio.CancelledError()
            pending_image: str | None = None  # raw screenshot for vision-capable models (this iteration)

            bounded_base = [history[0], *history[-(MAX_HISTORY - 1):]] if len(history) > MAX_HISTORY else history
            plan_block = (
                "\n\nYOUR PLAN (update as you complete steps):\n" + "\n".join(f"{i + 1}. [ ] {l}" for i, l in enumerate(plan_text.split("\n")))
                if (iter == 0 and plan_text)
                else ("\n\nCOMPLETED STEPS:\n" + "\n".join(f"- [x] {s}" for s in completed_steps) if completed_steps else "")
            )

            compact_result = prune_to_budget([
                {"role": "system", "content": ground_truth_block + plan_block},
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
            await stream_chat_with_retry(opts, bounded, chunks.append, thinking_chunks.append)
            raw = "".join(chunks)

            tool_calls = extract_tool_calls(raw)
            tool_call = tool_calls[0] if len(tool_calls) == 1 else None

            # Truncated-generation guard: a salvaged MUTATING call means the
            # model ran out of tokens mid-JSON (unclosed content string).
            # Executing it would silently write a HALF file — the exact bug
            # behind "the file only has 32 lines / ends at 'cyan'". Refuse it
            # with instructions; the model retries in smaller pieces.
            truncated_calls = [
                tc for tc in tool_calls
                if (tc.get("args") or {}).pop("_truncated", None) and tc["tool"] in MUTATING_TOOLS
            ]
            if truncated_calls:
                t_paths = ", ".join(str(tc["args"].get("path") or "unknown") for tc in truncated_calls)
                log_info(f"[agent] Refusing truncated tool call(s): {[tc['tool'] for tc in truncated_calls]} → {t_paths}")
                malformed_tool_calls += 1
                history.append({"role": "assistant", "content": raw})
                history.append({"role": "user", "content": (
                    "[TRUNCATED CALL] Your last tool call was cut off mid-JSON (you likely ran out of output tokens), "
                    f"so it was NOT executed — no file was written or changed ({t_paths}). Do NOT retry the same full call. "
                    "Instead: write files in SMALLER pieces — create the file with just the first part via write_file, then "
                    "append the rest with edit_file (old_string = the file's last existing line). Keep every single call "
                    "well under the output limit. If even one part is too big, split it again."
                )})
                _cb(opts, "onStage", "agent:working")
                continue
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
                    log_info("[agent] Empty content with no tool call — nudging model to reply")
                    _cb(opts, "onChunk", "\n\n_⚙️ The model reasoned but sent no answer — asking it to reply…_\n")
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

            if not tool_calls and malformed_tool_calls < 4:
                plain_tools = re.findall(r"\b(list_files|read_file|search_files|run_command|run_python|play_game|web_search|read_image|read_rules|update_memory|ask_user|git_status|git_diff|git_commit|edit_file|write_file|delete_file|delegate_to_subagent|rename_file|read_url|find_references|refactor_rename|create_directory|file_exists|read_url_image|diff_files|replace_in_file|count_lines|glob|multi_edit|gen_image|draw_image)\b", raw)
                # An honest failure report naturally MENTIONS tool names ("my
                # write_file was refused", "multi_edit needs an edits array")
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

            looks_like_tool_attempt = not tool_calls and bool(
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
            if not tool_calls and auto_apply:
                applied_note = await apply_code_block_files(root, raw, callbacks.get("onFileWritten"))
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
            # → multi_edit schema error → "I have successfully added the menu
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
                and not (mutation_failed_ever and not mutated_ok)  # writes were attempted and EVERY one failed
            )
            if claims_done and malformed_tool_calls < 4:
                malformed_tool_calls += 1
                if mutation_failed_ever and not files_touched_this_run:
                    retry_msg = (
                        "Your write/edit attempts FAILED (see the tool results above) — NO file was changed this run. "
                        "Do NOT claim success. Either fix the problem with a tool call (edit_file with a small old_string "
                        'taken from the current file, or multi_edit with {"path": ..., "edits": [{"old_string": ..., "new_string": ...}]}), '
                        "or if you genuinely cannot proceed, tell the user honestly what failed and stop."
                    )
                else:
                    retry_msg = (
                        "You said you were done but you did NOT actually call any tools. "
                        "You must use the actual tools (write_file, edit_file, git_commit, etc.) to make changes — do NOT just describe what you did. "
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
                and bool(re.search(r"\b(?:i'?ll|i will|going to|let me|next,? i|now,? i'?ll)\b", raw, re.I))
                and bool(re.search(r"\b(?:create|write|make|build|implement|add|generate)\b", raw, re.I))
                and "```" not in raw
                and len(raw) < 1500
            )
            if promised_work and malformed_tool_calls < 4:
                malformed_tool_calls += 1
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
                and bool(re.search(r"\b(?:i'?ll|i will|let me|i'?m going to|i am going to|now i'?ll)\b", raw, re.I))
                and bool(re.search(r"\b(?:read|check|test|run|play|verify|inspect|examine|review|replay|try out)\b", raw, re.I))
                and not re.search(r"\blet me know\b", raw, re.I)
                and "```" not in raw
                and len(raw) < 1200
            )
            if promised_action and malformed_tool_calls < 4:
                malformed_tool_calls += 1
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
                suffix = (("\n\n" + applied_note) if applied_note else "") + malformed_note
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
                k = f"{tc['tool']}:{json.dumps(tc['args'], sort_keys=True)}"
                if k in noop_ok_calls:
                    continue  # successful no-op — repeating it is not a failure
                if tc["tool"] == "preview_start":
                    # Never punish preview_start repeats: the tool result itself
                    # tells the model to retry once the client is connected —
                    # obeying that must not be misread as "kept failing".
                    preview_start_count += 1
                    continue
                seen_calls[k] = seen_calls.get(k, 0) + 1
                if seen_calls[k] >= 3:
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

            ask_user_call = next((tc for tc in calls_to_run if tc["tool"] == "ask_user"), None)
            if ask_user_call:
                question = ask_user_call["args"].get("question") if isinstance(ask_user_call["args"].get("question"), str) else ""
                if not question.strip():
                    history.append({"role": "assistant", "content": raw})
                    history.append({"role": "user", "content": "[ask_user] No question provided — re-read the task and continue."})
                    continue
                _cb(opts, "onStage", "agent:waiting")
                answer = await ask_user_question(question, opts)
                history.append({"role": "assistant", "content": raw})
                history.append({"role": "user", "content": f"[USER ANSWER to your question]\n{answer}"})
                continue

            def is_shell_tool(t: str) -> bool:
                # Tools that execute arbitrary code/commands need the same
                # approval gate in auto-edit mode.
                return t in ("run_command", "run_python", "play_game")

            for tc in calls_to_run:
                if tc["tool"] not in MUTATING_TOOLS:
                    continue
                if opts.get("toolPermission") == "read-only":
                    history.append({"role": "assistant", "content": raw})
                    history.append({"role": "user", "content": f"[TOOL BLOCKED — {tc['tool']}] The workspace is in read-only mode. You cannot write/delete/edit files. Describe the changes in your response instead."})
                    await session_log.log_tool_result(tc["tool"], "Blocked (read-only mode)", False)
                    continue
                needs_approval = (
                    opts.get("toolPermission") in ("ask-each", "suggest")
                    or (opts.get("toolPermission") == "auto-edit" and is_shell_tool(tc["tool"]))
                )
                if needs_approval:
                    import random

                    approval_key = f"approval-{int(time.time() * 1000)}-{''.join(random.choices('abcdefghijklmnopqrstuvwxyz0123456789', k=6))}"
                    _cb(opts, "onApprovalRequest", approval_key, tc["tool"], tc["args"])
                    _cb(opts, "onStage", "agent:waiting")
                    approved = await wait_for_approval(approval_key, signal)
                    if not approved:
                        history.append({"role": "assistant", "content": raw})
                        history.append({"role": "user", "content": f"[TOOL DENIED — {tc['tool']}] The user denied this tool call. Explain what you were trying to do and suggest an alternative approach."})
                        await session_log.log_tool_result(tc["tool"], "Denied by user", False)
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
            all_read_only = all(tc["tool"] not in MUTATING_TOOLS for tc in calls_to_run)

            if all_read_only and len(calls_to_run) > 1:
                _cb(opts, "onStage", "agent:tool-parallel")
                results: list[tuple[dict[str, Any], dict[str, Any]]] = []
                for tc in calls_to_run:
                    _cb(opts, "onToolStart", tc)
                    log_info(f"[agent] Tool call (parallel): {tc['tool']} {json.dumps(tc['args'])[:100]}")
                    await session_log.log_tool_call(tc["tool"], tc["args"])
                    r = await execute_tool(root, tc, auto_apply, extra={"use_vision_model": use_vision_model})
                    seen_outcomes[f"{tc['tool']}:{json.dumps(tc['args'], sort_keys=True)}"] = bool(r["ok"])
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
                    if tc["tool"] in ("run_command", "run_python", "play_game"):
                        if tc["tool"] == "run_command":
                            cmd = tc["args"].get("command") if isinstance(tc["args"].get("command"), str) else ""
                        elif tc["tool"] == "run_python":
                            cmd = "python " + str(tc["args"].get("path") or "(inline snippet)")
                        else:
                            cmd = "python " + str(tc["args"].get("path") or "(game)")
                        _cb(opts, "onAgentCommand", {"command": cmd, "output": result["output"], "failed": not result["ok"]})
                    if tc["tool"] in ("list_files", "read_file", "search_files", "read_rules"):
                        maybe_fire_reading()
                    if result.get("fileWrite"):
                        _cb(opts, "onFileWritten", result["fileWrite"])
            else:
                for tc in calls_to_run:
                    _cb(opts, "onToolStart", tc)
                    log_info(f"[agent] Tool call: {tc['tool']} {json.dumps(tc['args'])[:120]}")
                    await session_log.log_tool_call(tc["tool"], tc["args"])
                    result = await execute_tool(root, tc, auto_apply, extra={"use_vision_model": use_vision_model})
                    seen_outcomes[f"{tc['tool']}:{json.dumps(tc['args'], sort_keys=True)}"] = bool(result["ok"])
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
                    if tc["tool"] in MUTATING_TOOLS or tc["tool"] == "multi_edit":
                        mp = str(tc["args"].get("path") or "").replace("\\", "/").lower()
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
                    churn_capable = tc["tool"] in MUTATING_TOOLS or tc["tool"] in ("multi_edit", "run_command")
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
                        wants_recovery = tc["tool"] in ("edit_file", "multi_edit", "replace_in_file") or (
                            tc["tool"] == "write_file" and "Refusing to overwrite" in str(result["output"])
                        )
                        # Count failures PER PATH across the run (a read_file
                        # between two refused writes resets the consecutive
                        # streak, which used to hide the pattern and starve
                        # auto-recovery). Requires ≥2 failures of mutation
                        # tools on the SAME path.
                        if tc["tool"] in ("edit_file", "multi_edit", "replace_in_file", "write_file"):
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
                    if tc["tool"] in ("run_command", "run_python", "play_game"):
                        if tc["tool"] == "run_command":
                            cmd = tc["args"].get("command") if isinstance(tc["args"].get("command"), str) else ""
                        elif tc["tool"] == "run_python":
                            cmd = "python " + str(tc["args"].get("path") or "(inline snippet)")
                        else:
                            cmd = "python " + str(tc["args"].get("path") or "(game)")
                        _cb(opts, "onAgentCommand", {"command": cmd, "output": result["output"], "failed": not result["ok"]})
                    if tc["tool"] in ("list_files", "read_file", "search_files", "read_rules"):
                        maybe_fire_reading()
                    if result.get("fileWrite"):
                        _cb(opts, "onFileWritten", result["fileWrite"])
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
                if tc["tool"] in ("write_file", "edit_file", "delete_file", "multi_edit"):
                    touched = str(tc["args"].get("path") or "").replace("\\", "/").lower()
                    if touched and touched in mutated_ok:
                        files_touched_this_run.add(touched)
                if tc["tool"] in ("write_file", "edit_file", "delete_file", "multi_edit"):
                    touched_path = str(tc["args"].get("path") or "").replace("\\", "/").lower()
                    if touched_path in mutated_ok:
                        step = f"{tc['tool']}: {tc['args'].get('path') or tc['args'].get('from') or 'unknown'}"
                        if step not in completed_steps:
                            completed_steps.append(step)
                            await session_log.log_plan_update(f"Completed: {step}")

            if preview_start_count >= 3 and not preview_redirect_injected:
                # The client bridge never connected after several tries — stop
                # the model from burning rounds on preview tools and redirect
                # it to verification it CAN do. The run continues.
                preview_redirect_injected = True
                log_info("[agent] Preview bridge unavailable after 3 preview_start attempts — redirecting to non-preview verification")
                history.append({"role": "user", "content": (
                    "[SYSTEM] preview_start failed 3 times — the desktop client's preview bridge is NOT connected "
                    "(client not running, or an older client version without preview support). "
                    "Do NOT call preview_start, preview_screenshot, preview_eval, or preview_console again this run. "
                    "Continue the task WITHOUT the preview: verify your work with read_file and run_command, "
                    "and in your final answer tell the user that live preview verification was unavailable."
                )})

            last_mutating = next((tc for tc in calls_to_run if tc["tool"] in MUTATING_TOOLS), None)
            if auto_apply and last_mutating and verify:
                _cb(opts, "onStage", "agent:verify")
                log_info(f"[agent] Verifying after {last_mutating['tool']}: {verify['command']}")
                verify_out = await _run_verify(verify["command"], root, 3000)
                history.append({
                    "role": "user",
                    "content": f"[VERIFICATION RESULT — {verify['label']} ({verify['command']})]\n{verify_out}\n\nThis is a verification you requested. If it PASSED, continue with the next step or finish the task. If it FAILED, call a tool (e.g. read_file / edit_file) to fix the code, then the verification will run again automatically.",
                })
                await session_log.log_verify(verify["command"], verify_out, not verify_out.startswith("FAILED"))
                _cb(opts, "onAgentCommand", {"command": verify["command"], "output": verify_out, "failed": verify_out.startswith("FAILED")})

            # ── Automatic game replay after a Python edit ───────────────
            # Same idea as the verify command above, but for GAMES: a static
            # test suite cannot tell you whether the snake moves, so the game
            # is actually played and the result fed back. Bounded by
            # GAME_VERIFY_CAP so a fix→replay cycle cannot run away.
            game_edit = next(
                (
                    tc for tc in calls_to_run
                    if tc["tool"] in ("write_file", "edit_file", "multi_edit", "replace_in_file", "rename_file")
                    and str(tc["args"].get("path") or tc["args"].get("from") or "").lower().endswith(".py")
                ),
                None,
            )
            if auto_apply and game_target and game_edit and game_verify_count < GAME_VERIFY_CAP:
                game_verify_count += 1
                _cb(opts, "onStage", "agent:verify")
                log_info(f"[agent] Game check after {game_edit['tool']}: replaying {game_target['path']}")
                check = await run_game_check(root, game_target, use_vision_model=use_vision_model)
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
        fire_resume_state()
        raise
    finally:
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
            extra={"use_vision_model": use_vision_model, "game_auto": True},
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


async def _run_verify(command: str, root: str, cap: int) -> str:
    """Run a verify command; returns capped output with FAILED prefix on error."""
    try:
        proc = await asyncio.create_subprocess_shell(
            command,
            cwd=root,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=60)
        except asyncio.TimeoutError:
            proc.kill()
            return "FAILED (exit code ?):\nCommand timed out after 60 seconds"
        out = (stdout or b"").decode("utf-8", "replace") + (f"\n[stderr]\n{(stderr or b'').decode('utf-8', 'replace')}" if stderr else "")
        out = out.strip() or "(verify passed with no output)"
        return out[-cap:] + "\n...[output truncated]" if len(out) > cap else out
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