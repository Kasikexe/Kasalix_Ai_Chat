@echo off
setlocal enabledelayedexpansion
title Kasalix AI Chat Server — Build Setup

cd /d "%~dp0"

echo ╔══════════════════════════════════════════════════╗
echo ║  Kasalix AI Chat Server — Build Installer       ║
echo ╚══════════════════════════════════════════════════╝
echo.

:: ── 1. Check prerequisites ──────────────────────────

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is required. Download from: https://nodejs.org
    pause
    exit /b 1
)

:: Detect package manager (bun > npm)
set "PKG=bun"
where bun >nul 2>nul
if %errorlevel% neq 0 (
    set "PKG=npm"
    echo [WARN] Bun not found — using npm (slower)
)
echo   Package manager: %PKG%
echo.

:: ── 2. Read version ─────────────────────────────────

echo [1/6] Reading version...
for /f "usebackq delims=" %%a in (`node -e "const p=require('../frontend/package.json');console.log(p.version)"`) do set "CURRENT_VERSION=%%a"
if not defined CURRENT_VERSION set "CURRENT_VERSION=1.0.0"
echo   Version: %CURRENT_VERSION%
echo.

:: ── 3. Install backend dependencies (skip if exists) ─

echo [2/6] Backend dependencies...
pushd ..\backend
if not exist "node_modules" (
    echo   Installing...
    if "%PKG%"=="bun" (call bun install) else (call npm install --prefer-offline)
) else (
    echo   Already installed — skipping
)
if %errorlevel% neq 0 (
    echo [ERROR] Backend install failed.
    popd
    pause
    exit /b 1
)
popd
echo.

:: ── 4. Build frontend (skip install if exists) ──────

echo [3/6] Building frontend...
pushd ..\frontend
if not exist "node_modules" (
    echo   Installing dependencies...
    if "%PKG%"=="bun" (call bun install) else (call npm install --prefer-offline)
) else (
    echo   Dependencies already installed — skipping
)
if %errorlevel% neq 0 (
    echo [ERROR] Frontend install failed.
    popd
    pause
    exit /b 1
)
echo   Building (tsc + vite)...
call npm run build
if %errorlevel% neq 0 (
    echo [ERROR] Frontend build failed.
    popd
    pause
    exit /b 1
)
popd
echo.

:: ── 5. Build Server GUI (skip install if exists) ────

echo [4/6] Building Server GUI...
pushd ..\server-gui
if not exist "node_modules" (
    echo   Installing dependencies...
    if "%PKG%"=="bun" (call bun install) else (call npm install --prefer-offline)
) else (
    echo   Dependencies already installed — skipping
)
if %errorlevel% neq 0 (
    echo [ERROR] Server GUI install failed.
    popd
    pause
    exit /b 1
)
echo   Building portable...
call npm run build:portable
if %errorlevel% neq 0 (
    echo [WARN] Server GUI build failed. Falling back to CLI-only installer.
    popd
) else (
    echo [OK] Server GUI built.
    popd
)
echo.

:: ── 6. Create output directory ──────────────────────

echo [5/6] Preparing output...
if not exist "output" mkdir output
echo.

:: ── 7. Build the Setup.exe ──────────────────────────

echo [6/6] Creating installer...
set "APP_VERSION=%CURRENT_VERSION%"

:: Detect NSIS
set "NSIS_EXE=makensis"
where makensis >nul 2>nul
if %errorlevel% neq 0 (
    if exist "%ProgramFiles(x86)%\NSIS\makensis.exe" (
        set "NSIS_EXE=%ProgramFiles(x86)%\NSIS\makensis.exe"
    ) else if exist "%ProgramFiles%\NSIS\makensis.exe" (
        set "NSIS_EXE=%ProgramFiles%\NSIS\makensis.exe"
    ) else (
        goto :ZIP_FALLBACK
    )
)

:: Compile with NSIS
echo Compiling with NSIS...
"%NSIS_EXE%" /DVERSION=%APP_VERSION% setup.nsi
if %errorlevel% equ 0 (
    for %%f in ("output\Kasalix-AI-Chat-Server-Setup-*.exe") do set "SETUP_FILE=%%~nxf"
    echo.
    echo ╔══════════════════════════════════════════════════╗
    echo ║  SUCCESS!                                       ║
    echo ║  Installer created:                             ║
    if defined SETUP_FILE (
        echo ║    output\%SETUP_FILE%
    ) else (
        echo ║    output\Kasalix-AI-Chat-Server-Setup-%APP_VERSION%.exe
    )
    echo ╚══════════════════════════════════════════════════╝
    echo.
    pause
    exit /b 0
) else (
    echo [ERROR] NSIS compilation failed.
    pause
    exit /b 1
)

:ZIP_FALLBACK
echo NSIS not found. Creating portable ZIP instead...
echo.

set "SERVER_APP_VER=%APP_VERSION%"

powershell -NoProfile -Command ^
    "$staging = Join-Path (Get-Location) 'staging';" ^
    "$ver = [Environment]::GetEnvironmentVariable('SERVER_APP_VER','Process');" ^
    "$zipPath = Join-Path (Get-Location) ('output\Kasalix-AI-Chat-Server-Portable-' + $ver + '.zip');" ^
    "if (Test-Path $staging) { Remove-Item $staging -Recurse -Force };" ^
    "New-Item -ItemType Directory -Path $staging -Force | Out-Null;" ^
    "Copy-Item -Path (Join-Path (Get-Location) '..\backend') -Destination (Join-Path $staging 'backend') -Recurse -Force;" ^
    "Remove-Item -Path (Join-Path $staging 'backend\data') -Recurse -Force -ErrorAction SilentlyContinue;" ^
    "Remove-Item -Path (Join-Path $staging 'backend\generated_images') -Recurse -Force -ErrorAction SilentlyContinue;" ^
    "Remove-Item -Path (Join-Path $staging 'backend\.env') -Force -ErrorAction SilentlyContinue;" ^
    "Remove-Item -Path (Join-Path $staging 'backend\node_modules') -Recurse -Force -ErrorAction SilentlyContinue;" ^
    "Remove-Item -Path (Join-Path $staging 'backend\test') -Recurse -Force -ErrorAction SilentlyContinue;" ^
    "Copy-Item -Path (Join-Path (Get-Location) '..\frontend\dist') -Destination (Join-Path $staging 'frontend\dist') -Recurse -Force;" ^
    "Copy-Item -Path (Join-Path (Get-Location) '..\certs\generate-certs.cjs') -Destination (Join-Path $staging 'certs') -Force;" ^
    "Copy-Item -Path (Join-Path (Get-Location) 'run-server.bat') -Destination $staging -Force;" ^
    "Copy-Item -Path (Join-Path (Get-Location) 'stop-server.bat') -Destination $staging -Force;" ^
    "if (Test-Path $zipPath) { Remove-Item $zipPath -Force };" ^
    "Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipPath;" ^
    "Remove-Item $staging -Recurse -Force;" ^
    "Write-Host 'Created:' $zipPath"

echo.
if exist "output\Kasalix-AI-Chat-Server-Portable-%APP_VERSION%.zip" (
    echo ╔══════════════════════════════════════════════════╗
    echo ║  Portable archive created:                      ║
    echo ║    output\Kasalix-AI-Chat-Server-Portable-%APP_VERSION%.zip
    echo ╚══════════════════════════════════════════════════╝
)
echo.
pause
