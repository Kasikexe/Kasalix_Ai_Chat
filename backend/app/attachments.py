"""Chat image attachments — durable storage for pictures sent from a client.

A client attaches an image by embedding it in the message text as a data URL::

    [image:data:image/png;base64,iVBOR…]

That marker is what the Ollama message converter understands, but persisting it
verbatim would put ~13 MB of base64 into the conversation store for every 10 MB
photo, and every load of that conversation would have to parse it. So the chat
route hands the message it is about to save to :func:`persist_data_urls`, which
writes the bytes to ``ATTACHMENTS_DIR`` under a content-addressed name and
rewrites the marker to a stable reference::

    [image:1f0c9a…ab.png]

The clients render that reference through ``GET /api/attachments/<filename>``,
and :func:`app.ollama_client.convert_messages_for_ollama` resolves it back to
base64 for a vision model — so an image attached three turns ago is still
visible to both the user and the model. Content-addressed names mean attaching
the same picture twice stores it once.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import os
import re
from pathlib import Path

from .config import get_attachments_dir
from .logger import info as log_info

# What a client sends us: the whole data URL, wrapped in a marker.
DATA_IMAGE_RE = re.compile(
    r"\[image:(data:image/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+))\]",
    re.IGNORECASE,
)

# What we persist: a single path-free token, so a stored message can never point
# outside the attachments directory.
ATTACHMENT_REF_RE = re.compile(r"\[image:([A-Za-z0-9][A-Za-z0-9._-]{0,80})\]")

# Both forms at once, so images come back in the order they appear in the
# message rather than "inline images first, then stored ones".
# Groups: 1 = subtype, 2 = inline base64, 3 = stored filename.
ANY_IMAGE_RE = re.compile(
    r"\[image:data:image/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)\]"
    r"|\[image:([A-Za-z0-9][A-Za-z0-9._-]{0,80})\]",
    re.IGNORECASE,
)

# A marker that *claimed* to be an inline image but did not parse (truncated
# base64, unsupported type). Never persist bytes-shaped junk.
LEFT_OVER_DATA_URL_RE = re.compile(r"\[image:data:[^\]]*\]", re.IGNORECASE)

# Any image marker, in either form — including the bare ``[image]`` placeholder
# older messages were saved with.
IMAGE_MARKER_RE = re.compile(r"\[image(?::[^\]]*)?\]")

# Filename of a stored attachment. Deliberately strict: no separators, no
# leading dot, no ``..``.
ATTACHMENT_FILENAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(?:png|jpe?g|webp|gif|bmp)")

# Client-side pickers cap at 10 MB; give the decoded bytes a little headroom for
# a raw upload path and reject anything above this outright.
MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024

_EXT_BY_SUBTYPE = {
    "png": "png",
    "jpeg": "jpg",
    "jpg": "jpg",
    "webp": "webp",
    "gif": "gif",
    "bmp": "bmp",
}

CONTENT_TYPE_BY_EXT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
}


def content_type_for(filename: str) -> str:
    return CONTENT_TYPE_BY_EXT.get(Path(filename).suffix.lower(), "application/octet-stream")


def is_attachment_filename(filename: str) -> bool:
    return bool(ATTACHMENT_FILENAME_RE.fullmatch(filename))


def attachment_path(filename: str) -> Path | None:
    """Absolute path for a stored attachment, or None for an unsafe name."""
    if not is_attachment_filename(filename):
        return None
    return get_attachments_dir() / filename


def save_data_url(data_url: str) -> str | None:
    """Store the bytes behind one ``data:image/…;base64,…`` URL.

    Returns the attachment filename, or None when the payload is not a
    supported image / is empty / is too large.
    """
    match = re.fullmatch(r"data:image/([a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)", data_url, re.IGNORECASE)
    if not match:
        return None
    ext = _EXT_BY_SUBTYPE.get(match.group(1).lower())
    if not ext:
        return None
    try:
        raw = base64.b64decode(match.group(2), validate=False)
    except (binascii.Error, ValueError):
        return None
    if not raw or len(raw) > MAX_ATTACHMENT_BYTES:
        return None

    filename = f"{hashlib.sha256(raw).hexdigest()[:32]}.{ext}"
    path = get_attachments_dir() / filename
    if not path.is_file():
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(path.name + ".part")
            tmp.write_bytes(raw)
            os.replace(tmp, path)
            log_info(f"[attachments] stored {filename} ({len(raw)} bytes)")
        except OSError as e:  # pragma: no cover - disk failures
            log_info(f"[attachments] could not store image: {e}")
            return None
    return filename


def persist_data_urls(text: str) -> str:
    """Rewrite every inline image data URL in ``text`` to a stored reference.

    Unsupported or oversized images degrade to the bare ``[image]`` placeholder
    the clients already know how to render, so the message text is never lost.
    """
    if not text or "data:image/" not in text:
        return text

    def _replace(match: re.Match[str]) -> str:
        filename = save_data_url(match.group(1))
        return f"[image:{filename}]" if filename else "[image]"

    rewritten = DATA_IMAGE_RE.sub(_replace, text)
    return LEFT_OVER_DATA_URL_RE.sub("[image]", rewritten)


def resolve_image_refs(text: str) -> list[str]:
    """Base64 payloads for every image marker in ``text``, in order.

    Inline data URLs (the turn being sent right now) pass straight through;
    stored references are read back from ``ATTACHMENTS_DIR`` (replayed history).
    Markers that cannot be resolved are dropped rather than sent as garbage.
    """
    if not text or "[image:" not in text:
        return []
    payloads: list[str] = []
    for match in ANY_IMAGE_RE.finditer(text):
        if match.group(2):
            payloads.append(match.group(2))
            continue
        stored = load_attachment_b64(match.group(3))
        if stored:
            payloads.append(stored)
    return payloads


def image_data_urls(text: str) -> list[str]:
    """Every image in ``text`` as a data URL, in order.

    For callers that need the bytes rather than the reference — the chat
    pipeline's "describe this image" stage, which is how a *non-vision* chat
    model gets to know about a picture the user attached. Stored references are
    re-encoded here, so a re-sent or regenerated message still works.
    """
    if not text or "[image:" not in text:
        return []
    urls: list[str] = []
    for match in ANY_IMAGE_RE.finditer(text):
        subtype, inline, name = match.group(1), match.group(2), match.group(3)
        if inline:
            urls.append(f"data:image/{subtype.lower()};base64,{inline}")
            continue
        stored = load_attachment_b64(name)
        if stored:
            ext = Path(name).suffix.lower().lstrip(".")
            urls.append(f"data:image/{'jpeg' if ext == 'jpg' else ext};base64,{stored}")
    return urls


def load_attachment_b64(filename: str) -> str | None:
    """Read one stored attachment back as base64, or None if it is gone."""
    path = attachment_path(filename)
    if path is None or not path.is_file():
        return None
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    if not raw or len(raw) > MAX_ATTACHMENT_BYTES:
        return None
    return base64.b64encode(raw).decode()


def strip_image_markers(text: str) -> str:
    """Remove every image marker — used for memory extraction, titles and
    anything else that only wants the words."""
    if not text or "[image" not in text:
        return text
    return IMAGE_MARKER_RE.sub("", text).strip()
