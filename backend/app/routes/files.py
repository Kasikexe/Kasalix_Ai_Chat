"""Files API — mirrors backend/src/routes/files.ts.

Workspace-sandboxed file listing, reading, editing, writing, deleting.
Directory listing stays open (the workspace picker needs to browse), but
reading/writing/deleting is confined to the declared workspace root.
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..utils import apply_search_replace, changed_line_count, is_path_inside, is_protected_dir_name, is_protected_path

router = APIRouter()

IGNORE_DIRS = {
    "node_modules", ".git", ".svn", ".hg", ".DS_Store",
    "__pycache__", ".next", ".nuxt", "dist", "build", ".cache",
    "target", "vendor", ".venv", "venv", "env",
}

MAX_FILE_SIZE = 1024 * 1024  # 1MB max for preview

LANGUAGE_MAP = {
    ".ts": "typescript", ".tsx": "tsx", ".js": "javascript", ".jsx": "jsx",
    ".json": "json", ".md": "markdown", ".css": "css", ".scss": "scss",
    ".html": "html", ".xml": "xml", ".svg": "xml", ".yaml": "yaml", ".yml": "yaml",
    ".py": "python", ".rb": "ruby", ".go": "go", ".rs": "rust", ".c": "c", ".cpp": "cpp",
    ".h": "c", ".hpp": "cpp", ".java": "java", ".kt": "kotlin", ".swift": "swift",
    ".sh": "bash", ".bash": "bash", ".zsh": "bash", ".ps1": "powershell",
    ".sql": "sql", ".graphql": "graphql", ".gql": "graphql",
    ".dockerfile": "dockerfile", ".txt": "text", ".env": "text",
    ".toml": "ini", ".ini": "ini", ".cfg": "ini",
    ".vue": "vue", ".svelte": "html", ".astro": "html",
}


def _resolve_workspace_root(ws: str | None) -> str | None:
    if not ws or not isinstance(ws, str):
        return None
    resolved = os.path.abspath(ws)
    if os.path.splitdrive(resolved)[1] in ("\\", "/") or resolved == "/":
        return None  # reject drive roots
    return resolved


def _detect_language(filename: str) -> str | None:
    ext = os.path.splitext(filename)[1].lower()
    return LANGUAGE_MAP.get(ext)


def _is_binary_content(data: bytes) -> bool:
    sample = data[:8192]
    return b"\x00" in sample


@router.get("")
async def list_dir(request: Request) -> dict:
    dir_path = request.query_params.get("path")
    if not dir_path:
        return JSONResponse({"error": "path query parameter is required"}, status_code=400)
    resolved = os.path.abspath(dir_path)
    if not os.path.exists(resolved):
        return JSONResponse({"error": "Directory does not exist"}, status_code=404)
    if not os.path.isdir(resolved):
        return JSONResponse({"error": "Path is not a directory"}, status_code=400)
    try:
        entries = os.listdir(resolved)
        result = []
        for name in entries:
            if name.startswith(".") or name in IGNORE_DIRS or is_protected_dir_name(name):
                continue
            full = os.path.join(resolved, name)
            size = None
            if os.path.isfile(full):
                try:
                    size = os.path.getsize(full)
                except OSError:  # noqa: S110
                    pass
            result.append(
                {
                    "name": name,
                    "path": full,
                    "type": "directory" if os.path.isdir(full) else "file",
                    "size": size,
                }
            )
        result.sort(key=lambda e: (e["type"] != "directory", e["name"].lower()))
        return {"entries": result}
    except OSError:
        return JSONResponse({"error": "Failed to read directory"}, status_code=500)


@router.get("/content")
async def get_content(request: Request) -> dict:
    file_path = request.query_params.get("path")
    if not file_path:
        return JSONResponse({"error": "path query parameter is required"}, status_code=400)
    workspace_root = _resolve_workspace_root(request.query_params.get("workspacePath"))
    if not workspace_root:
        return JSONResponse({"error": "A valid workspacePath query parameter is required"}, status_code=403)
    resolved = os.path.abspath(file_path)
    if is_protected_path(workspace_root, resolved):
        return JSONResponse({"error": "Access denied: path is in a protected server directory"}, status_code=403)
    if not (await is_path_inside(workspace_root, resolved)):
        return JSONResponse({"error": "Access denied: path is outside the workspace"}, status_code=403)
    if not os.path.exists(resolved):
        return JSONResponse({"error": "File does not exist"}, status_code=404)
    if not os.path.isfile(resolved):
        return JSONResponse({"error": "Path is not a file"}, status_code=400)
    stat = os.stat(resolved)
    truncated = stat.st_size > MAX_FILE_SIZE
    try:
        with open(resolved, "rb") as f:
            buffer = f.read()
        if _is_binary_content(buffer):
            return {"content": None, "language": None, "size": stat.st_size, "truncated": False, "binary": True}
        content = buffer[:MAX_FILE_SIZE].decode("utf-8", "replace") if truncated else buffer.decode("utf-8", "replace")
        return {"content": content, "language": _detect_language(file_path), "size": stat.st_size, "truncated": truncated, "binary": False}
    except OSError:
        return JSONResponse({"error": "Failed to read file"}, status_code=500)


@router.delete("/delete")
async def delete_file_route(request: Request) -> dict:
    file_path = request.query_params.get("path")
    if not file_path:
        return JSONResponse({"error": "path query parameter is required"}, status_code=400)
    workspace_root = _resolve_workspace_root(request.query_params.get("workspacePath"))
    if not workspace_root:
        return JSONResponse({"error": "A valid workspacePath query parameter is required"}, status_code=403)
    resolved = os.path.abspath(file_path)
    if is_protected_path(workspace_root, resolved):
        return JSONResponse({"error": "Access denied: path is in a protected server directory"}, status_code=403)
    if not (await is_path_inside(workspace_root, resolved)):
        return JSONResponse({"error": "Access denied: path is outside the workspace"}, status_code=403)
    try:
        if not os.path.exists(resolved):
            return JSONResponse({"error": "File does not exist"}, status_code=404)
        if os.path.isdir(resolved):
            import shutil

            shutil.rmtree(resolved)
        else:
            os.remove(resolved)
        return {"success": True, "path": resolved}
    except OSError:
        return JSONResponse({"error": "Failed to delete file"}, status_code=500)


@router.post("/edit")
async def edit_file_route(request: Request) -> dict:
    try:
        body = await request.json()
        file_path = body.get("filePath")
        old_string = body.get("oldString")
        new_string = body.get("newString")
        if not file_path or not isinstance(old_string, str) or not isinstance(new_string, str):
            return JSONResponse({"error": "filePath, oldString and newString are required"}, status_code=400)
        workspace_root = _resolve_workspace_root(body.get("workspacePath"))
        if not workspace_root:
            return JSONResponse({"error": "A valid workspacePath is required in the request body"}, status_code=403)
        resolved = os.path.abspath(file_path)
        if is_protected_path(workspace_root, resolved):
            return JSONResponse({"error": "Access denied: path is in a protected server directory"}, status_code=403)
        if not (await is_path_inside(workspace_root, resolved)):
            return JSONResponse({"error": "Access denied: path is outside the workspace"}, status_code=403)
        try:
            with open(resolved, "r", encoding="utf-8") as f:
                old_content = f.read()
        except OSError:
            return JSONResponse({"error": "File does not exist"}, status_code=404)
        result = apply_search_replace(old_content, old_string, new_string)
        if not result.get("ok") or result.get("newContent") is None:
            return JSONResponse({"error": result.get("error") or "Edit failed"}, status_code=400)
        with open(resolved, "w", encoding="utf-8") as f:
            f.write(result["newContent"])
        return {"success": True, "path": resolved, "size": len(result["newContent"].encode("utf-8"))}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e) or "Failed to edit file"}, status_code=500)


@router.put("/write")
async def write_file_route(request: Request) -> dict:
    try:
        body = await request.json()
        file_path = body.get("filePath")
        content = body.get("content")
        if not file_path or content is None:
            return JSONResponse({"error": "filePath and content are required"}, status_code=400)
        workspace_root = _resolve_workspace_root(body.get("workspacePath"))
        if not workspace_root:
            return JSONResponse({"error": "A valid workspacePath is required in the request body"}, status_code=403)
        resolved = os.path.abspath(file_path)
        if is_protected_path(workspace_root, resolved):
            return JSONResponse({"error": "Access denied: path is in a protected server directory"}, status_code=403)
        if not (await is_path_inside(workspace_root, resolved)):
            return JSONResponse({"error": "Access denied: path is outside the workspace"}, status_code=403)
        os.makedirs(os.path.dirname(resolved), exist_ok=True)
        old_content: str | None = None
        try:
            with open(resolved, "r", encoding="utf-8") as f:
                old_content = f.read()
        except OSError:  # noqa: S110
            pass
        if old_content is not None:
            cc = changed_line_count(old_content.replace("\r\n", "\n"), content.replace("\r\n", "\n"))
            changed = cc["count"]
            total = cc["total"]
            is_small_edit = changed <= max(20, int(total * 0.4))
            if not is_small_edit:
                return JSONResponse(
                    {"error": f"Refusing to overwrite {file_path}: your version changes {changed} of {total} lines — that is a full rewrite, not an edit. To rewrite the whole file on purpose, delete it first (or use the edit/EDIT flow with a small old_string)."},
                    status_code=409,
                )
            final_content = content.replace("\r\n", "\n").replace("\n", "\r\n") if "\r\n" in old_content else content
            with open(resolved, "w", encoding="utf-8") as f:
                f.write(final_content)
            return {"success": True, "path": resolved, "isNew": False, "size": len(final_content.encode("utf-8"))}
        with open(resolved, "w", encoding="utf-8") as f:
            f.write(content)
        return {"success": True, "path": resolved, "isNew": True, "size": len(content.encode("utf-8"))}
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e) or "Failed to write file"}, status_code=500)