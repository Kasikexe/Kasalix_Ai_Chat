"""ALC project knowledge — the notes a cycle keeps for future cycles.

Layout inside the workspace (any turn that has a project directory — both engines,
see docs/ALC_DESIGN.md D8):

    <project>/ALC/knowledge/index.json      machine index: topics, tags, sources, sizes
    <project>/ALC/knowledge/<slug>.md       human-readable notes, one file per topic

Each topic file has two layers, both in the same file so that retrieval, dedupe
and search keep working on one artifact:

    # <topic>
    <!-- ALC-STUDY:START -->   the synthesised study — REPLACED on every rewrite
    ...                        (what a later turn should read first)
    <!-- ALC-STUDY:END -->
    ## <date> — <source>       appended notes — APPEND-ONLY, never rewritten
    <excerpt>

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

# The study block is delimited by comments so it can be replaced in place while
# the appended notes below it stay untouched.
STUDY_START = "<!-- ALC-STUDY:START -->"
STUDY_END = "<!-- ALC-STUDY:END -->"

MAX_BODY_CHARS = 4000
MAX_STUDY_CHARS = 6000
MAX_TOPIC_BYTES = 64 * 1024          # cap a single topic file's read for search
MAX_ENTRIES = 500
MAX_SEARCH_FILES = 60
SEARCH_SNIPPET_CHARS = 900
MAX_TOPIC_LIST = 20
MAX_INDEXED_SOURCES = 8

#: Index entry kinds. A study is one per topic and is replaced; a note is
#: append-only evidence.
KIND_NOTE = "note"
KIND_STUDY = "study"


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


def _split_study(text: str) -> tuple[str, str]:
    """Split a topic file into (study block inner, everything else).

    Returns ``("", text)`` when there is no study block. Used by every writer and
    reader so the two layers can never be confused for one another.
    """
    body = str(text or "")
    start = body.find(STUDY_START)
    end = body.find(STUDY_END)
    if start == -1 or end == -1 or end < start:
        return "", body
    inner = body[start + len(STUDY_START) : end].strip("\n")
    return inner, (body[:start] + body[end + len(STUDY_END) :]).strip("\n")


def _title_and_rest(text: str, topic: str) -> tuple[str, str]:
    """A topic file's ``# Title`` line and the appended-note body under it."""
    body = str(text or "").strip("\n")
    lines = body.splitlines()
    if lines and lines[0].startswith("# "):
        return lines[0], "\n".join(lines[1:]).strip("\n")
    title = f"# {topic.strip() or slugify(topic)}"
    return title, body


def read_study(workspace: str | None, topic: str) -> str:
    """The synthesised study for a topic, or "" when there is none."""
    directory = knowledge_dir(workspace)
    if directory is None:
        return ""
    path = directory / f"{slugify(topic)}.md"
    try:
        text = path.read_text(encoding="utf-8", errors="replace")[:MAX_TOPIC_BYTES]
    except OSError:
        return ""
    return _split_study(text)[0]


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:32]


def _now() -> float:
    return datetime.now(timezone.utc).timestamp()


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _date_of(stamp: float) -> str:
    """An ISO date for a stored timestamp, or "" when there is none."""
    if not stamp:
        return ""
    try:
        return datetime.fromtimestamp(float(stamp), timezone.utc).strftime("%Y-%m-%d")
    except (OSError, OverflowError, ValueError):
        return ""


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


def _kind(entry: dict[str, Any]) -> str:
    return str(entry.get("kind") or KIND_NOTE)


def topics(workspace: str | None, limit: int = MAX_TOPIC_LIST) -> list[dict[str, Any]]:
    """Known topics with their note counts — what the cycle can search."""
    grouped: dict[str, dict[str, Any]] = {}
    for entry in read_index(workspace):
        slug = str(entry.get("slug") or slugify(str(entry.get("topic") or "")))
        bucket = grouped.setdefault(
            slug,                {"topic": slug, "title": str(entry.get("topic") or slug), "notes": 0,
                "studies": 0,
                "updatedAt": 0.0,
                "tags": [],
            },
        )
        if _kind(entry) == KIND_STUDY:
            bucket["studies"] = int(bucket["studies"]) + 1
        else:
            bucket["notes"] = int(bucket["notes"]) + 1
        bucket["updatedAt"] = max(
            float(bucket["updatedAt"]), float(entry.get("updatedAt") or 0)
        )
        for tag in entry.get("tags") or []:
            if isinstance(tag, str) and tag not in bucket["tags"]:
                bucket["tags"].append(tag)
    ordered = sorted(
        grouped.values(),
        key=lambda item: (int(item["notes"]) + int(item["studies"]) * 2, item["updatedAt"]),
        reverse=True,
    )
    return ordered[:limit]


