"""Auth routes — mirrors the auth endpoints in backend/src/index.ts."""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from ..auth import (
    destroy_session,
    get_all_users,
    get_current_user,
    login_user,
    register_user,
    validate_session,
)
from ..deps import admin_authenticated
from ..logger import error as log_error, info as log_info

router = APIRouter()


def _bearer_token(request: Request) -> str | None:
    header = request.headers.get("authorization") or ""
    if header.startswith("Bearer "):
        return header[7:]
    return None


@router.post("/register")
async def register(request: Request) -> dict:
    try:
        body = await request.json()
        username = body.get("username")
        password = body.get("password")
        remember_me = body.get("rememberMe") is True
        if not username or not password:
            return JSONResponse({"error": "Username and password are required"}, status_code=400)
        result = await register_user(username, password)
        if not result.get("success"):
            return JSONResponse({"error": result.get("error")}, status_code=400)
        login_result = await login_user(
            username, password, request.headers.get("x-forwarded-for") or "local", remember_me
        )
        if not login_result.get("success"):
            return JSONResponse({"error": login_result.get("error")}, status_code=500)
        profile = await get_current_user(login_result["userId"])
        log_info(f"[auth] New user registered: {username}")
        return JSONResponse({"token": login_result["token"], "user": profile}, status_code=201)
    except Exception as e:  # noqa: BLE001
        log_error("[auth] Registration error:", e)
        return JSONResponse({"error": "Registration failed"}, status_code=500)


@router.post("/login")
async def login(request: Request) -> dict:
    try:
        body = await request.json()
        username = body.get("username")
        password = body.get("password")
        remember_me = body.get("rememberMe") is True
        if not username or not password:
            return JSONResponse({"error": "Username and password are required"}, status_code=400)
        ip = (
            request.headers.get("x-forwarded-for")
            or request.headers.get("x-real-ip")
            or "local"
        )
        result = await login_user(username, password, ip, remember_me)
        if not result.get("success"):
            return JSONResponse({"error": result.get("error")}, status_code=401)
        profile = await get_current_user(result["userId"])
        return {"token": result["token"], "user": profile}
    except Exception as e:  # noqa: BLE001
        log_error("[auth] Login error:", e)
        return JSONResponse({"error": "Login failed"}, status_code=500)


@router.post("/logout")
async def logout(request: Request) -> dict:
    try:
        token = _bearer_token(request)
        if token:
            destroy_session(token)
        return {"success": True}
    except Exception as e:  # noqa: BLE001
        log_error("[auth] Logout error:", e)
        return JSONResponse({"error": "Logout failed"}, status_code=500)


@router.get("/me")
async def me(request: Request) -> dict:
    try:
        token = _bearer_token(request)
        if not token:
            return {"authenticated": False}
        result = validate_session(token)
        if not result.get("valid") or not result.get("userId"):
            return {"authenticated": False}
        profile = await get_current_user(result["userId"])
        if not profile:
            return {"authenticated": False}
        return {"authenticated": True, "user": profile}
    except Exception as e:  # noqa: BLE001
        log_error("[auth] Session check error:", e)
        return {"authenticated": False}


@router.get("/users")
async def list_users(request: Request) -> dict:
    if not admin_authenticated(request):
        return JSONResponse({"error": "Not authenticated"}, status_code=401)
    try:
        users = await get_all_users()
        return {"users": users}
    except Exception as e:  # noqa: BLE001
        log_error("[auth] List users error:", e)
        return JSONResponse({"error": "Failed to list users"}, status_code=500)