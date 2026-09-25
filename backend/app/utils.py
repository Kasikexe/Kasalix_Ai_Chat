"""Shared utils — mirrors backend/src/utils/{edits,protected-dirs,containment}.ts.

- Myers line diff (O(ND)) for measuring real changes
- Search/replace edit engine shared by the agent edit_file tool and /api/files/edit
- Line-range (edit_lines) and anchor-based (edit_section) edit engines — they let a model
  change part of a file WITHOUT reproducing the old text byte-for-byte
- Protected server-internal directories
- Realpath-based workspace containment (symlink-safe)
"""

from __future__ import annotations

import difflib
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


# ─── Line-range and anchor-based edit engine ───────────────
# Why these exist: apply_search_replace makes the model reproduce the OLD text
# byte-exactly (or whitespace-equivalently). For a small local model that is the
# hard half of editing — copying 200 lines perfectly is harder than generating
# 200 plausible new ones — so it dodges the wall by rewriting the whole file.
# Line-range edits (numbers straight out of read_file) and anchored edits
# (replace everything between two anchors) remove the exactness requirement, so
# a surgical change costs the model no more than a rewrite.

# A region edit may not silently remove most of a file: past these bounds the
# model is rewriting, and should use write_file with force (or show the user).
_REGION_MIN_ABSOLUTE = 25
_REGION_FRACTION = 0.8


def _split_edit_lines(content: str) -> tuple[list[str], bool]:
    """Split content for editing. Returns (lines, had_trailing_newline)."""
    text = content.replace("\r\n", "\n")
    trailing = text.endswith("\n")
    lines = text.split("\n")
    if trailing and len(lines) > 1:
        lines = lines[:-1]
    return lines, trailing


def _join_edit_lines(lines: list[str], trailing: bool) -> str:
    if not lines:
        return ""
    return "\n".join(lines) + ("\n" if trailing else "")


def _replacement_lines(replacement: str) -> list[str]:
    """Turn replacement text into whole lines (one trailing newline ignored,
    "" for a blank line, empty string for nothing)."""
    text = replacement.replace("\r\n", "\n")
    if text.endswith("\n"):
        text = text[:-1]
    return text.split("\n") if text != "" else []


def _int_arg(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str) and re.fullmatch(r"\s*-?\d+\s*", value):
        return int(value.strip())
    return None


def _region_too_large(total: int, region_len: int) -> bool:
    return region_len > _REGION_MIN_ABSOLUTE and region_len > int(total * _REGION_FRACTION)


def _closest_line_hint(lines: list[str], needle: str) -> str:
    """A constructive hint: the real line that most resembles the one the model
    was looking for. Turns "anchor not found" into something it can act on."""
    norm_needle = _normalize_line(needle)
    if not norm_needle:
        return ""
    best_ratio = 0.0
    best_idx = -1
    for i, line in enumerate(lines):
        norm = _normalize_line(line)
        if not norm:
            continue
        ratio = difflib.SequenceMatcher(None, norm_needle, norm).ratio()
        if ratio > best_ratio:
            best_ratio, best_idx = ratio, i
    if best_idx < 0 or best_ratio < 0.6:
        return ""
    return f"\nClosest line in the file (line {best_idx + 1}): {lines[best_idx].strip()}"


def _anchor_blocks(anchor: str) -> list[str]:
    """The anchor as non-empty lines, trailing/leading blanks dropped (models
    routinely tack on a newline when copying a snippet)."""
    lines = [re.sub(r"\r$", "", l) for l in anchor.replace("\r\n", "\n").split("\n")]
    while lines and not lines[-1].strip():
        lines.pop()
    while lines and not lines[0].strip():
        lines.pop(0)
    return lines


def _find_anchor_matches(lines: list[str], anchor_lines: list[str]) -> list[int]:
    """Start indices where anchor_lines matches lines, ignoring runs of whitespace."""
    if not anchor_lines:
        return []
    norm = [_normalize_line(l) for l in anchor_lines]
    out: list[int] = []
    for i in range(len(lines) - len(anchor_lines) + 1):
        if all(_normalize_line(lines[i + j]) == norm[j] for j in range(len(anchor_lines))):
            out.append(i)
    return out


