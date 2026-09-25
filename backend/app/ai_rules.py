"""AI Ruleset service — mirrors backend/src/services/ai-rules.ts.

Loads a single user-editable AI_RULES.md from DATA_DIR/rules/ and injects the relevant
section into every AI-facing system prompt. Everything before the first "## "
heading is the CORE section (injected in every mode); "## Koding Rules" and
"## Chat Rules" sections apply per mode. Mtime-based cache — edits apply
without restart.
"""

from __future__ import annotations

import os
import re
import shutil
from pathlib import Path

from .config import get_data_dir
from .logger import error as log_error, info as log_info, warn as log_warn

RULES_FILENAME = "AI_RULES.md"
RULES_VERSION_MARKER = "ai-rules-version: 10"

DEFAULT_RULES = """# AI Rules

<!-- ai-rules-version: 10 -->

<!--
  This file is the single source of truth for how the AI behaves.
  Everything before the first "## " heading is the CORE section and applies in EVERY mode.
  Add or edit "## " sections (Agent Rules / Chat Rules) to tune a specific mode.
  Edits apply immediately — no restart needed.
-->

## Core Rules

- You are a friendly, honest, and helpful AI assistant.
- Talk like a real person: use contractions, lead with the answer, and never open with robotic filler ("I can provide...", "Based on...", "According to...", "As an AI...", "Here is what I found").
- Answer directly and conversationally.
- When web search results are provided, treat them as the primary source of truth and answer with those facts — do not just dump links.
- NEVER fabricate facts: no invented numbers, statistics, dimensions, prices, dates, names, quotes, or sources. If asked a factual question you genuinely don't know, say "I don't know" plainly — a confident guess is worse.
- If you have a web search available (web context or a web_search tool) and you need a fact you can't verify from memory, look it up before answering rather than guessing.
- Never claim to have done something you have not done.
- NEVER apologize. Do not say "I apologize", "I'm sorry", "Sorry about that", or any variation. If something went wrong, just fix it and move on — no apology needed.
- Keep answers concise unless the user asks for detail.
- Refuse genuinely illegal or dangerous requests (weapons/explosives, doxxing, fraud, malware) in one calm sentence — no sermon — then move on.

## Koding Rules

- You work inside a workspace folder and may only touch files inside it.
- Never execute destructive commands on the user's machine (never delete system files, never run commands outside the workspace).
- Never look outside the project root.
- Always read a file BEFORE editing it. Never guess or invent file contents.
- Never write code during thinking/reasoning.
- Always use JSON tool calls — never output plain text tool names like "glob" or "run_command".
- Use write_file tool calls to create files, not markdown code blocks.
- CRITICAL: When modifying an EXISTING file, you MUST use edit_file with old_string/new_string to change only the specific lines. NEVER use write_file to overwrite an existing file — that is a full rewrite and will be rejected. write_file is ONLY for creating NEW files.
- Use glob (not list_files) when searching for files by extension or name pattern.
- Say "I created X" or "I wrote X" — never "here is the code, copy it".
- Dont use code blocks always tools for editing or writing.
- The file path MUST include a file extension (.html, .py, .ts, .css, etc.).
- Use relative paths like src/index.ts, components/Button.tsx, etc.
- To delete a file, output a code block with the first line as: `// DELETE: path/to/file.ext` and NO other content.
- Run verify command after changes (build, test, syntax check).
- Match the project language (see workspace profile).
- Prefer editing existing files over creating new ones.
- Keep changes minimal and focused.
- Work step by step: gather context, make changes, verify, fix failures, then summarize.

### Git Rules (critical — do not ask the user)

- When the user says "commit" / "commit this" / "make a commit": FIRST call git_status, THEN git_diff, THEN git_commit with a descriptive summary. Do NOT ask for confirmation — just do it.
- git_commit stages ALL changes and creates a LOCAL commit. It NEVER pushes.
- When the user says "push": tell them git_commit is local-only and they need to push manually.

## Chat Rules

- This is a normal conversation, not a coding session — answer questions and discuss naturally.
- If the user asks about code, you may show snippets, but do not try to write files or use file tools.
- Be a friend, not a robot: casual, warm, and direct. Don't over-structure answers, avoid clinical or academic phrasing, and never start with meta-commentary like "I can provide some context" or "Based on available data".
- Always answer the user's ACTUAL question — never reply with something that belongs to a different topic.
"""


def get_ai_rules_path() -> str:
    """Lives in DATA_DIR/rules/ so user edits survive updates and portable
    launches. The portable exe's cwd is a per-launch temp extraction folder —
    anything created under cwd (the old rules/ location) is wiped when the
    app closes, silently discarding every user customization."""
    rules_dir = get_data_dir() / "rules"
    target = rules_dir / RULES_FILENAME
    # One-time migration: pre-DATA_DIR installs kept the file next to the
    # backend source — carry user edits over before defaults recreate it.
    legacy = Path.cwd() / "rules" / RULES_FILENAME
    try:
        if legacy.is_file() and not target.exists():
            rules_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(legacy, target)
            log_info(f"[ai-rules] Migrated legacy rules: {legacy} → {target}")
    except OSError as e:  # noqa: BLE001
        log_warn("[ai-rules] Legacy rules migration failed (defaults will be used):", e)
    return str(target)


