"""ALC project knowledge — the notes a cycle keeps for future cycles.

Layout inside the workspace (Koding only — chat has no project directory):

    <project>/ALC/knowledge/index.json      machine index: topics, tags, sources, sizes
    <project>/ALC/knowledge/<slug>.md       human-readable notes, one file per topic

The markdown files are the payload and stay hand-editable; the index is what
retrieval and dedupe use, so writing the same fact twice is a no-op instead of a
duplicate. This is a plain file store — nothing here touches model weights
(docs/ALC_DESIGN.md D8/D9).

Every entry keeps its provenance (the documentation path or page URL it came
from) and the date it was learned, because a note without a source cannot be
re-checked when it turns out to be wrong.

All entry points are SYNCHRONOUS; the controller calls them through
``asyncio.to_thread``.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..logger import error as log_error, info as log_info

KNOWLEDGE_DIR_NAME = "ALC"
KNOWLEDGE_SUBDIR = "knowledge"
INDEX_FILENAME = "index.json"
INDEX_VERSION = 1

MAX_BODY_CHARS = 4000
MAX_TOPIC_BYTES = 64 * 1024          # cap a single topic file's read for search
MAX_ENTRIES = 500
MAX_SEARCH_FILES = 60
SEARCH_SNIPPET_CHARS = 900
MAX_TOPIC_LIST = 20


def knowledge_dir(workspace: str | None) -> Path | None:
    """``<workspace>/ALC/knowledge`` — or None when there is no project directory."""
    if not workspace:
        return None
    try:
        return Path(workspace).expanduser() / KNOWLEDGE_DIR_NAME / KNOWLEDGE_SUBDIR
    except (OSError, ValueError, TypeError):
        return None


def slugify(topic: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", str(topic or "").strip().lower()).strip("-")
    return (slug or "notes")[:60]


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:32]


def _now() -> float:
    return datetime.now(timezone.utc).timestamp()


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _words(text: str) -> set[str]:
    return {word for word in re.findall(r"[a-z0-9]{4,}", str(text or "").lower())}


def _is_covered(existing: str, new_text: str, threshold: float = 0.85) -> bool:
    """Whether the store already says (almost) the same thing.

    An exact content hash is not enough: the same fact comes back as a search
    snippet with a heading, a date and its source line around it, so a hash never
    matches and the note would be appended again on every cycle that rediscovers
    it. Measuring against the SMALLER vocabulary means "everything this note says
    is already in the store", which is the question being asked; dividing by the
    new text's own length would reject a snippet just for carrying extra prose.

    The trade-off: as a topic file grows, its vocabulary grows with it, so a later
    note phrased entirely in words the topic file already uses is treated as
    redundant. For a store of short durable facts that is the safer error.
    """
    new_words = _words(new_text)
    existing_words = _words(existing)
    if not new_words or not existing_words:
        return False
    shared = len(new_words & existing_words) / min(len(new_words), len(existing_words))
    return shared >= threshold


# ─── Index ──────────────────────────────────────────────────────────────
def read_index(workspace: str | None) -> list[dict[str, Any]]:
    directory = knowledge_dir(workspace)
    if directory is None:
        return []
    try:
        data = json.loads((directory / INDEX_FILENAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    entries = data.get("entries") if isinstance(data, dict) else data
    if not isinstance(entries, list):
        return []
    return [entry for entry in entries if isinstance(entry, dict)]


def _write_index(directory: Path, entries: list[dict[str, Any]]) -> None:
    try:
        directory.mkdir(parents=True, exist_ok=True)
        payload = {"version": INDEX_VERSION, "entries": entries[:MAX_ENTRIES]}
        (directory / INDEX_FILENAME).write_text(
            json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
        )
    except OSError as e:  # noqa: BLE001
        log_error("[alc] Could not write the knowledge index:", e)


def topics(workspace: str | None, limit: int = MAX_TOPIC_LIST) -> list[dict[str, Any]]:
    """Known topics with their note counts — what the cycle can search."""
    grouped: dict[str, dict[str, Any]] = {}
    for entry in read_index(workspace):
        slug = str(entry.get("slug") or slugify(str(entry.get("topic") or "")))
        bucket = grouped.setdefault(
            slug,
            {"topic": slug, "title": str(entry.get("topic") or slug), "notes": 0, "tags": []},
        )
        bucket["notes"] = int(bucket["notes"]) + 1
        for tag in entry.get("tags") or []:
            if isinstance(tag, str) and tag not in bucket["tags"]:
                bucket["tags"].append(tag)
    ordered = sorted(grouped.values(), key=lambda item: int(item["notes"]), reverse=True)
    return ordered[:limit]


def stats(workspace: str | None) -> dict[str, Any]:
    entries = read_index(workspace)
    return {
        "topics": len({str(e.get("slug") or "") for e in entries}),
        "notes": len(entries),
        "bytes": sum(int(e.get("bytes") or 0) for e in entries),
        "known": bool(entries),
    }


# ─── Search ─────────────────────────────────────────────────────────────
def search(workspace: str | None, query: str, *, k: int = 4) -> list[dict[str, Any]]:
    """Keyword search over the stored notes (same approach as the docs index)."""
    from .docs import _query_terms  # local import: docs holds the shared tokenizer

    directory = knowledge_dir(workspace)
    terms = _query_terms(query)
    if directory is None or not terms:
        return []

    entries = read_index(workspace)
    by_file: dict[str, list[dict[str, Any]]] = {}
    for entry in entries:
        name = str(entry.get("file") or "")
        if name:
            by_file.setdefault(name, []).append(entry)

    scored: list[dict[str, Any]] = []
    for name, group in list(by_file.items())[:MAX_SEARCH_FILES]:
        path = directory / name
        try:
            body = path.read_text(encoding="utf-8", errors="replace")[:MAX_TOPIC_BYTES]
        except OSError:
            continue
        lowered = body.lower()
        hits = [term for term in terms if term in lowered]
        if not hits:
            continue
        # Notes declared under this topic count a little extra: a hit in the
        # topic name or tags is a stronger signal than a passing mention.
        declared = " ".join(
            [str(entry.get("topic") or "") for entry in group]
            + [str(tag) for entry in group for tag in (entry.get("tags") or [])]
        ).lower()
        score = len(hits) / len(terms) + 0.25 * sum(1 for term in terms if term in declared)
        position = min((lowered.find(term) for term in hits if lowered.find(term) >= 0), default=0)
        snippet = " ".join(body[max(0, position - 120) : position + SEARCH_SNIPPET_CHARS].split())
        slug = str(group[0].get("slug") or path.stem)
        scored.append(
            {
                "source": f"knowledge:{slug}",
                "topic": slug,
                "text": snippet,
                "path": str(path),
                "score": round(score, 3),
                "matched": hits,
            }
        )

    scored.sort(key=lambda item: item["score"], reverse=True)
    return scored[: max(1, int(k or 4))]


# ─── Write ──────────────────────────────────────────────────────────────
def remember(
    workspace: str | None,
    topic: str,
    body: str,
    *,
    tags: Any = (),
    source: str = "alc",
) -> dict[str, Any]:
    """Store one durable note. Idempotent: the same body under the same topic is a no-op."""
    directory = knowledge_dir(workspace)
    if directory is None:
        return {"ok": False, "written": False, "reason": "no project directory in this mode"}

    text = str(body or "").strip()
    if not text:
        return {"ok": False, "written": False, "reason": "nothing to remember"}
    if len(text) > MAX_BODY_CHARS:
        text = text[: MAX_BODY_CHARS - 1].rstrip() + "…"

    slug = slugify(topic)
    digest = _hash(text)
    entries = read_index(workspace)
    if any(
        str(entry.get("slug") or "") == slug and str(entry.get("hash") or "") == digest
        for entry in entries
    ):
        return {"ok": True, "written": False, "reason": "already stored", "topic": slug}

    file_name = f"{slug}.md"
    path = directory / file_name
    tag_list = [str(tag).strip() for tag in (tags if isinstance(tags, (list, tuple)) else [tags]) if str(tag).strip()]

    try:
        existing_text = path.read_text(encoding="utf-8", errors="replace")[:MAX_TOPIC_BYTES] if path.exists() else ""
    except OSError:
        existing_text = ""
    if existing_text and _is_covered(existing_text, text):
        return {
            "ok": True,
            "written": False,
            "reason": "already stored (very similar to a note this project already has)",
            "topic": slug,
        }

    try:
        directory.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            path.write_text(f"# {topic.strip() or slug}\n", encoding="utf-8")
        header = f"\n## {_today()} — {str(source or 'alc').strip() or 'alc'}\n"
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(f"{header}\n{text}\n")
    except OSError as e:  # noqa: BLE001
        log_error("[alc] Could not write project knowledge:", e)
        return {"ok": False, "written": False, "reason": f"write failed: {type(e).__name__}"}

    try:
        size = path.stat().st_size
    except OSError:
        size = len(text)

    entries.append(
        {
            "id": f"{slug}-{digest[:8]}",
            "topic": topic.strip() or slug,
            "slug": slug,
            "file": file_name,
            "hash": digest,
            "source": str(source or "alc"),
            "tags": tag_list,
            "bytes": len(text),
            "createdAt": _now(),
            "updatedAt": _now(),
        }
    )
    _write_index(directory, entries)
    log_info(f"[alc] Remembered {len(text)} chars about '{slug}' in {file_name}")
    return {
        "ok": True,
        "written": True,
        "reason": "",
        "topic": slug,
        "file": str(path),
        "bytes": size,
    }


def for_finding(source: str, heading: str = "") -> str:
    """A readable topic name for a finding: its documentation heading, or its file/page."""
    title = (heading or "").split(">")[-1].strip()
    if title:
        return title
    cleaned = re.sub(r"^(docs|web|knowledge):", "", str(source or "")).strip()
    cleaned = cleaned.split("#")[0].strip()
    if cleaned.lower().startswith(("http://", "https://")):
        return cleaned.split("//")[-1].split("/")[0]
    stem = Path(cleaned).stem if cleaned else ""
    return stem or "notes"
