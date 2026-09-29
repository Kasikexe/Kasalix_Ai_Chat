"""ALC documentation search — SQLite FTS5 over the host's documentation folders.

The problem this solves: a documentation file can be 10,000 words covering many
libraries, and the model needs the pygame part. Dumping the file into the
context is both expensive and useless; searching it is neither.

Implementation notes:

* ``sqlite3`` + FTS5 from the standard library — no new dependency, no server,
  no embedding model. Ranking is BM25 (FTS5's default ``rank``).
* Chunks are markdown-aware: the document is split on headings first and the
  heading path is stored as its own indexed column, so a hit can be reported as
  "pygame > Handling events" instead of "line 4211".
* All entry points are SYNCHRONOUS (sqlite3 is blocking). The controller calls
  them through ``asyncio.to_thread``.
* If FTS5 is unavailable in the interpreter's SQLite build, every search falls
  back to a bounded in-memory scan so ALC still works.
"""

from __future__ import annotations

import hashlib
import os
import re
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

from ..config import get_data_dir
from ..logger import error as log_error, info as log_info

# ─── Limits ─────────────────────────────────────────────────────────────
MAX_DOC_BYTES = 4 * 1024 * 1024        # skip anything bigger (be generous: docs can be big)
MAX_SCAN_BYTES = 256 * 1024            # read cap per file during a fallback scan
CHUNK_CHARS = 1600
CHUNK_OVERLAP = 200
DEFAULT_RESULTS = 5
MAX_RESULTS = 20
MAX_SNIPPET_CHARS = 1200
SCAN_MAX_FILES = 500
_PREVIEW_BYTES = 8192

DOC_EXTENSIONS = {
    ".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc", ".org",
    ".html", ".htm", ".xml", ".yaml", ".yml", ".json", ".toml", ".ini", ".cfg",
    ".py", ".js", ".jsx", ".ts", ".tsx", ".java", ".c", ".h", ".cpp", ".hpp",
    ".cs", ".go", ".rs", ".rb", ".php", ".sql", ".sh", ".ps1", ".css",
    ".lua", ".kt", ".swift", ".dart", ".vue", ".svelte",
}

SKIP_DIR_NAMES = {
    ".git", ".svn", ".hg", "node_modules", "__pycache__", ".venv", "venv",
    "dist", "build", ".next", ".nuxt", "target", "vendor", ".cache", ".idea",
    ".vscode", "site-packages", ".mypy_cache", ".pytest_cache",
}

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_WORD_RE = re.compile(r"\w{2,}", re.UNICODE)
_STOPWORDS = {
    "the", "and", "for", "with", "that", "this", "from", "what", "how", "why",
    "when", "where", "which", "into", "does", "did", "are", "was", "were", "you",
    "your", "can", "could", "should", "would", "have", "has", "had", "not", "but",
    "use", "using", "get", "got", "make", "made", "about", "there", "their", "them",
    "then", "than", "its", "it's", "also", "any", "all", "some", "one", "two",
    # Short function words: they match almost every document, so they only dilute
    # BM25 (and the scan fallback's term counting) when included.
    "do", "is", "to", "of", "in", "on", "at", "as", "be", "by", "or", "if",
    "we", "me", "my", "it", "so", "up", "no", "am", "an",
}

_fts5_state: bool | None = None


# ─── Index location / schema ────────────────────────────────────────────
def index_path() -> Path:
    return get_data_dir() / "alc" / "docs-index.sqlite"


def fts5_available() -> bool:
    """Whether this interpreter's SQLite was built with FTS5 (almost always is)."""
    global _fts5_state
    if _fts5_state is not None:
        return _fts5_state
    try:
        conn = sqlite3.connect(":memory:")
        try:
            conn.execute("CREATE VIRTUAL TABLE probe USING fts5(x)")
            _fts5_state = True
        finally:
            conn.close()
    except Exception:  # noqa: BLE001
        log_info("[alc] SQLite FTS5 unavailable — documentation search uses the scan fallback")
        _fts5_state = False
    return _fts5_state


