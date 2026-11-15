"""Plugin routes — mirrors backend/src/routes/plugins.ts."""

from __future__ import annotations

import ipaddress
import json

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..deps import session_authenticated, user_id_from_request
from ..logger import error as log_error, warn as log_warn
from ..services.plugins.catalog import CATALOG_REPO, fetch_plugin_catalog, is_catalog_source
from ..services.plugins.manager import (
    install_plugin,
    install_local_ui,
    list_plugins,
    list_plugin_modes,
    set_backend_permissions,
    set_plugin_enabled,
    uninstall_plugin,
    update_plugin,
)
from ..tools import get_all_tools
from ..services.plugins import manager, runtime, sandbox

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
                    "backend": (inst or {}).get("manifest", {}).get("backend"),
                    "backendApproved": bool(inst and inst.get("approvedFingerprint") and inst.get("approvedFingerprint") == inst.get("backendFingerprint")),
                    "grantedPermissions": (inst or {}).get("grantedPermissions", []),
                    "legacyBlocked": bool(inst and inst.get("manifest", {}).get("kind", "tool") == "tool"),
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


@router.get("/{plugin_id}/permissions")
async def get_permissions(plugin_id: str, request: Request) -> dict:
    if not _management_allowed(request):
        return _management_denied()
    plugin = next((p for p in await list_plugins() if p.get("id") == plugin_id), None)
    if not plugin or not plugin.get("manifest", {}).get("backend"):
        return JSONResponse({"error": "Plugin has no backend actions"}, status_code=404)
    try:
        source = manager.backend_source(plugin.get("localPath") or manager.get_plugin_dir(plugin_id), plugin["manifest"])
        current = bool(source and source[1] == plugin.get("backendFingerprint"))
    except (OSError, ValueError):
        current = False
    return {"permissions": plugin["manifest"]["backend"]["permissions"],
            "granted": plugin.get("grantedPermissions") or [],
            "approved": bool(current and plugin.get("approvedFingerprint") == plugin.get("backendFingerprint")),
            "codeChanged": not current}


@router.post("/{plugin_id}/permissions")
async def change_permissions(plugin_id: str, request: Request) -> dict:
    if not _management_allowed(request):
        return _management_denied()
    try:
        body = await request.json()
        if not isinstance(body, dict) or not isinstance(body.get("approved"), bool):
            return JSONResponse({"error": "An explicit approval decision is required"}, status_code=400)
        plugin = await set_backend_permissions(plugin_id, body["approved"], body.get("grants", []))
        return {"success": True, "approved": bool(plugin.get("approvedFingerprint")), "granted": plugin.get("grantedPermissions", [])}
    except (ValueError, OSError) as error:
        return JSONResponse({"error": str(error)}, status_code=400)


@router.post("/{plugin_id}/actions/{action}")
async def invoke_action(plugin_id: str, action: str, request: Request) -> dict:
    if not session_authenticated(request):
        return JSONResponse({"error": "Authentication required"}, status_code=401)
    try:
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > runtime.MAX_PAYLOAD:
                return JSONResponse({"error": "Action payload is too large"}, status_code=413)
        payload = json.loads(raw or b"{}")
        if not isinstance(payload, dict):
            return JSONResponse({"error": "Action payload must be an object"}, status_code=400)
        result = await runtime.invoke(plugin_id, action, payload, user_id_from_request(request))
        return {"result": result}
    except PermissionError as error:
        return JSONResponse({"error": str(error)}, status_code=403)
    except (ValueError, UnicodeError, RecursionError) as error:
        return JSONResponse({"error": str(error)}, status_code=400)
    except sandbox.SandboxError as error:
        return JSONResponse({"error": str(error)}, status_code=503)


@router.delete("/{plugin_id}/storage")
async def clear_storage(plugin_id: str, request: Request) -> dict:
    if not session_authenticated(request):
        return JSONResponse({"error": "Authentication required"}, status_code=401)
    try:
        await runtime.clear_storage(plugin_id, user_id_from_request(request))
        return {"success": True}
    except OSError:
        return JSONResponse({"error": "Could not clear plugin storage"}, status_code=500)


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
