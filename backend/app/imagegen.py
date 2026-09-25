"""AI Artwork service — mirrors backend/src/services/image-gen.ts.

The model plays the artist: it authors an SVG scene inside a draw_image tool
call, this module sanitizes it, saves it, and rasterizes it to a real PNG
(resvg-py). If rasterization is unavailable or resvg rejects the SVG, the file
is kept as SVG and callers fall back to it gracefully — generation still
succeeds.
"""

from __future__ import annotations

import hashlib
import re
import time
from pathlib import Path

from .config import get_generated_images_dir
from .logger import error as log_error, info as log_info, warn as log_warn

MAX_SVG_BYTES = 100 * 1024

# Reject anything that could execute or exfiltrate when the SVG is opened.
DANGEROUS_PATTERNS = [
    re.compile(r"<\s*script", re.IGNORECASE),
    re.compile(r"<\s*/\s*script", re.IGNORECASE),
    re.compile(r"on\w+\s*=", re.IGNORECASE),
    re.compile(r"javascript:", re.IGNORECASE),
    re.compile(r"<\s*foreignobject", re.IGNORECASE),
    re.compile(r"<\s*iframe", re.IGNORECASE),
    re.compile(r"<\s*object", re.IGNORECASE),
    re.compile(r"<\s*embed", re.IGNORECASE),
    re.compile(r"<\s*image\b", re.IGNORECASE),
    re.compile(r"\bhref\s*=", re.IGNORECASE),
    re.compile(r"xlink:href", re.IGNORECASE),
]


def sanitize_svg(svg: str) -> dict[str, object]:
    """Validate the model output is a single, safe SVG document.
    Returns {ok: True} or {ok: False, error: reason}."""
    if not isinstance(svg, str):
        return {"ok": False, "error": "svg must be a string."}
    svg = svg.strip()
    if not svg:
        return {"ok": False, "error": "svg is empty."}
    if len(svg.encode("utf-8")) > MAX_SVG_BYTES:
        return {
            "ok": False,
            "error": (
                f"SVG too large ({len(svg) // 1024} KB, max {MAX_SVG_BYTES // 1024} KB). "
                "Simplify the scene — fewer elements, shorter paths."
            ),
        }

    # Allow an optional XML prolog, then exactly one <svg> root.
    body = re.sub(r"^\s*<\?xml[^>]*\?>\s*", "", svg)
    open_tags = re.findall(r"<\s*svg[\s>]", body, re.IGNORECASE)
    if len(open_tags) != 1:
        return {"ok": False, "error": "The SVG must be a single document with exactly one <svg> root element."}
    root_open = open_tags[0]
    tag_name = re.sub(r"[^a-z]", "", root_open, flags=re.IGNORECASE) or "svg"
    if not re.search(rf"<\s*/\s*{tag_name}\s*>", body, re.IGNORECASE):
        return {"ok": False, "error": "The SVG is missing its closing </svg> tag."}

    for pattern in DANGEROUS_PATTERNS:
        if pattern.search(body):
            return {
                "ok": False,
                "error": (
                    "SVG contains disallowed content (scripts, event handlers, external references "
                    "or <image>). Only shapes, paths, gradients and defs are allowed."
                ),
            }
    return {"ok": True}


def _rasterize_to_png(svg: str) -> bytes | None:
    """Rasterize SVG → PNG via resvg-py. Returns None (never raises) so callers
    can fall back to serving the SVG."""
    try:
        import resvg_py  # type: ignore[import-untyped]
    except Exception as e:  # noqa: BLE001
        log_warn("[image] resvg module unavailable — falling back to SVG:", e)
        return None

    try:
        w_attr = re.search(r"<svg[^>]*\bwidth=[\"'](\d+(?:\.\d+)?)", svg, re.IGNORECASE)
        h_attr = re.search(r"<svg[^>]*\bheight=[\"'](\d+(?:\.\d+)?)", svg, re.IGNORECASE)

        def _num(m: re.Match[str] | None) -> float:
            return float(m.group(1)) if m else float("nan")

        w, h = _num(w_attr), _num(h_attr)
        declared_sane = w == w and h == h and 0 < w <= 2048 and 0 < h <= 2048

        kwargs: dict[str, object] = {}
        if not declared_sane:
            kwargs["svg_width"] = 1024
        png_bytes = resvg_py.svg_to_bytes(svg_string=svg, **kwargs)  # type: ignore[attr-defined]
        if isinstance(png_bytes, list):
            png_bytes = bytes(png_bytes)
        if (
            not png_bytes
            or len(png_bytes) < 8
            or png_bytes[0] != 0x89
            or png_bytes[1] != 0x50
        ):
            log_warn("[image] Rasterization produced an empty/odd PNG — falling back to SVG")
            return None
        return png_bytes
    except Exception as e:  # noqa: BLE001
        log_warn("[image] Rasterization failed — falling back to SVG:", e)
        return None


async def save_artwork(svg: str) -> dict[str, object]:
    """Sanitize-checked SVG in → files out. Saves <base>.svg always and
    <base>.png when rasterization succeeds. Raises only on filesystem errors."""
    gen_dir = get_generated_images_dir()
    Path(gen_dir).mkdir(parents=True, exist_ok=True)

    digest = hashlib.md5((svg + str(int(time.time() * 1000))).encode("utf-8")).hexdigest()[:8]
    base = f"img_{int(time.time() * 1000)}_{digest}"
    svg_filename = f"{base}.svg"
    svg_path = Path(gen_dir) / svg_filename
    svg_path.write_text(svg, encoding="utf-8")

    log_info(f"[image] Saved SVG artwork: {svg_filename} ({len(svg) / 1024:.1f} KB)")

    png = _rasterize_to_png(svg)
    if png is not None:
        png_filename = f"{base}.png"
        (Path(gen_dir) / png_filename).write_bytes(png)
        log_info(f"[image] Rasterized PNG: {png_filename} ({len(png) / 1024:.1f} KB)")
        return {"filename": png_filename, "svgFilename": svg_filename, "png": True}

    return {"filename": svg_filename, "svgFilename": svg_filename, "png": False}


def save_png_artwork(png: bytes, prefix: str = "img") -> str:
    """Save raw PNG bytes (e.g. from a diffusion engine) into the generated
    images dir. Returns the filename."""
    digest = hashlib.md5((str(int(time.time() * 1000)) + str(len(png))).encode("utf-8")).hexdigest()[:8]
    filename = f"{prefix}_{int(time.time() * 1000)}_{digest}.png"
    path = Path(get_generated_images_dir()) / filename
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(png)
    except Exception as e:  # noqa: BLE001
        log_error("[image] Failed to save PNG:", e)
        raise
    return filename
