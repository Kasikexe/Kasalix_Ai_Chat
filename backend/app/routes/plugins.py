"""Plugin routes — mirrors backend/src/routes/plugins.ts."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..deps import admin_authenticated
from ..logger import error as log_error, warn as log_warn
from ..services.plugins.catalog import CATALOG_REPO, fetch_plugin_catalog, is_catalog_source
from ..services.plugins.manager import (
    install_plugin,
    list_plugins,
    set_plugin_enabled,
    uninstall_plugin,
    update_plugin,
)
from ..tools import get_all_tools

router = APIRouter()


@router.get("")
async def list_installed() -> dict:
    try:
        installed = await list_plugins()
        tools = get_all_tools()
        by_plugin = [t for t in tools if t.pluginId]
        result = []
        for p in installed:
            registered = [t for t in by_plugin if t.pluginId == p["id"]]
            result.append({**p, "registeredTools": registered})
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
    if not admin_authenticated(request):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
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


@router.post("/{plugin_id}/uninstall")
async def uninstall(plugin_id: str, request: Request) -> dict:
    if not admin_authenticated(request):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    try:
        return await uninstall_plugin(plugin_id)
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e) or "Uninstall failed"}, status_code=400)


@router.post("/{plugin_id}/toggle")
async def toggle(plugin_id: str, request: Request) -> dict:
    if not admin_authenticated(request):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    try:
        body = await request.json()
        enabled = bool(body.get("enabled"))
        plugin = await set_plugin_enabled(plugin_id, enabled)
        return {"success": True, "plugin": plugin}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e) or "Toggle failed"}, status_code=400)


@router.post("/{plugin_id}/update")
async def update(plugin_id: str, request: Request) -> dict:
    if not admin_authenticated(request):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    try:
        plugin = await update_plugin(plugin_id)
        return {"success": True, "plugin": plugin}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e) or "Update failed"}, status_code=400)