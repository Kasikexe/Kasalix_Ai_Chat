"""Changelog service — mirrors backend/src/services/changelog.ts."""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..config import get_data_dir

DATA_DIR = Path(get_data_dir()) / "changelog"
FILE_PATH = DATA_DIR / "changelog.json"
DRAFT_PATH = DATA_DIR / "draft.json"


def _ensure_dir() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def _get_all() -> list[dict[str, Any]]:
    try:
        return json.loads(FILE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []


def _save_all(entries: list[dict[str, Any]]) -> None:
    _ensure_dir()
    FILE_PATH.write_text(json.dumps(entries, indent=2), encoding="utf-8")


def _compare_versions(a: str, b: str) -> int:
    a_parts = [int(x) if x.isdigit() else 0 for x in a.split(".")]
    b_parts = [int(x) if x.isdigit() else 0 for x in b.split(".")]
    for i in range(max(len(a_parts), len(b_parts))):
        a_num = a_parts[i] if i < len(a_parts) else 0
        b_num = b_parts[i] if i < len(b_parts) else 0
        if a_num != b_num:
            return a_num - b_num
    return 0


async def get_changelog() -> list[dict[str, Any]]:
    entries = _get_all()
    entries.sort(key=lambda e: _compare_versions(e.get("version", ""), e.get("version", "")), reverse=True)
    # stable sort by version descending
    entries.sort(key=lambda e: _compare_versions(e.get("version", ""), "0"), reverse=True)
    # simplest correct: sort by parsed version tuples
    entries.sort(key=lambda e: _version_key(e.get("version", "")), reverse=True)
    return entries


def _version_key(v: str) -> tuple[int, ...]:
    parts = []
    for x in v.split("."):
        num = ""
        for ch in x:
            if ch.isdigit():
                num += ch
            else:
                break
        parts.append(int(num) if num else 0)
    return tuple(parts)


async def add_changelog_entry(entry: dict[str, Any]) -> dict[str, Any]:
    entries = _get_all()
    new_entry = {
        **entry,
        "date": entry.get("date") or datetime.now(timezone.utc).isoformat().split("T")[0],
    }
    filtered = [e for e in entries if e.get("version") != entry.get("version")]
    filtered.append(new_entry)
    _save_all(filtered)
    return new_entry


async def delete_changelog_entry(version: str) -> bool:
    entries = _get_all()
    filtered = [e for e in entries if e.get("version") != version]
    if len(filtered) == len(entries):
        return False
    _save_all(filtered)
    return True


DEFAULT_DRAFT: dict[str, Any] = {"description": "", "autoSavedAt": 0}


def _get_draft_raw() -> dict[str, Any]:
    try:
        data = json.loads(DRAFT_PATH.read_text(encoding="utf-8"))
        return {**DEFAULT_DRAFT, **data}
    except (OSError, json.JSONDecodeError):
        return {**DEFAULT_DRAFT}


def _save_draft_raw(draft: dict[str, Any]) -> None:
    _ensure_dir()
    DRAFT_PATH.write_text(json.dumps(draft, indent=2), encoding="utf-8")


async def get_draft() -> dict[str, Any]:
    return _get_draft_raw()


async def update_draft(description: str) -> dict[str, Any]:
    draft = {"description": description, "autoSavedAt": int(time.time() * 1000)}
    _save_draft_raw(draft)
    return draft


async def publish_draft(version: str, title: str, entry_type: str) -> dict[str, Any]:
    draft = _get_draft_raw()
    entry = await add_changelog_entry(
        {
            "version": version,
            "title": title,
            "description": draft.get("description") or "(no changes listed)",
            "type": entry_type,
        }
    )
    _save_draft_raw({**DEFAULT_DRAFT})
    return entry