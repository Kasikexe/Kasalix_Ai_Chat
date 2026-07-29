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

where bun >nul 2>nul
if %errorlevel% neq 0 (
    echo [WARN] Bun not found. Will try npm instead.
    set "USE_NPM=1"
) else (
    set "USE_NPM=0"
)

:: ── 2. Install backend dependencies ─────────────────

echo [1/5] Installing backend dependencies...
pushd ..\backend
if "!USE_NPM!"=="1" (
    call npm install
) else (
    call bun install
)
if %errorlevel% neq 0 (
    echo [ERROR] Failed to install backend dependencies.
    popd
    pause
    exit /b 1
)
popd
echo [OK] Backend dependencies installed.
echo.

:: ── 3. Build frontend ───────────────────────────────

echo [2/5] Building frontend (production)...
pushd ..\frontend
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] npm install failed for frontend.
    popd
    pause
    exit /b 1
)
call npm run build
if %errorlevel% neq 0 (
    echo [ERROR] Frontend build failed.
    popd
    pause
    exit /b 1
)
popd
echo [OK] Frontend built.
echo.

:: ── 4. Read version from frontend package.json ──────

echo [3/5] Reading version...
for /f "usebackq delims=" %%a in (`node -e "const p=require('../frontend/package.json');console.log(p.version)"`) do set "APP_VERSION=%%a"
if not defined APP_VERSION (
    echo [ERROR] Could not read version from frontend/package.json
    pause
    exit /b 1
)
echo [OK] Version: %APP_VERSION%
echo.

:: ── 5. Build Server GUI Electron App ────────────────

echo [4/6] Building Server GUI (Electron)...
pushd ..\server-gui
call npm install
if %errorlevel% neq 0 (
    echo [ERROR] npm install failed for server-gui.
    popd
    pause
    exit /b 1
)
call npm run build:portable
if %errorlevel% neq 0 (
    echo [WARN] Server GUI build failed. Falling back to CLI-only installer.
    echo The server will still work via run-server.bat.
    popd
) else (
    echo [OK] Server GUI built.
    popd
)
echo.

:: ── 6. Create output directory ──────────────────────

echo [5/6] Preparing output directory...
if not exist "output" mkdir output
echo [OK] Output directory ready.
echo.

:: ── 7. Build the Setup.exe ──────────────────────────

echo [6/6] Creating installer...

:: ── Detect NSIS Compiler ────────────────────────────
:: NSIS may not be in PATH (default install doesn't add it)
:: Check common install locations as fallback
set "NSIS_EXE=makensis"
where makensis >nul 2>nul
if %errorlevel% neq 0 (
    if exist "%ProgramFiles(x86)%\NSIS\makensis.exe" (
        set "NSIS_EXE=%ProgramFiles(x86)%\NSIS\makensis.exe"
    ) else if exist "%ProgramFiles%\NSIS\makensis.exe" (
        set "NSIS_EXE=%ProgramFiles%\NSIS\makensis.exe"
    ) else (
        :: NSIS not found — fallback to ZIP
        goto :ZIP_FALLBACK
    )
)

:: ── Compile with NSIS ────────────────────────────────
echo Compiling with NSIS...
"%NSIS_EXE%" /DVERSION=%APP_VERSION% setup.nsi
if %errorlevel% equ 0 (
    :: Find the generated installer
    for %%f in ("output\Kasalix-AI-Chat-Server-Setup-*.exe") do set "SETUP_FILE=%%~nxf"
    echo.
    echo ╔══════════════════════════════════════════════════╗
    echo ║  SUCCESS!                                       ║
    echo ║  Installer created:                             ║
    if defined SETUP_FILE (
        echo ║    output\%SETUP_FILE%                        ║
    ) else (
        echo ║    output\Kasalix-AI-Chat-Server-Setup-%APP_VERSION%.exe  ║
    )
    echo ║                                                  ║
    echo ║  NSIS is open-source and 100%% free for           ║
    echo ║  commercial use. No license required.            ║
    echo ╚══════════════════════════════════════════════════╝
    echo.
    pause
    exit /b 0
) else (
    echo [ERROR] NSIS compilation failed.
    echo.
    echo You can right-click setup.nsi and select "Compile NSIS Script".
    pause
    exit /b 1
)

:ZIP_FALLBACK
:: Fallback: create a portable ZIP archive
echo NSIS not found. Creating portable ZIP instead...
echo.
echo To build the Setup.exe installer:
echo   1. Install NSIS from: https://nsis.sourceforge.io/Download
echo   2. Right-click setup.nsi ^> "Compile NSIS Script"
echo      Or run: "^%ProgramFiles(x86)^%\NSIS\makensis" setup.nsi
echo.
echo Creating portable archive...

:: Set a clean env var name (no dots) for PowerShell compatibility
set "SERVER_APP_VER=%APP_VERSION%"

:: Use PowerShell to create the ZIP
powershell -NoProfile -Command ^
    "$staging = Join-Path (Get-Location) 'staging';" ^
    "$ver = [Environment]::GetEnvironmentVariable('SERVER_APP_VER','Process');" ^
    "$zipPath = Join-Path (Get-Location) ('output\Kasalix-AI-Chat-Server-Portable-' + $ver + '.zip');" ^
    "if (Test-Path $staging) { Remove-Item $staging -Recurse -Force };" ^
    "New-Item -ItemType Directory -Path $staging -Force | Out-Null;" ^
    "Copy-Item -Path (Join-Path (Get-Location) '..\backend') -Destination (Join-Path $staging 'backend') -Recurse -Force;" ^
    "Copy-Item -Path (Join-Path (Get-Location) '..\frontend\dist') -Destination (Join-Path $staging 'frontend\dist') -Recurse -Force;" ^
    "Copy-Item -Path (Join-Path (Get-Location) '..\certs\*') -Destination (Join-Path $staging 'certs') -Force;" ^
    "Copy-Item -Path (Join-Path (Get-Location) 'run-server.bat') -Destination $staging -Force;" ^
    "Copy-Item -Path (Join-Path (Get-Location) 'stop-server.bat') -Destination $staging -Force;" ^
    "if (Test-Path $zipPath) { Remove-Item $zipPath -Force };" ^
    "Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipPath;" ^
    "Remove-Item $staging -Recurse -Force;" ^
    "Write-Host 'Created:' $zipPath"

echo.
if exist "output\Kasalix-AI-Chat-Server-Portable-%APP_VERSION%.zip" (
    echo ╔══════════════════════════════════════════════════════════╗
    echo ║  Portable archive created:                              ║
    echo ║    output\Kasalix-AI-Chat-Server-Portable-%APP_VERSION%.zip ║
    echo ║                                                         ║
    echo ║  For a proper Setup.exe:                                ║
    echo ║    1. Install NSIS: nsis.sourceforge.io/Download          ║
    echo ║    2. Right-click setup.nsi ^> Compile NSIS Script        ║
    echo ╚══════════════════════════════════════════════════════════╝
) else (
    echo [WARN] Could not create ZIP archive. Files are ready for manual packaging.
)
echo.
pause
