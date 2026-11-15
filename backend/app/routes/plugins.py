"""Plugin routes — mirrors backend/src/routes/plugins.ts."""

from __future__ import annotations

import ipaddress

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..logger import error as log_error, warn as log_warn
from ..services.plugins.catalog import CATALOG_REPO, fetch_plugin_catalog, is_catalog_source
from ..services.plugins.manager import (
    install_plugin,
    install_local_ui,
    list_plugins,
    list_plugin_modes,
    set_plugin_enabled,
    uninstall_plugin,
    update_plugin,
)
from ..tools import get_all_tools

router = APIRouter()


def _is_local(request: Request) -> bool:
    try:
        return bool(request.client and ipaddress.ip_address(request.client.host).is_loopback)
    except ValueError:
        return False


def _management_allowed(request: Request) -> bool:
    # Plugin management is performed by the local Server App. The backend's
    # legacy admin check is intentionally open, and a loopback check alone
    # would allow a website to submit cross-origin requests from a browser.
    return _is_local(request) and not request.headers.get("origin")


def _management_denied() -> JSONResponse:
    return JSONResponse({"error": "Manage plugins from the Server App on the server computer"}, status_code=403)


@router.get("/modes")
async def modes() -> dict:
    return {"modes": await list_plugin_modes()}


@router.get("")
async def list_installed(request: Request) -> dict:
    try:
        installed = await list_plugins()
        tools = get_all_tools()
        by_plugin = [t for t in tools if t.pluginId]
        result = []
        for p in installed:
            registered = [t for t in by_plugin if t.pluginId == p["id"]]
            public_plugin = dict(p)
            if not _is_local(request):
                public_plugin.pop("localPath", None)
            result.append({**public_plugin, "registeredTools": registered})
        return {"plugins": result}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e) or "Failed to list plugins"}, status_code=500)


@router.get("/catalog")
async def catalog() -> dict:
    try:
        catalog_data = await fetch_plugin_catalog()
        installed = await list_plugins()
        installed_by_id = {p["id"]: p for p in installed}
        plugins_out = []
        for e in catalog_data["entries"]:
            inst = installed_by_id.get(e["id"])
            plugins_out.append(
                {
                    **e,
                    "installed": inst is not None,
                    "installedVersion": (inst or {}).get("manifest", {}).get("version"),
                    "enabled": (inst or {}).get("enabled"),
                }
            )
        return {"repo": catalog_data["repo"], "plugins": plugins_out}
    except Exception as e:  # noqa: BLE001
        msg = str(e) or "Failed to load plugin catalog"
        log_error("[plugins] Catalog error:", msg)
        return JSONResponse({"error": msg, "repo": CATALOG_REPO}, status_code=500)


@router.post("/install")
async def install(request: Request) -> dict:
    if not _management_allowed(request):
        return _management_denied()
    try:
        body = await request.json()
        repo = body.get("repo") if isinstance(body.get("repo"), str) else ""
        repo = repo.strip()
        if not repo:
            return JSONResponse({"error": 'repo is required (e.g. "owner/repo")'}, status_code=400)
        catalog_data = await fetch_plugin_catalog()
        if not is_catalog_source(catalog_data["entries"], repo):
            log_warn(f"[plugins] Install blocked: {repo} is not in the curated catalog")
            return JSONResponse(
                {"error": f'Install blocked: "{repo}" is not in the official plugin catalog ({CATALOG_REPO}). Only plugins listed in the catalog can be installed.'},
                status_code=403,
            )
        plugin = await install_plugin(repo)
        return {"success": True, "plugin": plugin}
    except Exception as e:  # noqa: BLE001
        msg = str(e) or "Install failed"
        log_error("[plugins] Install error:", msg)
        return JSONResponse({"error": msg}, status_code=400)


@router.post("/install-local-ui")
async def install_local(request: Request) -> dict:
    # Settings authentication is currently disabled, so a local filesystem
    # path must never be accepted from another computer on the network.
    if not _management_allowed(request):
        return _management_denied()
    try:
        body = await request.json()
        folder = body.get("path") if isinstance(body, dict) else None
        plugin = await install_local_ui(folder)
        return {"success": True, "plugin": plugin}
    except (ValueError, OSError, UnicodeError) as error:
        return JSONResponse({"error": str(error)}, status_code=400)


@router.post("/{plugin_id}/uninstall")
async def uninstall(plugin_id: str, request: Request) -> dict:
    if not _management_allowed(request):
        return _management_denied()
    try:
        return await uninstall_plugin(plugin_id)
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e) or "Uninstall failed"}, status_code=400)


@router.post("/{plugin_id}/toggle")
async def toggle(plugin_id: str, request: Request) -> dict:
    if not _management_allowed(request):
        return _management_denied()
    try:
        body = await request.json()
        enabled = bool(body.get("enabled"))
        plugin = await set_plugin_enabled(plugin_id, enabled)
        return {"success": True, "plugin": plugin}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e) or "Toggle failed"}, status_code=400)


@router.post("/{plugin_id}/update")
async def update(plugin_id: str, request: Request) -> dict:
    if not _management_allowed(request):
        return _management_denied()
    try:
        plugin = await update_plugin(plugin_id)
        return {"success": True, "plugin": plugin}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e) or "Update failed"}, status_code=400)
