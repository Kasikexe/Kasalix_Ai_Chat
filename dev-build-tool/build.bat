@echo off
setlocal enabledelayedexpansion
TITLE Kasalix AI Chat - Developer Build Tool

:: ── Determine script directory (works even when run from other locations) ──
set "SCRIPT_DIR=%~dp0"
set "FRONTEND_DIR=%SCRIPT_DIR%..\frontend"

:: ── Detect package manager ──────────────────────────
set PKG_MANAGER=npm
where bun >nul 2>&1
if %errorlevel% equ 0 set PKG_MANAGER=bun
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  ERROR: Node.js is not installed. Install Node.js from https://nodejs.org
    echo.
    pause
    exit /b 1
)

:: ── Check for build-config.json ─────────────────────
if not exist "%FRONTEND_DIR%\build-config.json" (
    echo { "version": "1.0.0", "productName": "Kasalix AI Chat", "appId": "com.aichat.desktop", "iconPath": "", "description": "AI Chat Desktop Application", "author": "", "lastBuild": null } > "%FRONTEND_DIR%\build-config.json"
)

:: ── Load current version ────────────────────────────
for /f "tokens=1,2 delims=," %%a in (`node -e "const c=JSON.parse(require('fs').readFileSync('%FRONTEND_DIR%\\build-config.json','utf-8'));console.log(c.version+','+c.productName);" 2^>nul`) do (
    set "CURRENT_VER=%%a"
    set "APP_NAME=%%b"
)
if not defined CURRENT_VER set "CURRENT_VER=1.0.0"
if not defined APP_NAME set "APP_NAME=Kasalix AI Chat"

cls

:MENU
echo.
echo  ╔════════════════════════════════════════════════╗
echo  ║    Kasalix AI Chat - Developer Build Tool    ║
echo  ╚════════════════════════════════════════════════╝
echo.
echo  Version: %CURRENT_VER%
echo  App:     %APP_NAME%
echo  Manager: %PKG_MANAGER%
echo.
echo  ──────────────────────────────────────────────
echo.
echo  [1] Build Electron EXE
echo  [2] Build Android APK
echo  [3] Build Both (EXE + APK)
echo  [4] Interactive Mode (version config + build)
echo.
echo  [Q] Quit
echo.
set /p CHOICE="  Select option: "

if "%CHOICE%"=="1" goto :BUILD_EXE
if "%CHOICE%"=="2" goto :BUILD_APK
if "%CHOICE%"=="3" goto :BUILD_BOTH
if /i "%CHOICE%"=="4" goto :INTERACTIVE
if /i "%CHOICE%"=="Q" goto :EOF

echo.
echo  Invalid option. Press any key to try again...
pause >nul
cls
goto :MENU

:INTERACTIVE
echo.
echo  Starting interactive build menu...
echo.
cd /d "%SCRIPT_DIR%"
%PKG_MANAGER% run build-interactive
if %errorlevel% neq 0 (
    echo.
    echo  Build interrupted or failed.
)
echo.
pause
goto :EOF

:BUILD_EXE
echo.
echo  ──── Building Electron EXE ─────────────────────
echo.
cd /d "%SCRIPT_DIR%"
%PKG_MANAGER% run build-electron
if %errorlevel% equ 0 (
    echo.
    echo  ✅ EXE build complete!
    echo  Output: %SCRIPT_DIR%..\release\
) else (
    echo.
    echo  ❌ EXE build failed. Check errors above.
)
echo.
pause
goto :EOF

:BUILD_APK
echo.
echo  ──── Building Android APK ──────────────────────
echo.
cd /d "%SCRIPT_DIR%"
%PKG_MANAGER% run build-android
if %errorlevel% equ 0 (
    echo.
    echo  ✅ APK build complete!
    echo  Output: %SCRIPT_DIR%..\release\
) else (
    echo.
    echo  ❌ APK build failed. Check errors above.
)
echo.
pause
goto :EOF

:BUILD_BOTH
echo.
echo  ──── Building Electron EXE + Android APK ──────
echo.
cd /d "%SCRIPT_DIR%"
%PKG_MANAGER% run build-all
if %errorlevel% equ 0 (
    echo.
    echo  ✅ Both builds complete!
) else (
    echo.
    echo  ❌ One or both builds failed.
)
echo.
pause
goto :EOF
