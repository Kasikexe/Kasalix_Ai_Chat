"""GET /api/attachments/{filename} — images attached to chat messages.

Content-addressed files written by :mod:`app.attachments` when a client sends an
image. Session-protected (see ``SESSION_PROTECTED_PATHS``) because these are the
user's own pictures, unlike the open generated-artwork route. Names are
validated against a strict pattern, so no request can escape the directory.
"""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse, Response

from ..attachments import attachment_path, content_type_for

router = APIRouter()


@router.get("/{filename}")
async def get_attachment(filename: str) -> Response:
    path = attachment_path(filename)
    if path is None:
        return JSONResponse({"error": "Invalid filename"}, status_code=400)
    try:
        data = path.read_bytes()
    except OSError:
        return JSONResponse({"error": "Image not found"}, status_code=404)
    headers = {
        "Content-Type": content_type_for(filename),
        # Content-addressed → a name always maps to the same bytes.
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    }
    return Response(content=data, headers=headers)
