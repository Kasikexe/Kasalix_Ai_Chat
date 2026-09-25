@echo off
setlocal enabledelayedexpansion
title Kasalix AI Chat Server - Stop

echo ================================================================
echo    Stopping Kasalix AI Chat Server (Python backend)
echo ================================================================
echo.

set "FOUND=0"

:: Kill processes on ports 3001 (backend) and 5173 (dev frontend, just in case)
for %%p in (3001 5173) do (
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr /C:":%%p " ^| findstr /C:"LISTENING"') do (
        if not "%%a"=="" (
            set "FOUND=1"
            echo [PORT %%p] Stopping PID %%a ...
            taskkill /F /PID %%a >nul 2>&1
            if !errorlevel! equ 0 (
                echo [OK] Port %%p freed
            ) else (
                echo [WARN] Could not kill PID %%a on port %%p
            )
        )
    )
)

:: Also kill any backend.exe processes that were started by the server
for /f "tokens=2" %%a in ('tasklist ^| findstr /I "backend.exe"') do (
    set "FOUND=1"
    echo [BACKEND] Stopping process %%a ...
    taskkill /F /PID %%a >nul 2>&1
)

if "%FOUND%"=="0" (
    echo No running server processes found.
)

echo.
echo ----------------------------------------------------------------
echo Note: Ollama is still running in the background.
echo To stop Ollama too:
echo   taskkill /F /IM ollama.exe
echo ----------------------------------------------------------------
echo.
pause