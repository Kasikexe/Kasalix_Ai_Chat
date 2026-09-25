"""Project rules + agent memory service — mirrors backend/src/services/project-rules.ts.

Two separate per-workspace files with a strict priority order:

  1. USER RULES  (.agent-rules.md / .agent-rules / AGENT_RULES.md)
     Authoritative instructions written BY THE USER. The agent may READ
     them but can never write, edit, delete, or override them — the user's
     rules always win, even over the agent's own notes. The agent is
     hard-blocked from touching these files at the tool level (see
     agent.py is_user_rules_path) so a model cannot silently change them.

  2. AGENT MEMORY (.agent-memory.md)
     Notes the AGENT writes to itself (lessons, build commands, framework
     conventions, gotchas) so it does not have to re-read the whole
     project every session. Lower priority than user rules — if the
     agent's memory contradicts a user rule, the user rule wins.

Both files are plain markdown injected into the agent's system prompt.
"""

from __future__ import annotations

import os
from pathlib import Path

RULES_FILENAMES = [".agent-rules.md", ".agent-rules", "AGENT_RULES.md"]
MEMORY_FILENAMES = [".agent-memory.md", ".agent-memory", "AGENT_MEMORY.md"]
# Project config files (auto-loaded if present, lower priority than user rules)
PROJECT_CONFIG_FILENAMES = ["koding.md", "AGENTS.md", ".koding.md"]
MAX_FILE_BYTES = 64 * 1024  # 64KB cap each — enough for rich rules/memory


def _find_file(workspace_root: str, names: list[str]) -> str | None:
    root = Path(workspace_root)
    for name in names:
        p = root / name
        try:
            if p.is_file():
                return str(p)
        except OSError:  # noqa: S110
            pass
    return None


async def find_project_rules_file(workspace_root: str) -> str | None:
    """Resolve the user rules file path inside a workspace, or None if none exists."""
    return _find_file(workspace_root, RULES_FILENAMES)


async def read_project_rules(workspace_root: str) -> str | None:
    """Read the user rules file content (capped), or None if there is none."""
    file_path = await find_project_rules_file(workspace_root)
    if not file_path:
        return None
    try:
        size = os.path.getsize(file_path)
        if size > MAX_FILE_BYTES:
            # Don't inject a giant file — but still let the agent know it exists AND
            # where, so it can read_file the file in ranges and split it itself.
            return (
                f"(user rules file {file_path} is {size // 1024}KB — larger than the "
                f"{MAX_FILE_BYTES // 1024}KB read limit; read it in ranges with read_file "
                "and consider splitting it)"
            )
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
        return content.strip() or None
    except OSError:
        return None


async def find_agent_memory_file(workspace_root: str) -> str | None:
    """Resolve the agent memory file path inside a workspace, or None if none exists."""
    return _find_file(workspace_root, MEMORY_FILENAMES)


async def read_agent_memory(workspace_root: str) -> str | None:
    """Read the agent memory file content (capped), or None if there is none."""
    file_path = await find_agent_memory_file(workspace_root)
    if not file_path:
        return None
    try:
        size = os.path.getsize(file_path)
        if size > MAX_FILE_BYTES:
            return (
                f"(agent memory file {file_path} is {size // 1024}KB — larger than the "
                f"{MAX_FILE_BYTES // 1024}KB read limit; read it in ranges with read_file "
                "and consider splitting it)"
            )
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()
        return content.strip() or None
    except OSError:
        return None


async def append_agent_memory(workspace_root: str, note: str) -> str:
    """Append a note to the agent memory file (creates it if missing).

    Returns the file path used. Duplicate notes are skipped.
    """
    import re

    # Collapse newlines to spaces so one note = one line (multi-line notes would
    # corrupt the markdown file and could even swallow it via HTML comments).
    clean = re.sub(r"\s*\n+\s*", " ", note.strip())
    if not clean:
        raise ValueError("Cannot append an empty note.")

    file_path = await find_agent_memory_file(workspace_root)
    if not file_path:
        file_path = str(Path(workspace_root) / MEMORY_FILENAMES[0])
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(
                "# Agent Memory\n\n"
                "Notes written by the AI agent and remembered across sessions. "
                f"Lower priority than the user's rules ({RULES_FILENAMES[0]}) — if these "
                "notes ever contradict a user rule, the user rule wins.\n\n"
            )

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            existing = f.read()
    except OSError:  # noqa: S110
        existing = ""

    # De-duplicate: skip only EXACT matches (normalized) — near-duplicates are
    # allowed to append so distinct-but-similar notes are never silently lost.
    needle = re.sub(r"\s+", " ", clean.lower())
    found = False
    for line in existing.lower().split("\n"):
        l = re.sub(r"\s+", " ", line.strip())
        bare = l[1:].strip() if l.startswith("-") else l
        if bare and (bare == needle or l == f"- {needle}"):
            found = True
            break
    if found:
        return file_path

    line = clean if clean.startswith("-") else f"- {clean}"
    with open(file_path, "a", encoding="utf-8") as f:
        f.write(f"{line}\n")
    return file_path


async def read_project_config(workspace_root: str) -> str | None:
    """Read project config files (koding.md, AGENTS.md, .koding.md).

    These provide project-specific instructions, lower priority than user rules.
    Returns combined content of all found config files, or None if none exist.
    """
    parts: list[str] = []
    root = Path(workspace_root)
    for name in PROJECT_CONFIG_FILENAMES:
        p = root / name
        try:
            if not p.is_file():
                continue
            size = os.path.getsize(p)
            if size > MAX_FILE_BYTES:
                parts.append(
                    f"({name} is {size // 1024}KB — too large to auto-load; use read_file to read it)"
                )
                continue
            content = p.read_text(encoding="utf-8")
            if content.strip():
                parts.append(f"[PROJECT CONFIG — {name}]\n{content.strip()}")
        except OSError:  # noqa: S110
            pass
    return "\n\n".join(parts) if parts else None