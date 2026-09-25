"""Plugin Platform — manager (mirrors backend/src/services/plugins/manager.ts).

Installs plugins from GitHub into the data directory, persists the
registry (data/plugins/installed.json), and loads each plugin's entry
file at runtime to register its tools with the shared tool registry.

SECURITY: installing a plugin downloads and executes code from the
internet. All mutations are admin-only (settings_auth cookie), and the
UI warns the user before installing.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any

from ...config import app_version, get_data_dir
from ...logger import error as log_error, info as log_info, warn as log_warn
from ...tools import (
    ToolDefinition,
    is_tool_registered,
    register_tool,
    unregister_tool,
)
from .github import download_raw_file, fetch_repo_tree, parse_repo_input, resolve_repo
from .types import ID_RE_PATTERN, InstalledPlugin, PluginRegistry

# ─── Serialize mutations ───────────────────────────────────
_lock = asyncio.Lock()


def get_plugins_dir() -> str:
    return str(Path(get_data_dir()) / "plugins")


def get_registry_file() -> str:
    return str(Path(get_plugins_dir()) / "installed.json")


def get_plugin_dir(id: str) -> str:
    return str(Path(get_plugins_dir()) / id)


async def read_registry() -> PluginRegistry:
    try:
        parsed = json.loads(Path(get_registry_file()).read_text(encoding="utf-8"))
        return {"installed": parsed.get("installed") if isinstance(parsed.get("installed"), list) else []}
    except (OSError, json.JSONDecodeError):
        return {"installed": []}


async def write_registry(registry: PluginRegistry) -> None:
    Path(get_plugins_dir()).mkdir(parents=True, exist_ok=True)
    Path(get_registry_file()).write_text(json.dumps(registry, indent=2), encoding="utf-8")


# ─── Manifest validation ──────────────────────────────────
def parse_manifest(raw: str) -> dict[str, Any]:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError("plugin.json is not valid JSON")
    if not isinstance(data, dict):
        raise ValueError("plugin.json must be an object")
    id_ = str(data.get("id") or "").strip()
    name = str(data.get("name") or "").strip()
    version = str(data.get("version") or "").strip()
    if not re.match(ID_RE_PATTERN, id_):
        raise ValueError('Invalid plugin id — use lowercase letters, numbers and dashes (e.g. "roblox-maker")')
    if not name:
        raise ValueError('plugin.json is missing "name"')
    if not version:
        raise ValueError('plugin.json is missing "version"')
    if len(version) > 40:
        raise ValueError("Plugin version is too long")
    description = str(data.get("description") or "")[:500]
    # Entry must stay inside the plugin folder — no traversal
    entry = str(data.get("entry") or "index.py").strip() if data.get("entry") else "index.py"
    if ".." in entry or entry.startswith("/") or entry.startswith("\\") or ":" in entry:
        raise ValueError("Invalid entry path in plugin.json")
    return {
        "id": id_,
        "name": name,
        "version": version,
        "description": description,
        "author": str(data.get("author"))[:100] if data.get("author") else None,
        "icon": str(data.get("icon"))[:20] if data.get("icon") else None,
        "minKasalixVersion": str(data.get("minKasalixVersion"))[:30] if data.get("minKasalixVersion") else None,
        "entry": entry,
    }


def check_min_version(manifest: dict[str, Any]) -> None:
    min_version = manifest.get("minKasalixVersion")
    if not min_version:
        return
    min_v = re.sub(r"^v", "", min_version, flags=re.I)
    cur = re.sub(r"^v", "", app_version(), flags=re.I)

    def to_num(v: str) -> int:
        parts = [int(x) if x.isdigit() else 0 for x in v.split(".")]
        return parts[0] * 1000000 + (parts[1] if len(parts) > 1 else 0) * 1000 + (parts[2] if len(parts) > 2 else 0)

    if to_num(cur) < to_num(min_v):
        raise ValueError(
            f"This plugin requires Kasalix v{min_version} — this server is v{app_version()}. Update the server first."
        )


# ─── Entry loading ────────────────────────────────────────
class PluginApi:
    def __init__(self, plugin: InstalledPlugin, enabled: bool, tool_ids: list[str]) -> None:
        self._plugin = plugin
        self._enabled = enabled
        self._tool_ids = tool_ids

    def register_tool(self, definition: Any, execute: Any) -> None:
        if not self._enabled:
            return  # disabled plugins must not register tools
        if isinstance(definition, ToolDefinition):
            with_plugin = ToolDefinition(
                id=definition.id,
                name=definition.name,
                description=definition.description,
                version=definition.version,
                icon=definition.icon,
                params=definition.params,
                keywords=definition.keywords,
                pluginId=self._plugin["id"],
            )
        else:
            # Dict-shaped definition from a plugin
            with_plugin = ToolDefinition(
                id=definition.get("id", ""),
                name=definition.get("name", definition.get("id", "")),
                description=definition.get("description", ""),
                version=definition.get("version", "1.0.0"),
                icon=definition.get("icon", "🔧"),
                params=definition.get("params", []),
                keywords=definition.get("keywords", []),
                pluginId=self._plugin["id"],
            )
        if with_plugin.id not in self._tool_ids:
            self._tool_ids.append(with_plugin.id)
        register_tool(with_plugin, execute)

    def get_data_dir(self) -> str:
        return str(get_data_dir())


async def load_plugin_entry(
    plugin: InstalledPlugin,
    opts: dict[str, Any] | None = None,
) -> list[str]:
    opts = opts or {}
    dir_path = opts.get("dirOverride") or get_plugin_dir(plugin["id"])
    entry_rel = plugin.get("manifest", {}).get("entry") or "index.py"
    entry_path = os.path.join(dir_path, entry_rel)
    if not os.path.isfile(entry_path):
        log_warn(f"[plugins] {plugin['id']}: entry \"{entry_rel}\" not found — no tools registered")
        return []
    enabled = opts.get("enabled", plugin.get("enabled", True))
    tool_ids: list[str] = []
    api = PluginApi(plugin, enabled, tool_ids)

    try:
        # Cache-busting: unique module name per load
        module_name = f"kasalix_plugin_{plugin['id']}_{int(time.time() * 1000)}"
        spec = importlib.util.spec_from_file_location(module_name, entry_path)
        if spec is None or spec.loader is None:
            raise ValueError(f"Could not load entry \"{entry_rel}\"")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        register_fn = getattr(module, "register", None)
        if register_fn is None and getattr(module, "default", None) is not None:
            default = module.default
            register_fn = getattr(default, "register", None) or (default if callable(default) else None)
        if not callable(register_fn):
            raise ValueError(f'Entry "{entry_rel}" must export a register(api) function')
        result = register_fn(api)
        if hasattr(result, "__await__"):
            await result
    except Exception as err:  # noqa: BLE001
        msg = str(err)
        for tid in tool_ids:
            unregister_tool(tid)
        raise ValueError(f'Failed to load plugin "{plugin["id"]}": {msg}')
    return tool_ids


def clear_plugin_tools(plugin: InstalledPlugin) -> None:
    for tid in plugin.get("toolIds") or []:
        if is_tool_registered(tid):
            unregister_tool(tid)
    plugin["toolIds"] = []


# ─── Public API ───────────────────────────────────────────
async def list_plugins() -> list[InstalledPlugin]:
    registry = await read_registry()
    return registry["installed"]


async def install_plugin(input: str) -> InstalledPlugin:
    async with _lock:
        parsed = parse_repo_input(input)
        owner, repo, subdir = parsed["owner"], parsed["repo"], parsed.get("path") or ""
        branch = await resolve_repo({"owner": owner, "repo": repo})

        files = await fetch_repo_tree({"owner": owner, "repo": repo, "branch": branch, "path": subdir})
        prefix = subdir.strip("/") + "/" if subdir else ""
        manifest_rel = prefix + "plugin.json" if prefix else "plugin.json"
        if manifest_rel not in files:
            raise ValueError(f"No plugin.json found in {owner}/{repo}{'/' + subdir if subdir else ''}")
        manifest_raw = await download_raw_file(owner, repo, branch, manifest_rel)
        if not manifest_raw:
            raise ValueError("Could not download plugin.json")
        manifest = parse_manifest(manifest_raw)
        check_min_version(manifest)

        # Download into a TEMP dir first so a failed install never destroys
        # the currently-working plugin (atomic install).
        dir_path = get_plugin_dir(manifest["id"])
        tmp_dir = dir_path + ".tmp"
        shutil.rmtree(tmp_dir, ignore_errors=True)
        os.makedirs(tmp_dir, exist_ok=True)
        try:
            for file in files:
                rel = file[len(prefix):] if prefix else file
                if not rel or rel == "plugin.json":
                    continue
                if ".." in rel or os.path.isabs(rel):
                    continue
                content = await download_raw_file(owner, repo, branch, file)
                if content is None:
                    continue
                dest = os.path.join(tmp_dir, rel)
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, "w", encoding="utf-8") as f:
                    f.write(content)
        except Exception:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            raise

        registry = await read_registry()
        existing_idx = next((i for i, p in enumerate(registry["installed"]) if p["id"] == manifest["id"]), -1)
        now = int(time.time() * 1000)
        plugin: InstalledPlugin = {
            "id": manifest["id"],
            "manifest": manifest,
            "repo": f"{owner}/{repo}",
            "path": subdir or None,
            "branch": branch,
            "enabled": registry["installed"][existing_idx]["enabled"] if existing_idx >= 0 else True,
            "installedAt": registry["installed"][existing_idx]["installedAt"] if existing_idx >= 0 else now,
            "updatedAt": now,
            "toolIds": [],
        }

        try:
            plugin["toolIds"] = await load_plugin_entry(plugin, {"enabled": plugin["enabled"], "dirOverride": tmp_dir})
        except Exception:
            shutil.rmtree(tmp_dir, ignore_errors=True)
            raise

        if existing_idx >= 0:
            clear_plugin_tools(registry["installed"][existing_idx])
            registry["installed"][existing_idx] = plugin
        else:
            registry["installed"].append(plugin)
        shutil.rmtree(dir_path, ignore_errors=True)
        os.rename(tmp_dir, dir_path)
        await write_registry(registry)
        log_info(
            f"[plugins] {'Updated' if existing_idx >= 0 else 'Installed'} {manifest['name']} ({manifest['id']}) — {len(plugin['toolIds'])} tool(s)"
        )
        return plugin


async def uninstall_plugin(id: str) -> dict[str, bool]:
    async with _lock:
        if not re.match(ID_RE_PATTERN, id):
            raise ValueError("Invalid plugin id")
        registry = await read_registry()
        idx = next((i for i, p in enumerate(registry["installed"]) if p["id"] == id), -1)
        if idx < 0:
            raise ValueError(f'Plugin "{id}" is not installed')
        plugin = registry["installed"][idx]
        clear_plugin_tools(plugin)
        registry["installed"].pop(idx)
        await write_registry(registry)
        shutil.rmtree(get_plugin_dir(id), ignore_errors=True)
        log_info(f"[plugins] Uninstalled {plugin['manifest']['name']} ({id})")
        return {"success": True}


async def set_plugin_enabled(id: str, enabled: bool) -> InstalledPlugin:
    async with _lock:
        registry = await read_registry()
        plugin = next((p for p in registry["installed"] if p["id"] == id), None)
        if not plugin:
            raise ValueError(f'Plugin "{id}" is not installed')
        plugin["enabled"] = bool(enabled)
        plugin["updatedAt"] = int(time.time() * 1000)
        if plugin["enabled"]:
            plugin["toolIds"] = await load_plugin_entry(plugin, {"enabled": True})
        else:
            clear_plugin_tools(plugin)
        await write_registry(registry)
        log_info(f"[plugins] {plugin['manifest']['name']} ({id}) {'enabled' if enabled else 'disabled'}")
        return plugin


async def update_plugin(id: str) -> InstalledPlugin:
    registry = await read_registry()
    plugin = next((p for p in registry["installed"] if p["id"] == id), None)
    if not plugin:
        raise ValueError(f'Plugin "{id}" is not installed')
    async with _lock:
        try:
            source = f"{plugin['repo']}{'/' + plugin['path'] if plugin.get('path') else ''}"
            return await install_plugin(source)
        except Exception as err:  # noqa: BLE001
            raise ValueError(f"Update failed: {err}") from err


async def load_installed_plugins() -> int:
    registry = await read_registry()
    loaded = 0
    changed = False
    for plugin in registry["installed"]:
        if not plugin.get("enabled"):
            continue
        try:
            plugin["toolIds"] = await load_plugin_entry(plugin, {"enabled": True})
            changed = True
            loaded += 1
        except Exception as err:  # noqa: BLE001
            log_error(f'[plugins] Failed to load "{plugin["id"]}" on startup:', err)
    if changed:
        await write_registry(registry)
    if registry["installed"]:
        log_info(f"[plugins] Loaded {loaded}/{len(registry['installed'])} installed plugin(s)")
    return loaded