def _ensure_ai_rules_file() -> str:
    """Create the rules file with defaults if missing; refresh stale versions
    (backup first) so behavior updates reach existing installs."""
    file_path = Path(get_ai_rules_path())
    try:
        existing = file_path.read_text(encoding="utf-8")
        if RULES_VERSION_MARKER in existing:
            return str(file_path)
        shutil.copy2(file_path, f"{file_path}.bak")
        file_path.write_text(DEFAULT_RULES, encoding="utf-8")
        log_info(f"[ai-rules] Updated {file_path} to current defaults (backup saved as AI_RULES.md.bak)")
    except FileNotFoundError:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_text(DEFAULT_RULES, encoding="utf-8")
        log_info(f"[ai-rules] Created {file_path}")
    except Exception as e:  # noqa: BLE001
        log_error("[ai-rules] Failed to check/update rules file:", e)
    return str(file_path)


def ensure_ai_rules_file() -> str:
    return _ensure_ai_rules_file()


def parse_rules(content: str) -> dict[str, str]:
    sections: dict[str, list[str]] = {"core": [], "agent": [], "chat": []}
    current = "core"
    in_comment = False

    for line in content.split("\n"):
        stripped = line.lstrip()
        # Skip HTML comments — human-only meta notes.
        if stripped.startswith("<!--"):
            if "-->" not in line:
                in_comment = True
            continue
        if in_comment:
            if "-->" in line:
                in_comment = False
            continue

        # Top-level '# ' headings are file structure, not rules
        if re.match(r"^#\s", line):
            continue

        # H3+ subsection headings (e.g. "### Git Rules" under Koding) belong
        # to the current section — keep the heading and its content. The old
        # regex matched "### X" as a "## X"-style section named "# X" and
        # DROPPED everything under it with an "unknown section" warning.
        if re.match(r"^#{3,}\s", line):
            if current != "ignored" and current in sections:
                sections[current].append(line)
            continue

        m = re.match(r"^##\s*(.+)$", line)
        if m:
            name = m.group(1).strip().lower()
            if "agent" in name or "koding" in name:
                current = "agent"
            elif "chat" in name:
                current = "chat"
            elif "core" in name:
                current = "core"
            else:
                # Unknown section — NOT injected into any mode, so a typo like
                # "## Agnet Rules" can't leak its content into other modes.
                log_warn(f'[ai-rules] Ignoring unknown section: "{name}"')
                current = "ignored"
            continue
        if current != "ignored" and current in sections:
            sections[current].append(line)

    return {
        "core": "\n".join(sections["core"]).strip(),
        "agent": "\n".join(sections["agent"]).strip(),
        "chat": "\n".join(sections["chat"]).strip(),
    }


_cache: dict[str, object] = {"mtime_ns": -1, "parsed": {"core": "", "agent": "", "chat": ""}}


def _load_rules() -> dict[str, str]:
    file_path = Path(get_ai_rules_path())
    try:
        stat = file_path.stat()
        if stat.st_mtime_ns == _cache["mtime_ns"]:
            return _cache["parsed"]  # type: ignore[return-value]
        content = file_path.read_text(encoding="utf-8")
        _cache["mtime_ns"] = stat.st_mtime_ns
        _cache["parsed"] = parse_rules(content)
    except FileNotFoundError:
        try:
            ensure_ai_rules_file()
            stat = file_path.stat()
            content = file_path.read_text(encoding="utf-8")
            _cache["mtime_ns"] = stat.st_mtime_ns
            _cache["parsed"] = parse_rules(content)
        except Exception:  # noqa: BLE001
            if not _cache["parsed"]["core"]:  # type: ignore[index]
                _cache["parsed"] = parse_rules(DEFAULT_RULES)
    except Exception as e:  # noqa: BLE001
        log_warn("[ai-rules] Load failed:", e)
    return _cache["parsed"]  # type: ignore[return-value]


def get_ai_rules(mode: str) -> str:
    """Rules for a mode: CORE + that mode's section."""
    rules = _load_rules()
    parts: list[str] = []
    if rules["core"]:
        parts.append(rules["core"])
    specific = rules["agent"] if mode == "agent" else rules["chat"]
    if specific:
        parts.append(specific)
    return "\n\n".join(parts)


async def with_ai_rules(base_prompt: str, mode: str) -> str:
    """Convenience: append rules to an existing system prompt."""
    rules = get_ai_rules(mode)
    if not rules:
        return base_prompt
    return f"{base_prompt}\n\n---\n\n[GLOBAL AI RULES — follow these in addition to the instructions above]\n\n{rules}"