def apply_line_range(
    content: str,
    start: Any,
    end: Any = None,
    replacement: str = "",
    expect: str | None = None,
) -> dict[str, Any]:
    """Replace lines start..end (1-based, inclusive; negative counts from the
    end) with `replacement`, without reproducing the old text.

    - end omitted       → replace only line `start`
    - end < start       → insert before line `start` (nothing removed)
    - replacement ""    → delete those lines
    - expect            → a snippet of the FIRST line being replaced; if it does
                          not match, the edit is refused (catches stale numbers
                          after an earlier edit shifted the file)

    Returns {ok, newContent?, error?, replaced?, added?, total?}.
    """
    s_raw = _int_arg(start)
    if s_raw is None:
        return {"ok": False, "error": (
            '"start" must be a whole line number, 1-based (e.g. 42), negative to count '
            "from the end (-1 = last line)."
        )}
    if s_raw == 0:
        return {"ok": False, "error": "Line numbers are 1-based — line 1 is the first line, not 0."}
    e_raw: int | None = None
    if end is not None and not (isinstance(end, str) and not end.strip()):
        e_raw = _int_arg(end)
        if e_raw is None:
            return {"ok": False, "error": '"end" must be a whole line number, or omitted to change just one line.'}
        if e_raw == 0:
            return {"ok": False, "error": "Line numbers are 1-based — line 1 is the first line, not 0."}

    lines, trailing = _split_edit_lines(content)
    total = len(lines)

    s = s_raw if s_raw > 0 else total + s_raw + 1
    if s < 1:
        return {"ok": False, "error": f"start={s_raw} is before the start of the file (which has {total} line(s))."}
    if s > total + 1:
        return {"ok": False, "error": (
            f"start={s_raw} is past the end of the file, which has {total} line(s). "
            'Re-read it with read_file {"path": ..., "numbers": true} and use a line that exists.'
        )}

    e = s if e_raw is None else (e_raw if e_raw > 0 else total + e_raw + 1)
    if e_raw is not None and e < 1:
        return {"ok": False, "error": f"end={e_raw} is before the start of the file (which has {total} line(s))."}
    if e_raw is not None and e > total:
        return {"ok": False, "error": (
            f"end={e_raw} is past the end of the file, which has {total} line(s). "
            'Re-read it with read_file {"path": ..., "numbers": true} and use a line that exists.'
        )}

    start_idx = s - 1
    end_idx = e if e < s else e  # e < s → empty slice → insertion before `start`
    old_region = lines[start_idx:end_idx]

    if expect is not None and str(expect).strip() and old_region:
        want = _normalize_line(str(expect).strip().split("\n")[0])
        got = _normalize_line(old_region[0])
        if want != got:
            shown = "\n".join(f"{start_idx + 1 + i}| {l}" for i, l in enumerate(old_region[:4]))
            return {"ok": False, "error": (
                f"Line {s} is not the line you expected, so the edit was refused (nothing was written). "
                f"You expected it to be:\n  {str(expect).strip().splitlines()[0]}\n"
                f"Line {s} actually reads:\n  {old_region[0]}\n"
                f"Current lines {start_idx + 1}-{start_idx + len(old_region[:4])} of the file:\n{shown}\n"
                'The file changed since you read it — re-read it (read_file with "numbers": true) and retry.'
            )}

    if _region_too_large(total, len(old_region)):
        return {"ok": False, "error": (
            f"Refusing this edit of a {total}-line file: it removes {len(old_region)} lines — that is a "
            "rewrite, not a targeted change. Narrow start/end to just the lines you are changing. If the "
            "USER really asked to rewrite the whole file, use write_file with \"force\": true, or describe "
            "the new version in your final message."
        )}

    repl = _replacement_lines(replacement)
    new_lines = lines[:start_idx] + repl + lines[end_idx:]
    return {
        "ok": True,
        "newContent": _join_edit_lines(new_lines, trailing),
        "replaced": len(old_region),
        "added": len(repl),
        "total": total,
    }


