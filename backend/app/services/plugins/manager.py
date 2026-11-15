"""Plugin installation, metadata, and permission management.

Plugin Python is never imported into the server. Optional UI-plugin backend
actions run only through the isolated runtime after local approval. Legacy
executable tool plugins remain installed but their code is not executed.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any

from ...config import app_version, get_data_dir
from ...logger import error as log_error, info as log_info, warn as log_warn
from ...tools import get_all_tools, unregister_tool
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
    kind = data.get("kind", "tool")
    if kind not in ("tool", "ui", "backend"):
        raise ValueError('Plugin kind must be "ui", "backend", or "tool"')
    modes = []
    backend = data.get("backend")
    if backend is not None:
        if kind not in ("ui", "backend") or not isinstance(backend, dict):
            raise ValueError("Invalid backend action definition")
        entry = backend.get("entry")
        if not isinstance(entry, str) or not re.fullmatch(r"[a-zA-Z0-9_-]+\.py", entry):
            raise ValueError("Backend entry must be a Python file in the plugin folder")
        actions = backend.get("actions")
        permissions = backend.get("permissions", [])
        if not isinstance(actions, list) or not 1 <= len(actions) <= 32 or any(
            not isinstance(action, str) or not re.fullmatch(ID_RE_PATTERN, action) or len(action) > 60 for action in actions
        ) or len(actions) != len(set(actions)):
            raise ValueError("Backend actions must have unique lowercase ids")
        allowed = {"storage.read", "storage.write"}
        if not isinstance(permissions, list) or any(not isinstance(p, str) or p not in allowed for p in permissions) or len(permissions) != len(set(permissions)):
            raise ValueError("Unknown or duplicate backend permission")
        if "storage.write" in permissions and "storage.read" not in permissions:
            raise ValueError("storage.write also requires storage.read")
        backend = {"entry": entry, "actions": actions, "permissions": permissions}
    if kind == "backend" and not backend:
        raise ValueError("Backend plugins must declare backend actions")
    if kind in ("ui", "backend") and data.get("entry"):
        raise ValueError("Use backend.entry for isolated code; top-level entry is not allowed")
    if kind == "ui":
        raw_modes = data.get("modes")
        if not isinstance(raw_modes, list) or not 1 <= len(raw_modes) <= 12:
            raise ValueError("UI plugins must define between 1 and 12 modes")
        seen_ids: set[str] = set()
        for mode in raw_modes:
            if not isinstance(mode, dict):
                raise ValueError("Each mode must be an object")
            mode_id, mode_name = mode.get("id"), mode.get("name")
            if not isinstance(mode_id, str) or not re.fullmatch(ID_RE_PATTERN, mode_id) or len(mode_id) > 60 or mode_id in seen_ids:
                raise ValueError("Each mode needs a unique lowercase id")
            if not isinstance(mode_name, str) or not mode_name.strip() or len(mode_name) > 60:
                raise ValueError("Each mode needs a name of at most 60 characters")
            seen_ids.add(mode_id)
            base = mode.get("baseMode", "chat")
            if base not in ("chat", "agent"):
                raise ValueError('baseMode must be "chat" or "agent"')
            memory = mode.get("memory", "none")
            if memory not in ("none", "per-item"):
                raise ValueError('Mode memory must be "none" or "per-item"')
            theme = mode.get("theme", {})
            if not isinstance(theme, dict) or any(
                key not in ("accent", "background", "surface", "text")
                or not isinstance(value, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", value)
                for key, value in theme.items()
            ):
                raise ValueError("Theme colors must be six-digit hex values")
            welcome = mode.get("welcome", {})
            if not isinstance(welcome, dict) or welcome.get("type", "card-list") != "card-list":
                raise ValueError("Only card-list welcome screens are supported")
            title = welcome.get("title", mode_name)
            description = welcome.get("description", "")
            items = welcome.get("items", [])
            if not isinstance(title, str) or not title.strip() or len(title) > 120 or not isinstance(description, str) or len(description) > 500:
                raise ValueError("Invalid welcome title or description")
            if not isinstance(items, list) or len(items) > 50:
                raise ValueError("Welcome items must be a list of at most 50 cards")
            normalized_items = []
            item_ids: set[str] = set()
            for item in items:
                if not isinstance(item, dict):
                    raise ValueError("Each welcome card must be an object")
                item_id, label = item.get("id"), item.get("label")
                if not isinstance(item_id, str) or not re.fullmatch(ID_RE_PATTERN, item_id) or len(item_id) > 60 or item_id in item_ids:
                    raise ValueError("Each card needs a unique lowercase id")
                if not isinstance(label, str) or not label.strip() or len(label) > 100:
                    raise ValueError("Each card needs a label of at most 100 characters")
                item_ids.add(item_id)
                text, message, instructions = item.get("description", ""), item.get("message", ""), item.get("instructions", "")
                if not isinstance(text, str) or len(text) > 500 or not isinstance(message, str) or len(message) > 4000 or not isinstance(instructions, str) or len(instructions) > 4000:
                    raise ValueError("Invalid card description, message, or instructions")
                action, payload = item.get("backendAction"), item.get("payload", {})
                if action is not None and (not isinstance(action, str) or not backend or action not in backend["actions"] or message):
                    raise ValueError("Card backendAction must name a declared action and cannot be combined with message")
                try:
                    payload_size = len(json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")) if isinstance(payload, dict) else 8193
                except (TypeError, ValueError, RecursionError):
                    payload_size = 8193
                if payload_size > 8192:
                    raise ValueError("Invalid card action payload")
                normalized_items.append({"id": item_id, "label": label.strip(), "description": text, "message": message, "instructions": instructions,
                                         "backendAction": action, "payload": payload})
            modes.append({"id": mode_id, "name": mode_name.strip(), "baseMode": base, "memory": memory, "theme": theme,
                          "welcome": {"type": "card-list", "title": title, "description": description, "items": normalized_items}})
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
        "kind": kind,
        "entry": entry if kind == "tool" else None,
        "modes": modes,
        "backend": backend,
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
async def load_plugin_entry(
    plugin: InstalledPlugin,
    opts: dict[str, Any] | None = None,
) -> list[str]:
    opts = opts or {}
    if plugin.get("manifest", {}).get("kind") == "tool":
        log_warn(f"[plugins] {plugin['id']}: legacy executable tools are disabled; migrate to isolated backend actions")
    # Never import plugin Python into the server process. UI backend actions
    # execute only when invoked through the isolated runner.
    return []


def backend_source(folder: str, manifest: dict[str, Any]) -> tuple[str, str] | None:
    backend = manifest.get("backend")
    if not backend:
        return None
    root = Path(folder).resolve(strict=True)
    entry = (root / backend["entry"]).resolve(strict=True)
    if entry.parent != root or not entry.is_file() or entry.stat().st_size > 256_000:
        raise ValueError("Backend entry must be a Python file under 256 KB inside the plugin folder")
    with entry.open("rb") as file:
        raw = file.read(256_001)
    if len(raw) > 256_000:
        raise ValueError("Backend entry must be under 256 KB")
    try:
        source = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ValueError("Backend entry must be UTF-8") from error
    metadata = json.dumps({"backend": backend, "source": hashlib.sha256(raw).hexdigest()}, sort_keys=True, separators=(",", ":"))
    return source, hashlib.sha256(metadata.encode("utf-8")).hexdigest()


def clear_plugin_tools(plugin: InstalledPlugin) -> None:
    for tid in plugin.get("toolIds") or []:
        if any(tool.id == tid and tool.pluginId == plugin["id"] for tool in get_all_tools()):
            unregister_tool(tid)
    plugin["toolIds"] = []


# ─── Public API ───────────────────────────────────────────
async def list_plugins() -> list[InstalledPlugin]:
    registry = await read_registry()
    return registry["installed"]


async def list_plugin_modes() -> list[dict[str, Any]]:
    modes: list[dict[str, Any]] = []
    for plugin in await list_plugins():
        manifest = plugin.get("manifest") or {}
        if not plugin.get("enabled") or manifest.get("kind") != "ui":
            continue
        # Validate persisted data too, so older or manually edited registries
        # cannot inject unsafe styles or unsupported component definitions.
        try:
            manifest = parse_manifest(json.dumps(manifest))
        except (TypeError, ValueError):
            continue
        if manifest["id"] != plugin.get("id"):
            continue
        for mode in manifest["modes"]:
            modes.append({**mode, "id": f"plugin:{plugin['id']}:{mode['id']}", "pluginId": plugin["id"]})
    return modes


async def install_local_ui(folder: str, expected_id: str | None = None) -> InstalledPlugin:
    """Register a local manifest without importing or copying plugin code."""
    if not isinstance(folder, str) or not os.path.isabs(folder):
        raise ValueError("Provide an absolute path to a plugin folder")
    directory = Path(folder).resolve(strict=True)
    manifest_path = directory / "plugin.json"
    if not directory.is_dir() or not manifest_path.is_file() or manifest_path.stat().st_size > 256_000:
        raise ValueError("Plugin folder must contain a plugin.json under 256 KB")
    manifest = parse_manifest(manifest_path.read_text(encoding="utf-8"))
    if manifest["kind"] not in ("ui", "backend"):
        raise ValueError("Only UI or isolated backend plugins can be loaded from a local folder")
    if expected_id is not None and manifest["id"] != expected_id:
        raise ValueError("A plugin's id cannot change during an update")
    check_min_version(manifest)
    source = backend_source(str(directory), manifest)
    fingerprint = source[1] if source else None
    async with _lock:
        registry = await read_registry()
        existing = next((p for p in registry["installed"] if p["id"] == manifest["id"]), None)
        if existing and existing.get("localPath") != str(directory):
            raise ValueError("A different plugin with this id is already installed")
        now = int(time.time() * 1000)
        plugin: InstalledPlugin = {"id": manifest["id"], "manifest": manifest, "localPath": str(directory),
                                   "enabled": existing.get("enabled", True) if existing else True,
                                   "installedAt": existing.get("installedAt", now) if existing else now,
                                   "updatedAt": now, "toolIds": []}
        if fingerprint:
            plugin["backendFingerprint"] = fingerprint
            if existing and existing.get("approvedFingerprint") == fingerprint:
                plugin["approvedFingerprint"] = fingerprint
                plugin["grantedPermissions"] = existing.get("grantedPermissions", [])
        if existing:
            registry["installed"][registry["installed"].index(existing)] = plugin
        else:
            registry["installed"].append(plugin)
        await write_registry(registry)
        return plugin


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
            source = backend_source(tmp_dir, manifest)
            if source:
                plugin["backendFingerprint"] = source[1]
                previous = registry["installed"][existing_idx] if existing_idx >= 0 else None
                if previous and previous.get("approvedFingerprint") == source[1]:
                    plugin["approvedFingerprint"] = source[1]
                    plugin["grantedPermissions"] = previous.get("grantedPermissions", [])
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


async def set_backend_permissions(id: str, approved: bool, grants: list[str]) -> InstalledPlugin:
    async with _lock:
        registry = await read_registry()
        plugin = next((p for p in registry["installed"] if p["id"] == id), None)
        if not plugin or not plugin.get("manifest", {}).get("backend"):
            raise ValueError("Plugin has no backend actions")
        if not approved:
            plugin["approvedFingerprint"] = None
            plugin["grantedPermissions"] = []
            plugin["updatedAt"] = int(time.time() * 1000)
            await write_registry(registry)
            return plugin
        declared = plugin["manifest"]["backend"]["permissions"]
        if not isinstance(grants, list) or any(not isinstance(item, str) or item not in declared for item in grants) or len(grants) != len(set(grants)):
            raise ValueError("Grants must be requested permissions")
        if "storage.write" in grants and "storage.read" not in grants:
            raise ValueError("storage.write also requires storage.read")
        source = backend_source(plugin.get("localPath") or get_plugin_dir(id), plugin["manifest"])
        if not source or source[1] != plugin.get("backendFingerprint"):
            raise ValueError("Plugin code changed; reload the plugin before reviewing permissions")
        plugin["approvedFingerprint"] = source[1]
        plugin["grantedPermissions"] = grants
        plugin["updatedAt"] = int(time.time() * 1000)
        await write_registry(registry)
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
        if not plugin.get("localPath"):
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
    try:
        if plugin.get("localPath"):
            return await install_local_ui(plugin["localPath"], id)
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
