@echo off
setlocal enabledelayedexpansion
title Kasalix AI Chat Server

cd /d "%~dp0"

echo ╔══════════════════════════════════════════════════╗
echo ║     Kasalix AI Chat Server — Starting           ║
echo ╚══════════════════════════════════════════════════╝
echo.

:: ── Detect paths ────────────────────────────────────
:: When installed, the structure is:
::   C:\Users\<you>\AppData\Local\Kasalix AI Chat Server\
::     ├── backend\
::     ├── frontend\dist\
::     ├── certs\
::     ├── run-server.bat   (this file)
::     └── stop-server.bat
set "INSTALL_DIR=%~dp0"
set "BACKEND_DIR=%INSTALL_DIR%backend"
set "FRONTEND_DIR=%INSTALL_DIR%frontend"
set "CERT_DIR=%INSTALL_DIR%certs"

:: ── Check if Bun is available ───────────────────────
where bun >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Bun is not installed!
    echo.
    echo   The Kasalix AI Chat Server requires Bun to run.
    echo   Download from: https://bun.sh
    echo.
    echo   After installing Bun, run this script again.
    echo.
    pause
    exit /b 1
)

:: ── Check for Ollama ────────────────────────────────
where ollama >nul 2>nul
if %errorlevel% neq 0 (
    echo [WARN] Ollama is not installed or not in PATH.
    echo        Download from: https://ollama.com/download
    echo.
    echo  The server will start, but you need Ollama for AI features.
    echo.
    timeout /t 3 /nobreak >nul
)

:: ── Start Ollama if not running ─────────────────────
echo [1/4] Checking Ollama...
curl -s http://localhost:11434/api/tags >nul 2>nul
if %errorlevel% neq 0 (
    where ollama >nul 2>nul
    if !errorlevel! equ 0 (
        echo [INFO] Starting Ollama...
        start "Ollama" /min cmd /c "ollama serve"
        timeout /t 3 /nobreak >nul
        echo [OK] Ollama started
    ) else (
        echo [SKIP] Ollama not available
    )
) else (
    echo [OK] Ollama is running
)
echo.

:: ── Install backend dependencies if needed ──────────
echo [2/4] Checking backend dependencies...
if not exist "%BACKEND_DIR%\node_modules" (
    echo [INFO] Installing backend dependencies...
    pushd "%BACKEND_DIR%"
    call bun install
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to install backend dependencies.
        popd
        pause
        exit /b 1
    )
    popd
)
echo [OK] Backend dependencies ready
echo.

:: ── Detect local IP for LAN sharing ─────────────────
echo [3/4] Detecting network...
set "IP=127.0.0.1"
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /C:"IPv4"') do (
    set "IP=%%a"
    goto :IP_FOUND
)
:IP_FOUND
set "IP=%IP: =%"
echo [OK] Local IP: %IP%
echo.

:: ── Decide HTTPS vs HTTP ────────────────────────────
echo [4/4] Starting server...
set "HTTPS=true"
if exist "%INSTALL_DIR%\.http-mode" (
    del "%INSTALL_DIR%\.http-mode"
)
set "HTTPS_ARGS="

:: User can pass --http to force HTTP mode
if /i "%~1"=="--http" set "HTTPS=false"
if /i "%~1"=="/http" set "HTTPS=false"

:: Check if certs exist
if "%HTTPS%"=="true" (
    if not exist "%CERT_DIR%\localhost.crt" (
        echo [WARN] SSL certificates not found. Falling back to HTTP.
        set "HTTPS=false"
    )
)

if "%HTTPS%"=="true" (
    set "PROTO=https"
    set "PROTO_ARGS="
    echo [OK] HTTPS mode (encrypted)
) else (
    set "PROTO=http"
    set "PROTO_ARGS=--http"
    :: Signal to the backend that we want HTTP
    echo. > "%INSTALL_DIR%\.http-mode"
    echo [OK] HTTP mode (no encryption)
)
echo.

:: ── Launch the server ───────────────────────────────
echo ╔══════════════════════════════════════════════════╗
echo ║   Kasalix AI Chat Server is starting!           ║
echo ║                                                  ║
echo ║   Open in your browser:                         ║
echo ║     %PROTO%://localhost:3001                     ║
echo ║                                                  ║
echo ║   Share with others on your LAN:                ║
echo ║     %PROTO%://%IP%:3001                          ║
echo ║                                                  ║
echo ║   Press Ctrl+C to stop the server.              ║
echo ╚══════════════════════════════════════════════════╝
echo.

pushd "%BACKEND_DIR%"
if "%PROTO_ARGS%"=="" (
    bun run src/index.ts
) else (
    bun run src/index.ts -- %PROTO_ARGS%
)
set "EXIT_CODE=%errorlevel%"
popd

if exist "%INSTALL_DIR%\.http-mode" (
    del "%INSTALL_DIR%\.http-mode" 2>nul
)

if %EXIT_CODE% neq 0 (
    echo.
    echo  Server stopped with error code %EXIT_CODE%.
    echo  Check the window above for details.
    echo.
    pause
)
