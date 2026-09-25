"""Shared utils — mirrors backend/src/utils/{edits,protected-dirs,containment}.ts.

- Myers line diff (O(ND)) for measuring real changes
- Search/replace edit engine shared by the agent edit_file tool and /api/files/edit
- Protected server-internal directories
- Realpath-based workspace containment (symlink-safe)
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

# ─── Protected server-internal directories ────────────────
PROTECTED_DIRS = [
    s.strip()
    for s in (
        os.environ.get("AGENT_PROTECTED_DIRS") or "backend,.freebuff,certs,server-gui,release,node_modules"
    ).split(",")
    if s.strip()
]


def _norm_path(p: str) -> str:
    return os.path.abspath(p).lower().replace("\\", "/")


def is_protected_path(ws_root: str, candidate: str) -> bool:
    root = _norm_path(ws_root)
    target = _norm_path(candidate)
    if target == root:
        return False
    for d in PROTECTED_DIRS:
        protected = f"{root}/{d.lower()}"
        if target == protected or target.startswith(protected + "/"):
            return True
    return False


def protected_dirs_label() -> str:
    return ", ".join(d for d in PROTECTED_DIRS if d != "node_modules")


def is_protected_dir_name(name: str) -> bool:
    lower = name.lower()
    return any(d.lower() == lower for d in PROTECTED_DIRS)


# ─── Workspace containment (realpath-based, symlink-safe) ──
def resolve_for_containment(p: str) -> str:
    """Realpath the nearest EXISTING ancestor of p, then re-append the tail."""
    missing: list[str] = []
    current = os.path.abspath(p)
    while True:
        try:
            real = os.path.realpath(current)
            if missing:
                return os.path.join(real, *missing)
            return real
        except OSError:
            parent = os.path.dirname(current)
            if parent == current:
                return os.path.abspath(p)
            missing.insert(0, os.path.basename(current))
            current = parent


async def is_path_inside(root: str, target: str) -> bool:
    # Mirrors the TS isPathInside contract (async). The check itself is
    # synchronous filesystem work — the async signature keeps await sites valid.
    try:
        real_root = resolve_for_containment(root)
        real_target = resolve_for_containment(target)
        rel = os.path.relpath(real_target, real_root)
        return rel == "" or (not rel.startswith("..") and not os.path.isabs(rel))
    except Exception:  # noqa: BLE001
        return False


# ─── Myers line diff ──────────────────────────────────────
def diff_lines(a: list[str], b: list[str], max_d: int = 400) -> list[dict[str, int]] | None:
    """Myers line diff. Returns hunks (minimal edit a→b) or None when the edit
    distance exceeds max_d (texts too different — full rewrite)."""
    n, m = len(a), len(b)
    max_len = n + m
    offset = max_len
    v = [0] * (2 * max_len + 1)
    trace: list[list[int]] = []
    found_d = -1

    for d in range(max_d + 1):
        trace.append(v[:])
        for k in range(-d, d + 1, 2):
            if k == -d or (k != d and v[offset + k - 1] < v[offset + k + 1]):
                x = v[offset + k + 1]
            else:
                x = v[offset + k - 1] + 1
            y = x - k
            while x < n and y < m and a[x] == b[y]:
                x += 1
                y += 1
            v[offset + k] = x
            if x >= n and y >= m:
                found_d = d
                break
        if found_d != -1:
            break

    if found_d == -1:
        return None

    hunks: list[dict[str, int]] = []
    x, y = n, m
    for d in range(found_d, 0, -1):
        vp = trace[d]
        k = x - y
        if k == -d or (k != d and vp[offset + k - 1] < vp[offset + k + 1]):
            prev_k = k + 1
        else:
            prev_k = k - 1
        prev_x = vp[offset + prev_k]
        prev_y = prev_x - prev_k
        while x > prev_x and y > prev_y:
            x -= 1
            y -= 1
        if x == prev_x:
            hunks.insert(0, {"oldStart": prev_x, "oldCount": 0, "newStart": prev_y, "newCount": y - prev_y})
            y = prev_y
        else:
            hunks.insert(0, {"oldStart": prev_x, "oldCount": x - prev_x, "newStart": prev_y, "newCount": 0})
            x = prev_x

    # Merge adjacent hunks into single replace blocks
    merged: list[dict[str, int]] = []
    for h in hunks:
        last = merged[-1] if merged else None
        if last and last["oldStart"] + last["oldCount"] == h["oldStart"] and last["newStart"] + last["newCount"] == h["newStart"]:
            last["oldCount"] += h["oldCount"]
            last["newCount"] += h["newCount"]
        else:
            merged.append(dict(h))
    return merged


def changed_line_count(a: str, b: str) -> dict[str, Any]:
    a_lines = a.split("\n")
    b_lines = b.split("\n")
    hunks = diff_lines(a_lines, b_lines)
    if hunks is None:
        return {"count": float("inf"), "total": max(len(a_lines), len(b_lines)), "hunks": None}
    return {
        "count": sum(h["oldCount"] + h["newCount"] for h in hunks),
        "total": max(len(a_lines), len(b_lines)),
        "hunks": hunks,
    }


# ─── Search/replace edit engine ───────────────────────────
def _normalize_line(line: str) -> str:
    return re.sub(r"\s+", " ", line).strip()


def _count_occurrences(haystack: str, needle: str) -> int:
    if not needle:
        return 0
    return haystack.count(needle)


def apply_search_replace(content: str, old_string: str, new_string: str) -> dict[str, Any]:
    """Apply a search/replace edit. old_string must be unique (or
    whitespace-equivalent-unique). Returns {ok, newContent?, error?, matches?}."""
    if not old_string:
        return {"ok": False, "error": "oldString must not be empty.", "matches": 0}

    # 1. Exact match
    exact = _count_occurrences(content, old_string)
    if exact == 1:
        if new_string == "":
            idx = content.index(old_string)
            before = content[:idx]
            after = content[idx + len(old_string):]
            line_start = before.rfind("\n") + 1
            ends_at_line_end = after == "" or after.startswith("\n")
            is_own_line = before[line_start:].strip() == "" and ends_at_line_end
            if is_own_line:
                remove_end = idx + len(old_string) + 1 if after.startswith("\n") else idx + len(old_string)
                return {"ok": True, "newContent": before[:line_start] + after[remove_end - idx - len(old_string):], "matches": 1}
        return {"ok": True, "newContent": content.replace(old_string, new_string, 1), "matches": 1}
    if exact > 1:
        return {
            "ok": False,
            "matches": exact,
            "error": f"Found {exact} identical occurrences of the search text — include more surrounding context to make it unique.",
        }

    # 2. Whitespace-tolerant line-based match
    content_lines = [re.sub(r"\r$", "", l) for l in content.split("\n")]
    old_lines = [re.sub(r"\r$", "", l) for l in old_string.split("\n")]
    norm_old = [_normalize_line(l) for l in old_lines]

    for i in range(len(content_lines) - len(old_lines) + 1):
        if all(_normalize_line(content_lines[i + j]) == norm_old[j] for j in range(len(old_lines))):
            # Ambiguity check
            alt_match = False
            for k in range(i + 1, len(content_lines) - len(old_lines) + 1):
                if all(_normalize_line(content_lines[k + j]) == norm_old[j] for j in range(len(old_lines))):
                    alt_match = True
                    break
            if alt_match:
                return {
                    "ok": False,
                    "matches": 2,
                    "error": "Found multiple occurrences (differing only in whitespace) — include more surrounding context to make it unique.",
                }
            replacement = [] if new_string == "" else new_string.split("\n")
            new_content = "\n".join(content_lines[:i] + replacement + content_lines[i + len(old_lines):])
            return {"ok": True, "newContent": new_content, "matches": 1}

    # 3. Not found
    return {
        "ok": False,
        "matches": 0,
        "error": (
            "Could not find the search text in the file. The file may have changed — read the current "
            "file content and retry with the exact text. Tip: include a couple of surrounding lines for uniqueness."
        ),
    }
