@echo off
setlocal enabledelayedexpansion
title Stop AI Chat

echo =============================================
echo    Stopping AI Chat Servers
echo =============================================
echo.

set "FOUND_ANY=0"

REM Kill processes on port 3001 (backend)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /C:":3001 " ^| findstr /C:"LISTENING"') do (
    if not "%%a"=="" (
        set "FOUND_ANY=1"
        echo [BACKEND] Found PID %%a on port 3001 - stopping...
        taskkill /F /PID %%a 2>&1
        if !errorlevel! equ 0 (
            echo [OK] Port 3001 freed
        ) else (
            echo [WARN] Could not kill PID %%a on port 3001
        )
    )
)

REM Kill processes on port 5173 (frontend)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /C:":5173 " ^| findstr /C:"LISTENING"') do (
    if not "%%a"=="" (
        set "FOUND_ANY=1"
        echo [FRONTEND] Found PID %%a on port 5173 - stopping...
        taskkill /F /PID %%a 2>&1
        if !errorlevel! equ 0 (
            echo [OK] Port 5173 freed
        ) else (
            echo [WARN] Could not kill PID %%a on port 5173
        )
    )
)

if "!FOUND_ANY!"=="0" (
    echo No running processes found on ports 3001 or 5173.
    echo.
    echo If the servers are still running, try running this as Administrator.
    echo Right-click ^> "Run as administrator"
)

echo.
echo =============================================
echo    Done. Ollama is left running in background.
echo =============================================
echo.
pause
