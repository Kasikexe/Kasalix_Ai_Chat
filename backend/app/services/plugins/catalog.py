"""Plugin Platform — curated catalog (mirrors backend/src/services/plugins/catalog.ts).

The Plugins tab shows ONLY plugins from the official catalog repo
(Kasikexe/Kasalix-AI-Plugins by default, overridable via
PLUGIN_CATALOG_REPO). This keeps the plugin surface safe: the host browses
and installs only our own plugins instead of arbitrary third-party repos.

The catalog repo ships a `catalog.json` at its root:

  { "plugins": [
      { "id": "my-tool", "name": "My Tool", "version": "1.0.0",
        "description": "...", "author": "...", "icon": "🧰",
        "minKasalixVersion": "0.11.0",
        "source": "Kasikexe/Kasalix-AI-Plugins/plugins/my-tool" }
    ] }

`source` is an install input the existing install_plugin() already
understands ("owner/repo" or "owner/repo/subdir"). The install route gates
on this list, so only catalog entries can ever be installed.
"""

from __future__ import annotations

import os
import re
from typing import Any

from .github import download_raw_file, resolve_repo
from .types import PluginManifest

CATALOG_REPO = os.environ.get("PLUGIN_CATALOG_REPO") or "Kasikexe/Kasalix-AI-Plugins"

ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def parse_catalog(raw: str) -> list[dict[str, Any]]:
    import json

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError("catalog.json is not valid JSON")
    if not isinstance(data, dict) or not isinstance(data.get("plugins"), list):
        raise ValueError('catalog.json must be an object with a "plugins" array')
    entries: list[dict[str, Any]] = []
    for p in data["plugins"]:
        if not isinstance(p, dict):
            continue
        id_ = p.get("id") if isinstance(p.get("id"), str) else ""
        name = p.get("name") if isinstance(p.get("name"), str) else ""
        version = p.get("version") if isinstance(p.get("version"), str) else ""
        source = p.get("source") if isinstance(p.get("source"), str) else ""
        id_ = id_.strip()
        name = name.strip()
        version = version.strip()
        source = source.strip()
        if not ID_RE.match(id_) or not name or not version or not source:
            continue
        entries.append(
            {
                "id": id_,
                "name": name,
                "version": version,
                "description": p.get("description") if isinstance(p.get("description"), str) else "",
                "author": p.get("author") if isinstance(p.get("author"), str) else None,
                "icon": p.get("icon") if isinstance(p.get("icon"), str) else None,
                "minKasalixVersion": p.get("minKasalixVersion") if isinstance(p.get("minKasalixVersion"), str) else None,
                "source": source,
            }
        )
    return entries


def normalize_source(s: str) -> str:
    return s.strip().lower().rstrip("/")


def is_catalog_source(entries: list[dict[str, Any]], input: str) -> bool:
    needle = normalize_source(input)
    return any(normalize_source(e["source"]) == needle for e in entries)


async def fetch_plugin_catalog() -> dict[str, Any]:
    parts = CATALOG_REPO.split("/")
    if len(parts) != 2 or not parts[0] or not parts[1]:
        raise ValueError(f"Invalid catalog repo: {CATALOG_REPO}")
    owner, repo = parts
    branch = await resolve_repo({"owner": owner, "repo": repo})
    raw = await download_raw_file(owner, repo, branch, "catalog.json")
    if raw is None:
        raise ValueError(
            f"No catalog.json found in {CATALOG_REPO}. Create the repo with a catalog.json listing your plugins."
        )
    return {"repo": CATALOG_REPO, "entries": parse_catalog(raw)}


def manifest_from_catalog_entry(e: dict[str, Any]) -> PluginManifest:
    return {
        "id": e["id"],
        "name": e["name"],
        "version": e["version"],
        "description": e.get("description", ""),
        "author": e.get("author"),
        "icon": e.get("icon"),
        "minKasalixVersion": e.get("minKasalixVersion"),
    }