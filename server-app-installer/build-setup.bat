@echo off
setlocal enabledelayedexpansion
title Kasalix AI Chat Server - Build Setup (Python backend)

cd /d "%~dp0"

echo ============================================================
echo   Kasalix AI Chat Server - Build Installer
echo   (Python / FastAPI backend)
echo ============================================================
echo.

:: ---- 1. Check prerequisites ----------------------------------

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is required. Download from: https://nodejs.org
    pause
    exit /b 1
)

:: Python is required for the backend (PyInstaller build + venv)
set "PYTHON=python"
where python >nul 2>nul
if %errorlevel% neq 0 (
    echo [WARN] 'python' not found on PATH - trying 'py' launcher...
    set "PYTHON=py -3"
)
echo   Python: %PYTHON%
echo.

:: ---- 2. Read version -----------------------------------------

echo [1/7] Reading version...
for /f "usebackq delims=" %%a in (`node -e "const p=require('../frontend/package.json');console.log(p.version)"`) do set "CURRENT_VERSION=%%a"
if not defined CURRENT_VERSION set "CURRENT_VERSION=1.0.0"
echo   Version: %CURRENT_VERSION%
echo.

:: ---- 3. Build Python backend (venv + PyInstaller exe) --------

echo [2/7] Building Python backend...
pushd ..\backend
if not exist ".venv" (
    echo   Creating virtual environment...
    %PYTHON% -m venv .venv
    if !errorlevel! neq 0 (
        echo [ERROR] Failed to create venv. Install Python 3.12+ from https://www.python.org
        popd
        pause
        exit /b 1
    )
) else (
    echo   venv already exists - skipping
)

:: Install runtime + build deps into the venv.
:: The venv may have been created by uv, which does NOT bundle pip - so detect
:: pip and bootstrap it via ensurepip before installing anything.
echo   Installing dependencies...
set "VENV_PY=.venv\Scripts\python.exe"
call %VENV_PY% -m pip --version >nul 2>nul
if %errorlevel% neq 0 (
    echo   pip not present - bootstrapping via ensurepip...
    call %VENV_PY% -m ensurepip --upgrade
    if !errorlevel! neq 0 (
        echo [ERROR] Could not bootstrap pip - ensurepip failed.
        popd
        pause
        exit /b 1
    )
)
call %VENV_PY% -m pip install --upgrade pip -q
if %errorlevel% neq 0 (
    echo [ERROR] pip upgrade failed.
    popd
    pause
    exit /b 1
)

:: Uninstall the project's own editable install if present. A uv-created venv
:: may have `kasalix-backend` installed with `-e`, whose .pth hook shadows the
:: stdlib `types` module (app/types.py) and crashes the PyInstaller build.
:: The app runs as app.main from source and never needs to be installed.
call %VENV_PY% -m pip uninstall -y kasalix-backend >nul 2>nul

:: Skip the dependency install when a previous run already validated it.
:: requirements-build.txt is hashed so editing the file (adding/updating a
:: package) automatically invalidates the cache.
set "DEPS_STAMP=.venv\deps.stamp"
set "DEPS_HASH="
for /f "usebackq delims=" %%h in (`powershell -NoProfile -Command "(Get-FileHash -Algorithm SHA256 requirements-build.txt).Hash"`) do set "DEPS_HASH=%%h"
if exist "%DEPS_STAMP%" (
    set /p STAMPED_HASH=<"%DEPS_STAMP%"
) else (
    set "STAMPED_HASH=none"
)
if not "!STAMPED_HASH!"=="!DEPS_HASH!" (
    call %VENV_PY% -m pip install -r requirements-build.txt -q
    if !errorlevel! neq 0 (
        echo [ERROR] Python dependency install failed.
        popd
        pause
        exit /b 1
    )
    echo !DEPS_HASH!>"%DEPS_STAMP%"
) else (
    echo   Dependencies up to date - skipping
)

:: Build the self-contained backend.exe via PyInstaller
echo   Compiling backend.exe (PyInstaller)...
call %VENV_PY% -m PyInstaller --noconfirm build\backend.spec
if %errorlevel% neq 0 (
    echo [ERROR] PyInstaller build failed.
    popd
    pause
    exit /b 1
)
popd
echo.
echo   Backend exe: backend\dist\backend\backend.exe
echo.

:: ---- 4. Build frontend (skip install if exists) ---------------

echo [3/7] Building frontend...
pushd ..\frontend
if not exist "node_modules" (
    echo   Installing dependencies...
    if exist "..\server-gui\node_modules\.bin\bun.exe" (call ..\server-gui\node_modules\.bin\bun.exe install) else (call npm install --prefer-offline)
) else (
    echo   Dependencies already installed - skipping
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

:: ---- 5. Build Server GUI (skip install if exists) -------------

echo [4/7] Building Server GUI...
pushd ..\server-gui
if not exist "node_modules" (
    echo   Installing dependencies...
    call npm install --prefer-offline
    if %errorlevel% neq 0 (
        echo [ERROR] Server GUI install failed.
        popd
        pause
        exit /b 1
    )
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

:: ---- 6. Create output directory -------------------------------

echo [5/7] Preparing output...
if not exist "output" mkdir output
echo.

:: ---- 7. Build the Setup.exe -----------------------------------

echo [6/7] Creating installer...
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

:: Compile with NSIS (canonical setup.nsi)
echo Compiling with NSIS...
"%NSIS_EXE%" /DVERSION=%APP_VERSION% setup.nsi
if %errorlevel% equ 0 (
    for %%f in ("output\Kasalix-AI-Chat-Server-Setup-*.exe") do set "SETUP_FILE=%%~nxf"
    echo.
    echo ============================================================
    echo   SUCCESS!
    echo   Installer created:
    if defined SETUP_FILE (
        echo     output\%SETUP_FILE%
    ) else (
        echo     output\Kasalix-AI-Chat-Server-Setup-%APP_VERSION%.exe
    )
    echo ============================================================
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
    "Copy-Item -Path (Join-Path (Get-Location) '..\backend\dist\backend') -Destination (Join-Path $staging 'backend') -Recurse -Force;" ^
    "Copy-Item -Path (Join-Path (Get-Location) '..\frontend\dist') -Destination (Join-Path $staging 'frontend\dist') -Recurse -Force;" ^
    "Copy-Item -Path (Join-Path (Get-Location) '..\certs') -Destination (Join-Path $staging 'certs') -Recurse -Force;" ^
    "Copy-Item -Path (Join-Path (Get-Location) 'run-server.bat') -Destination (Join-Path $staging 'run-server.bat') -Force;" ^
    "Copy-Item -Path (Join-Path (Get-Location) 'stop-server.bat') -Destination (Join-Path $staging 'stop-server.bat') -Force;" ^
    "if (Test-Path $zipPath) { Remove-Item $zipPath -Force };" ^
    "Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipPath;" ^
    "Remove-Item $staging -Recurse -Force;" ^
    "Write-Host 'Created:' $zipPath"

echo.
if exist "output\Kasalix-AI-Chat-Server-Portable-%APP_VERSION%.zip" (
    echo ============================================================
    echo   Portable archive created:
    echo     output\Kasalix-AI-Chat-Server-Portable-%APP_VERSION%.zip
    echo ============================================================
)
echo.
pause