def _connect() -> sqlite3.Connection:
    path = index_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=10.0)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS files (
            path TEXT PRIMARY KEY,
            mtime REAL NOT NULL,
            size INTEGER NOT NULL,
            hash TEXT NOT NULL,
            chunks INTEGER NOT NULL DEFAULT 0,
            indexed_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """
    )
    if fts5_available():
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5("
            "text, path, heading, chunk_no UNINDEXED, tokenize='porter unicode61')"
        )
    return conn


# ─── Chunking ───────────────────────────────────────────────────────────
def _sections(text: str) -> list[tuple[str, str]]:
    """Split markdown-ish text into (heading_path, body) sections."""
    sections: list[tuple[str, str]] = []
    stack: list[tuple[int, str]] = []
    buf: list[str] = []

    def flush() -> None:
        body = "\n".join(buf).strip()
        if body:
            sections.append((" > ".join(title for _, title in stack), body))
        buf.clear()

    for line in text.splitlines():
        match = _HEADING_RE.match(line)
        if match:
            flush()
            level = len(match.group(1))
            stack = [entry for entry in stack if entry[0] < level]
            stack.append((level, match.group(2).strip()))
            continue
        buf.append(line)
    flush()
    return sections


def _windows(body: str, max_chars: int = CHUNK_CHARS, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Window a long section, preferring to cut on a blank line or sentence end."""
    if len(body) <= max_chars:
        return [body]
    if overlap >= max_chars:
        overlap = max_chars // 4
    out: list[str] = []
    start = 0
    length = len(body)
    while start < length:
        end = min(start + max_chars, length)
        if end < length:
            window = body[start:end]
            cut = max(window.rfind("\n\n"), window.rfind(". "))
            if cut > max_chars // 2:
                end = start + cut + 1
        out.append(body[start:end].strip())
        if end >= length:
            break
        start = max(end - overlap, start + 1)
    return [chunk for chunk in out if chunk]


def chunk_text(text: str) -> list[tuple[str, str]]:
    """Public helper: (heading_path, chunk) pairs for one document."""
    chunks: list[tuple[str, str]] = []
    for heading, body in _sections(text or ""):
        for chunk in _windows(body):
            chunks.append((heading, chunk))
    return chunks


# ─── File discovery ─────────────────────────────────────────────────────
def resolve_roots(paths: Iterable[str] | None) -> list[str]:
    """Existing directories only, de-duplicated and resolved."""
    roots: list[str] = []
    for raw in list(paths or []):
        # An empty/whitespace entry must be dropped BEFORE realpath: realpath("") is
        # the process working directory, which would silently index all of backend/.
        text = str(raw or "").strip()
        if not text:
            continue
        try:
            resolved = os.path.realpath(os.path.expanduser(text))
        except (OSError, ValueError):
            continue
        if os.path.isdir(resolved) and resolved not in roots:
            roots.append(resolved)
    return roots


def _is_binary(path: str) -> bool:
    try:
        with open(path, "rb") as handle:
            head = handle.read(1024)
    except OSError:
        return True
    return b"\x00" in head


def iter_doc_files(roots: Iterable[str]) -> list[str]:
    found: list[str] = []
    for root in roots:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIR_NAMES and not d.startswith(".")]
            for name in filenames:
                if name.startswith("."):
                    continue
                if os.path.splitext(name)[1].lower() not in DOC_EXTENSIONS:
                    continue
                full = os.path.join(dirpath, name)
                try:
                    if os.path.getsize(full) > MAX_DOC_BYTES:
                        continue
                except OSError:
                    continue
                found.append(full)
    return found


def _read_text(path: str, limit: int = MAX_DOC_BYTES) -> str | None:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read(limit)
    except OSError:
        return None


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()[:32]


