@echo off
setlocal enabledelayedexpansion
title Kasalix AI Chat Server

cd /d "%~dp0"

echo ================================================================
echo    Kasalix AI Chat Server - Starting (Python backend)
echo ================================================================
echo.

:: ---- Detect paths -------------------------------------------------
:: When installed, the structure is:
::   C:\Users\<you>\AppData\Local\Kasalix AI Chat Server\
::     |- backend\        (backend.exe + _internal\ - PyInstaller build)
::     |- frontend\dist\
::     |- certs\
::     |- run-server.bat  (this file)
::     |- stop-server.bat
set "INSTALL_DIR=%~dp0"
set "BACKEND_DIR=%INSTALL_DIR%backend"
set "FRONTEND_DIR=%INSTALL_DIR%frontend"
set "CERT_DIR=%INSTALL_DIR%certs"
:: Runtime data lives in a stable per-install folder so it survives updates.
set "DATA_DIR=%INSTALL_DIR%data"
set "GENERATED_IMAGES_DIR=%INSTALL_DIR%generated_images"

:: ---- Check backend.exe exists ------------------------------------
if not exist "%BACKEND_DIR%\backend.exe" (
    echo [ERROR] backend.exe not found in "%BACKEND_DIR%"
    echo         The installation appears to be incomplete.
    echo.
    pause
    exit /b 1
)

:: ---- Check for Ollama ---------------------------------------------
where ollama >nul 2>nul
if %errorlevel% neq 0 (
    echo [WARN] Ollama is not installed or not in PATH.
    echo        Download from: https://ollama.com/download
    echo.
    echo  The server will start, but you need Ollama for AI features.
    echo.
    timeout /t 3 /nobreak >nul
)

:: ---- Start Ollama if not running ----------------------------------
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

:: The Python backend is self-contained - no dependency install step.

:: ---- Detect local IP for LAN sharing ------------------------------
echo [2/4] Detecting network...
set "IP=127.0.0.1"
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /C:"IPv4"') do (
    set "IP=%%a"
    goto :IP_FOUND
)
:IP_FOUND
set "IP=%IP: =%"
echo [OK] Local IP: %IP%
echo.

:: ---- Decide HTTPS vs HTTP -----------------------------------------
echo [3/4] Starting server...
set "HTTPS=true"

:: User can pass --http to force HTTP mode
if /i "%~1"=="--http" set "HTTPS=false"
if /i "%~1"=="/http" set "HTTPS=false"

:: The Python backend auto-generates self-signed certs into certs\ on
:: first HTTPS start (cryptography is bundled). No external generator needed.
if "%HTTPS%"=="true" (
    set "PROTO=https"
    set "HTTP_ARG="
    echo [OK] HTTPS mode (encrypted) - certs auto-generated if missing
) else (
    set "PROTO=http"
    set "HTTP_ARG=--http"
    echo [OK] HTTP mode (no encryption)
)
echo.

:: ---- Launch the server --------------------------------------------
echo ================================================================
echo    Kasalix AI Chat Server is starting!
echo.
echo    Open in your browser:
echo      %PROTO%://localhost:3001
echo.
echo    Share with others on your LAN:
echo      %PROTO%://%IP%:3001
echo.
echo    Press Ctrl+C to stop the server.
echo ================================================================
echo.

pushd "%BACKEND_DIR%"
set "PORT=3001"
set "DATA_DIR=%DATA_DIR%"
set "GENERATED_IMAGES_DIR=%GENERATED_IMAGES_DIR%"
if "%HTTP_ARG%"=="" (
    backend.exe
) else (
    backend.exe --http
)
set "EXIT_CODE=%errorlevel%"
popd

if %EXIT_CODE% neq 0 (
    echo.
    echo  Server stopped with error code %EXIT_CODE%.
    echo  Check the window above for details.
    echo.
    pause
)