def apply_section_replace(
    content: str,
    start_anchor: str | None,
    end_anchor: str | None,
    replacement: str = "",
) -> dict[str, Any]:
    """Replace everything BETWEEN two anchors. The anchor lines themselves are
    KEPT verbatim and everything outside them is untouched — so the model never
    reproduces the text it is replacing.

    - start_anchor omitted → region starts at line 1
    - end_anchor omitted   → region ends at the last line
    - both anchors are matched on whole lines, ignoring whitespace runs
    """
    start_anchor = start_anchor if isinstance(start_anchor, str) else ""
    end_anchor = end_anchor if isinstance(end_anchor, str) else ""
    if not start_anchor.strip() and not end_anchor.strip():
        return {"ok": False, "error": (
            'edit_section needs at least one of "start_anchor" / "end_anchor" — lines copied from the file '
            "between which the old text sits."
        )}

    lines, trailing = _split_edit_lines(content)
    total = len(lines)

    begin = 0
    end = total

    if start_anchor.strip():
        s_lines = _anchor_blocks(start_anchor)
        matches = _find_anchor_matches(lines, s_lines)
        if not matches:
            return {"ok": False, "error": (
                f"Could not find the start anchor as whole line(s) of the file: {s_lines[0].strip() if s_lines else start_anchor!r}"
                + _closest_line_hint(lines, s_lines[0] if s_lines else start_anchor)
                + "\nCopy the anchor text EXACTLY from the file (read_file first)."
            )}
        if len(matches) > 1:
            shown = ", ".join(str(m + 1) for m in matches[:8])
            return {"ok": False, "error": (
                f"The start anchor matches {len(matches)} places (lines {shown}) — add a couple of "
                "surrounding lines to make it unique."
            )}
        begin = matches[0] + len(s_lines)

    if end_anchor.strip():
        e_lines = _anchor_blocks(end_anchor)
        matches = _find_anchor_matches(lines, e_lines)
        if not matches:
            return {"ok": False, "error": (
                f"Could not find the end anchor as whole line(s) of the file: {e_lines[0].strip() if e_lines else end_anchor!r}"
                + _closest_line_hint(lines, e_lines[0] if e_lines else end_anchor)
                + "\nCopy the anchor text EXACTLY from the file (read_file first)."
            )}
        after = [m for m in matches if m >= begin]
        if len(after) > 1:
            shown = ", ".join(str(m + 1) for m in after[:8])
            return {"ok": False, "error": (
                f"The end anchor matches {len(after)} places after the start anchor (lines {shown}) — add a "
                "couple of surrounding lines to make it unique."
            )}
        if not after:
            return {"ok": False, "error": (
                "The end anchor is not BELOW the start anchor in the file — swap them, or pick anchors in the "
                "order they appear."
            )}
        end = after[0]

    old_region = lines[begin:end]
    if _region_too_large(total, len(old_region)):
        return {"ok": False, "error": (
            f"Refusing this edit of a {total}-line file: the region between those anchors is "
            f"{len(old_region)} lines — that is a rewrite, not a targeted change. Pick anchors closer together. "
            "If the USER really asked to rewrite the whole file, use write_file with \"force\": true, or "
            "describe the new version in your final message."
        )}

    if old_region:
        first_new = _replacement_lines(replacement)
        first_new = next((l for l in first_new if l.strip()), "")
        if start_anchor.strip() and first_new:
            anchor_first = _anchor_blocks(start_anchor)[0]
            if _normalize_line(first_new) == _normalize_line(anchor_first):
                return {"ok": False, "error": (
                    f"Your content starts with {first_new.strip()!r}, which is the start anchor — that line is "
                    "KEPT as-is, so repeat it would duplicate it in the file. Remove that line from content "
                    "(the region is everything BETWEEN the anchors)."
                )}

    repl = _replacement_lines(replacement)
    new_lines = lines[:begin] + repl + lines[end:]
    return {
        "ok": True,
        "newContent": _join_edit_lines(new_lines, trailing),
        "replaced": len(old_region),
        "added": len(repl),
        "total": total,
    }