def stats(workspace: str | None) -> dict[str, Any]:
    entries = read_index(workspace)
    notes = [entry for entry in entries if _kind(entry) != KIND_STUDY]
    studies = [entry for entry in entries if _kind(entry) == KIND_STUDY]
    return {
        "topics": len({str(e.get("slug") or "") for e in entries}),
        "notes": len(notes),
        "studies": len(studies),
        "bytes": sum(int(e.get("bytes") or 0) for e in entries),
        "known": bool(entries),
        "updatedAt": max((float(e.get("updatedAt") or 0) for e in entries), default=0.0),
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
        updated = max((float(entry.get("updatedAt") or 0) for entry in group), default=0.0)
        scored.append(
            {
                "source": f"knowledge:{slug}",
                "topic": slug,
                "text": snippet,
                "path": str(path),
                "score": round(score, 3),
                "matched": hits,
                # When this topic was last written — what a later turn needs to
                # judge how current the note is.
                "date": _date_of(updated),
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
    # Compare against the APPENDED NOTES only, never against a study block: a
    # study's vocabulary is broad by design, so containment against it would
    # report almost any new fact as "already stored".
    _study_text, notes_text = _split_study(existing_text)
    if notes_text and _is_covered(notes_text, text):
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
            "kind": KIND_NOTE,
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


# ─── Studies ────────────────────────────────────────────────────────────
def write_study(
    workspace: str | None,
    topic: str,
    body: str,
    *,
    sources: Any = (),
    updated: str = "",
) -> dict[str, Any]:
    """Replace a topic's study block. The appended notes below it are untouched.

    Unlike :func:`remember` this is a REPLACEMENT, not an append: a study is the
    current best understanding, and keeping every draft would just add noise for
    the next turn to sort through. Returns ``written: False`` when the block is
    unchanged, so a cycle that learns nothing new costs no write.

    The study is registered in the index like a note, with its own kind, so
    search, ``topics()`` and ``stats()`` see it without special cases.
    """
    directory = knowledge_dir(workspace)
    if directory is None:
        return {"ok": False, "written": False, "reason": "no project directory in this mode"}

    text = str(body or "").strip()
    if not text:
        return {"ok": False, "written": False, "reason": "nothing to remember"}
    if len(text) > MAX_STUDY_CHARS:
        text = text[: MAX_STUDY_CHARS - 1].rstrip() + "…"

    slug = slugify(topic)
    file_name = f"{slug}.md"
    path = directory / file_name
    try:
        existing = path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""
    except OSError:
        existing = ""

    old_study, rest = _split_study(existing)
    title, notes = _title_and_rest(rest, topic)
    block = f"{STUDY_START}\n{text}\n{STUDY_END}"
    tail = "\n\n".join(part for part in (title, block, notes) if part).rstrip() + "\n"

    if old_study and " ".join(old_study.split()) == " ".join(text.split()):
        return {
            "ok": True,
            "written": False,
            "reason": "the study is unchanged",
            "topic": slug,
            "file": str(path),
        }

    digest = _hash(text)
    origin_list = [
        {
            "source": str(item.get("source") if isinstance(item, dict) else item),
            "date": str(item.get("date") or "") if isinstance(item, dict) else "",
        }
        for item in (sources or [])
    ][:MAX_INDEXED_SOURCES]
    try:
        directory.mkdir(parents=True, exist_ok=True)
        path.write_text(tail, encoding="utf-8")
    except OSError as e:  # noqa: BLE001
        log_error("[alc] Could not write a project study:", e)
        return {"ok": False, "written": False, "reason": f"write failed: {type(e).__name__}"}

    entries = [
        entry
        for entry in read_index(workspace)
        if not (str(entry.get("slug") or "") == slug and _kind(entry) == KIND_STUDY)
    ]
    entries.append(
        {
            "id": f"{slug}-study",
            "kind": KIND_STUDY,
            "topic": topic.strip() or slug,
            "slug": slug,
            "file": file_name,
            "hash": digest,
            "source": origin_list[0]["source"] if origin_list else "alc",
            "sources": origin_list,
            "tags": ["alc", "study"],
            "bytes": len(text),
            "createdAt": _now(),
            "updatedAt": _now(),
            "studyUpdated": str(updated or _today()),
        }
    )
    _write_index(directory, entries)
    log_info(f"[alc] Wrote a {len(text)}-char study for '{slug}' in {file_name}")
    return {
        "ok": True,
        "written": True,
        "reason": "",
        "topic": slug,
        "file": str(path),
        "sources": origin_list,
        "replaced": bool(old_study),
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