# ─── Index build ────────────────────────────────────────────────────────
def build_index(
    roots: Iterable[str],
    *,
    force: bool = False,
    on_progress: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    """Incrementally (re)index the documentation folders. Blocking — call in a thread."""
    roots = list(roots or [])
    stats: dict[str, Any] = {"files": 0, "chunks": 0, "updated": 0, "skipped": 0, "errors": 0}
    if not roots:
        return stats
    try:
        conn = _connect()
    except sqlite3.Error as e:  # noqa: BLE001
        log_error("[alc] Could not open the documentation index:", e)
        stats["errors"] += 1
        return stats

    try:
        files = iter_doc_files(roots)
        known: dict[str, tuple[float, int, str]] = {}
        for path, mtime, size, digest in conn.execute("SELECT path, mtime, size, hash FROM files"):
            known[path] = (mtime, size, digest)

        seen = set(files)
        for stale in [p for p in known if p not in seen]:
            conn.execute("DELETE FROM chunks WHERE path = ?", (stale,))
            conn.execute("DELETE FROM files WHERE path = ?", (stale,))

        import time as _time

        for i, path in enumerate(files, start=1):
            if on_progress and (i == 1 or i == len(files) or i % 25 == 0):
                on_progress({"phase": "indexing", "done": i, "total": len(files)})
            try:
                stat = os.stat(path)
            except OSError:
                stats["errors"] += 1
                continue
            previous = known.get(path)
            if (
                not force
                and previous
                and abs(previous[0] - stat.st_mtime) < 1e-6
                and previous[1] == stat.st_size
            ):
                stats["files"] += 1
                stats["skipped"] += 1
                continue
            if _is_binary(path):
                stats["skipped"] += 1
                continue
            text = _read_text(path)
            if text is None:
                stats["errors"] += 1
                continue
            digest = _hash(text)
            if previous and previous[2] == digest and previous[1] == stat.st_size and not force:
                conn.execute(
                    "UPDATE files SET mtime = ?, size = ?, indexed_at = ? WHERE path = ?",
                    (stat.st_mtime, stat.st_size, _time.time(), path),
                )
                stats["files"] += 1
                stats["skipped"] += 1
                continue
            chunks = chunk_text(text)
            conn.execute("DELETE FROM chunks WHERE path = ?", (path,))
            conn.executemany(
                "INSERT INTO chunks (text, path, heading, chunk_no) VALUES (?, ?, ?, ?)",
                [(chunk, path, heading, n) for n, (heading, chunk) in enumerate(chunks)],
            )
            conn.execute(
                "INSERT INTO files (path, mtime, size, hash, chunks, indexed_at) "
                "VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(path) DO UPDATE SET mtime=excluded.mtime, size=excluded.size, "
                "hash=excluded.hash, chunks=excluded.chunks, indexed_at=excluded.indexed_at",
                (path, stat.st_mtime, stat.st_size, digest, len(chunks), _time.time()),
            )
            stats["files"] += 1
            stats["chunks"] += len(chunks)
            stats["updated"] += 1

        conn.execute(
            "INSERT INTO meta (key, value) VALUES ('lastBuiltAt', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (str(_time.time()),),
        )
        conn.commit()
    except sqlite3.Error as e:  # noqa: BLE001
        log_error("[alc] Documentation index build failed:", e)
        stats["errors"] += 1
    finally:
        conn.close()
    log_info(
        f"[alc] Documentation index: {stats['files']} files, {stats['chunks']} chunks "
        f"({stats['updated']} updated, {stats['skipped']} unchanged)"
    )
    return stats


def source_date(path: str) -> str:
    """A documentation file's last-modified date, ISO, or "" when unreadable.

    Findings carry this so a later turn can tell which of two contradicting
    passages is the newer one — and so a study can record when what it says was
    true. A note without a date cannot be re-checked when it turns out to be
    wrong.
    """
    try:
        stamp = Path(str(path or "")).stat().st_mtime
    except (OSError, ValueError):
        return ""
    return datetime.fromtimestamp(stamp, timezone.utc).strftime("%Y-%m-%d")


def index_status() -> dict[str, Any]:
    """What is indexed right now (cheap — used to decide whether to rebuild)."""
    status: dict[str, Any] = {"built": False, "files": 0, "chunks": 0, "lastBuiltAt": 0.0}
    try:
        conn = _connect()
    except sqlite3.Error:
        return status
    try:
        row = conn.execute("SELECT COUNT(*) FROM files").fetchone()
        status["files"] = int(row[0]) if row else 0
        if fts5_available():
            row = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()
            status["chunks"] = int(row[0]) if row else 0
        row = conn.execute("SELECT value FROM meta WHERE key = 'lastBuiltAt'").fetchone()
        if row:
            status["lastBuiltAt"] = float(row[0])
        status["built"] = bool(row)
    except (sqlite3.Error, ValueError):
        pass
    finally:
        conn.close()
    return status


def clear_index() -> bool:
    """Forget every indexed document (the index is only a cache — safe to drop)."""
    try:
        conn = _connect()
    except sqlite3.Error as e:  # noqa: BLE001
        log_error("[alc] Could not open the documentation index:", e)
        return False
    try:
        if fts5_available():
            conn.execute("DELETE FROM chunks")
        conn.execute("DELETE FROM files")
        conn.execute("DELETE FROM meta WHERE key = 'lastBuiltAt'")
        conn.commit()
        log_info("[alc] Documentation index cleared")
        return True
    except sqlite3.Error as e:  # noqa: BLE001
        log_error("[alc] Could not clear the documentation index:", e)
        return False
    finally:
        conn.close()


# ─── Search ─────────────────────────────────────────────────────────────
def _query_terms(query: str) -> list[str]:
    terms: list[str] = []
    for token in _WORD_RE.findall(query or ""):
        lower = token.lower()
        if lower in _STOPWORDS:
            continue
        if lower not in terms:
            terms.append(lower)
    return terms


def query_terms(query: str) -> list[str]:
    """Public form of the query terms, for callers that need the same view."""
    return _query_terms(query)


#: Terms at least this long are also matched as prefixes, so "configure" reaches
#: "configuration" and "pace" reaches "paces". Shorter terms would match half the
#: corpus, which dilutes BM25 rather than improving recall.
_PREFIX_MIN = 5


def _fts_query(query: str) -> str | None:
    """A safe FTS5 MATCH expression: quoted terms OR'd together.

    Raw user text is never passed to MATCH — punctuation in a query ("C++",
    "it's") is a syntax error in FTS5 and would silently kill every search.
    """
    terms = _query_terms(query)
    if not terms:
        return None
    return " OR ".join(
        f'"{term}"*' if len(term) >= _PREFIX_MIN else f'"{term}"' for term in terms[:12]
    )


def _stem(term: str) -> str:
    """A cheap stem, good enough for matching a query word to a heading word.

    No dependency and no correctness pretence: it only has to decide whether two
    words are close enough that searching the other one is better than searching
    nothing at all.
    """
    for suffix in ("ing", "ions", "ion", "ies", "ed", "es", "s"):
        if len(term) > len(suffix) + 3 and term.endswith(suffix):
            return term[: -len(suffix)]
    return term


def vocabulary(*, limit: int = 40_000) -> list[str]:
    """The words the index actually contains, from its headings.

    This is the honest, dependency-free form of query expansion: instead of a
    hand-written synonym list guessing what the documentation might say, the
    documentation's own vocabulary says which words exist to search for.
    """
    global _vocabulary_cache
    now = time.time()
    if _vocabulary_cache and now - _vocabulary_cache[1] < VOCABULARY_TTL_SECONDS:
        return _vocabulary_cache[0]
    words: list[str] = []
    if fts5_available():
        try:
            conn = _connect()
        except sqlite3.Error:
            return []
        try:
            rows = conn.execute(
                "SELECT heading, text FROM chunks ORDER BY chunk_no LIMIT ?", (limit,)
            ).fetchall()
        except sqlite3.Error:
            return []
        finally:
            conn.close()
        seen: set[str] = set()
        for heading, text in rows:
            for token in _WORD_RE.findall(f"{heading or ''} {str(text or '')[:400]}"):
                lower = token.lower()
                if len(lower) < 4 or lower in _STOPWORDS or lower in seen:
                    continue
                seen.add(lower)
                words.append(lower)
    _vocabulary_cache = (words, now)
    return words


def expand_terms(terms: list[str], words: list[str]) -> list[str]:
    """Query words with no counterpart in the documentation, replaced by its own.

    A question phrased "rate cap" will never match a file that says "cadence
    limiter" by term overlap alone — but if the index contains ``cadence`` and the
    question says ``rate``, the closest documented word is a better search than
    the word that matched nothing. Purely lexical, purely deterministic.
    """
    if not terms or not words:
        return []
    by_stem: dict[str, str] = {}
    for word in words:
        by_stem.setdefault(_stem(word), word)
    out: list[str] = []
    for term in terms:
        if term in by_stem or term in words:
            continue
        candidate = by_stem.get(_stem(term))
        if candidate is None:
            # The first four letters: long enough to be specific, short enough to
            # survive a spelling or truncation difference ("cade" -> "cadence").
            prefix = term[:4]
            candidate = next((word for word in words if word.startswith(prefix)), None)
        if candidate and candidate not in out:
            out.append(candidate)
    return out[:6]


def _like_prefixes(roots: Iterable[str] | None) -> tuple[str, list[str]]:
    roots = list(roots or [])
    if not roots:
        return "", []
    clause = " AND (" + " OR ".join("path LIKE ?" for _ in roots) + ")"
    return clause, [f"{root}%" for root in roots]


def _search_rows(
    query: str, *, k: int = DEFAULT_RESULTS, roots: Iterable[str] | None = None
) -> tuple[list[dict[str, Any]], bool]:
    """Ranked chunks, plus whether any hit pointed at a file that no longer exists.

    The index is refreshed on a TTL, so a file deleted since the last build is
    still indexed. Answering from a document that is gone is worse than not
    answering at all, so a hit whose file is missing is dropped and reported as
    stale (``search_docs`` then rebuilds and asks again).
    """
    if not fts5_available():
        return [], False
    match = _fts_query(query)
    if not match:
        return [], False
    limit = max(1, min(int(k or DEFAULT_RESULTS), MAX_RESULTS))
    clause, params = _like_prefixes(roots)
    try:
        conn = _connect()
    except sqlite3.Error:
        return [], False
    try:
        # bm25's weights follow the columns in declaration order (text, path,
        # heading, chunk_no). The heading counts for more than the body: a query
        # like "Vintra pace" is naming a section, and a hit IN that section is far
        # more useful than the word appearing somewhere in the prose. chunk_no is
        # UNINDEXED, so its weight is irrelevant and stays 0.
        rows = conn.execute(
            "SELECT path, heading, text, chunk_no, "
            "bm25(chunks, 1.0, 0.4, 2.4, 0.0) AS score FROM chunks "
            f"WHERE chunks MATCH ?{clause} ORDER BY score LIMIT ?",
            [match, *params, limit],
        ).fetchall()
    except sqlite3.Error as e:  # noqa: BLE001
        log_error("[alc] Documentation search failed:", e)
        return [], False
    finally:
        conn.close()

    results: list[dict[str, Any]] = []
    stale = False
    for path, heading, text, _chunk_no, score in rows:
        if not os.path.isfile(path):
            stale = True
            continue
        snippet = " ".join(str(text or "").split())
        results.append(
            {
                "path": path,
                "heading": heading or "",
                "text": snippet[:MAX_SNIPPET_CHARS],
                # Which chunk of the file this is: the neighbouring chunks are
                # what a multi-hop answer usually needs (see neighbours()).
                "chunk": int(_chunk_no or 0),
                "score": -float(score or 0.0),
                "matched": [term for term in _query_terms(query) if term in snippet.lower()],
                "source": f"docs:{os.path.basename(path)}" + (f"#{heading}" if heading else ""),
            }
        )
    return results, stale


def neighbours(path: str, chunk_no: int, *, span: int = 1) -> list[dict[str, Any]]:
    """The chunks around one hit in the same file — the rest of its section.

    A document puts the name in one section and the value in the next; a single
    chunk answer therefore reads as covered while the answer is one chunk away.
    Blocking.
    """
    if not path or not fts5_available():
        return []
    low, high = int(chunk_no) - abs(int(span)), int(chunk_no) + abs(int(span))
    try:
        conn = _connect()
    except sqlite3.Error:
        return []
    try:
        rows = conn.execute(
            "SELECT chunk_no, heading, text FROM chunks WHERE path = ? AND chunk_no BETWEEN ? "
            "AND ? ORDER BY chunk_no",
            (path, low, high),
        ).fetchall()
    except sqlite3.Error:
        return []
    finally:
        conn.close()
    out: list[dict[str, Any]] = []
    for number, heading, text in rows:
        if int(number) == int(chunk_no):
            continue
        out.append(
            {
                "path": path,
                "chunk": int(number),
                "heading": heading or "",
                "text": " ".join(str(text or "").split()),
            }
        )
    return out


def search(query: str, *, k: int = DEFAULT_RESULTS, roots: Iterable[str] | None = None) -> list[dict[str, Any]]:
    """Ranked documentation chunks for ``query`` (best first). Blocking."""
    results, _stale = _search_rows(query, k=k, roots=roots)
    return results


def scan_search(query: str, roots: Iterable[str], *, k: int = DEFAULT_RESULTS) -> list[dict[str, Any]]:
    """Fallback: score files in memory. Used when the index is empty or FTS5 is missing."""
    terms = _query_terms(query)
    if not terms:
        return []
    limit = max(1, min(int(k or DEFAULT_RESULTS), MAX_RESULTS))
    scored: list[dict[str, Any]] = []
    for path in iter_doc_files(roots)[:SCAN_MAX_FILES]:
        if _is_binary(path):
            continue
        raw = _read_text(path, MAX_SCAN_BYTES)
        if not raw:
            continue
        haystack = raw.lower()
        hits = [term for term in terms if term in haystack]
        if not hits:
            continue
        score = float(sum(min(haystack.count(term), 20) for term in hits)) / max(1, len(terms))
        position = min((haystack.find(term) for term in hits if haystack.find(term) >= 0), default=0)
        snippet = " ".join(raw[max(0, position - 200) : position + MAX_SNIPPET_CHARS].split())
        scored.append(
            {
                "path": path,
                "heading": "",
                "text": snippet,
                "score": score,
                "matched": hits,
                "source": f"docs:{os.path.basename(path)}",
            }
        )
    scored.sort(key=lambda item: item["score"], reverse=True)
    return scored[:limit]


def search_docs(
    query: str,
    *,
    k: int = DEFAULT_RESULTS,
    roots: Iterable[str] | None = None,
    allow_scan: bool = True,
    expand: bool = True,
) -> list[dict[str, Any]]:
    """Search the index, falling back to a scan when the index has nothing.

    Also self-heals: if the index answered from files that have been deleted, it
    is rebuilt once and the query is re-run, so ALC never cites documentation
    that is no longer on disk.

    A THIN result set is asked again with the documentation's own vocabulary
    substituted for the words that matched nothing (D16). The first attempt is
    always made as written: expansion can only add hits, and a cycle that stops
    at one search still gets the honest answer for a well-worded question.
    """
    results, stale = _search_rows(query, k=k, roots=roots)
    if stale and list(roots or []):
        build_index(list(roots or []))
        results, _stale_again = _search_rows(query, k=k, roots=roots)
    if expand and len(results) < max(1, int(k)):
        results = _merge(results, _expanded_rows(query, k=k, roots=roots))
    if results or not allow_scan:
        return results[: max(1, min(int(k or DEFAULT_RESULTS), MAX_RESULTS))]
    return scan_search(query, list(roots or []), k=k)


def _expanded_rows(
    query: str, *, k: int, roots: Iterable[str] | None = None
) -> list[dict[str, Any]]:
    """The same search with undocumented query words replaced by documented ones."""
    terms = _query_terms(query)
    if not terms:
        return []
    extra = expand_terms(terms, vocabulary())
    if not extra:
        return []
    widened, _stale = _search_rows(" ".join([query, *extra]), k=k, roots=roots)
    return widened


def _merge(
    primary: list[dict[str, Any]], secondary: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Keep the better-ranked copy of each (file, chunk), best first."""
    best: dict[tuple[str, int], dict[str, Any]] = {}
    for item in [*primary, *secondary]:
        key = (str(item.get("path") or ""), int(item.get("chunk") or 0))
        current = best.get(key)
        if current is None or float(item.get("score") or 0.0) > float(current.get("score") or 0.0):
            best[key] = item
    return sorted(best.values(), key=lambda item: float(item.get("score") or 0.0), reverse=True)


# How long an index build is trusted before the folders are walked again. Short
# on purpose: documents ADDED after a build only become searchable at the next
# refresh. Removals do not wait for it — a hit whose file is gone is dropped and
# triggers a rebuild immediately (see search_docs).
INDEX_TTL_SECONDS = 60.0

# How long the vocabulary used for query expansion is reused. Only cheap reads
# depend on it, and a stale vocabulary at worst means one search is not widened.
VOCABULARY_TTL_SECONDS = 300.0

_vocabulary_cache: tuple[list[str], float] | None = None


# ─── Reading a hit ──────────────────────────────────────────────────────
def _inside_roots(path: str, roots: Iterable[str]) -> bool:
    resolved = os.path.realpath(path)
    for root in roots:
        try:
            if os.path.commonpath([resolved, os.path.realpath(root)]) == os.path.realpath(root):
                return True
        except ValueError:  # different drives on Windows
            continue
    return False


def open_doc(
    path: str,
    *,
    line: int = 1,
    max_chars: int = 4000,
    roots: Iterable[str] = (),
) -> dict[str, Any]:
    """Read part of an indexed document. Refuses anything outside the roots."""
    roots = list(roots or [])
    if not path:
        return {"ok": False, "error": "path is required"}
    if roots and not _inside_roots(path, roots):
        return {"ok": False, "error": "that file is outside the configured documentation folders"}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            text = handle.read(MAX_DOC_BYTES)
    except OSError as e:
        return {"ok": False, "error": f"could not read {path}: {e}"}
    start = max(0, int(line or 1) - 1)
    excerpt = "\n".join(text.splitlines()[start:]).strip()
    truncated = len(excerpt) > max_chars
    return {
        "ok": True,
        "path": path,
        "line": start + 1,
        "text": excerpt[:max_chars],
        "truncated": truncated,
        "source": f"docs:{os.path.basename(path)}",
    }
