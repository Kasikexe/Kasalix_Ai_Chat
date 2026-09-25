"""Plugin Platform — shared types (mirrors backend/src/services/plugins/types.ts).

A plugin is a GitHub repository (or subfolder of one) that ships a
`plugin.json` manifest and an optional entry file that registers tools
with the backend at runtime. Plugins extend what the AI can do:
new tools, new agent capabilities, integrations (Roblox, voice, etc.).
"""

from __future__ import annotations

from typing import Any, TypedDict


class PluginManifest(TypedDict, total=False):
    id: str
    name: str
    version: str
    description: str
    author: str
    icon: str
    minKasalixVersion: str
    entry: str


class InstalledPlugin(TypedDict, total=False):
    id: str
    manifest: PluginManifest
    repo: str
    path: str
    branch: str
    enabled: bool
    installedAt: int
    updatedAt: int
    toolIds: list[str]


class PluginRegistry(TypedDict, total=False):
    installed: list[InstalledPlugin]


ID_RE_PATTERN = r"^[a-z0-9][a-z0-9-]*$"


def is_valid_plugin_id(id: str) -> bool:
    import re

    return bool(re.match(ID_RE_PATTERN, id))