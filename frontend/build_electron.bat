@echo off
TITLE AI Chat - Build Desktop App

echo.
echo  ╔════════════════════════════════════════════════╗
echo  ║     AI Chat Desktop App - Build Pipeline      ║
echo  ╚════════════════════════════════════════════════╝
echo.

:: ── Detect package manager ──────────────────────────
where bun >nul 2>&1
if %errorlevel% equ 0 (
    set PKG_MANAGER=bun
    goto :cleanup
)
where npm >nul 2>&1
if %errorlevel% equ 0 (
    set PKG_MANAGER=npm
    goto :cleanup
)
echo  ERROR: Neither Bun nor npm is installed. Install Node.js first.
echo.
pause
exit /b 1

:: ── Clean previous builds ───────────────────────────
:cleanup
echo  [Step 1/4] Cleaning previous build artifacts...
echo.
:: Kill any running instances of the old build
taskkill /f /im "AI Chat.exe" >nul 2>&1
taskkill /f /im "AI-Chat-Portable-*.exe" >nul 2>&1

if exist "release" (
    rmdir /s /q "release" >nul 2>&1
    if exist "release" (
        echo  ⚠️  Could not delete release folder.
        echo     Close any running AI Chat.exe and try again.
        echo.
        pause
        exit /b 1
    )
    echo     Cleaned release directory.
)

:: Clean corrupted electron-builder cache if any
if exist "%USERPROFILE%\AppData\Local\electron-builder\Cache\winCodeSign" (
    rmdir /s /q "%USERPROFILE%\AppData\Local\electron-builder\Cache\winCodeSign" 2>nul
    echo     Cleaned electron-builder cache.
)
echo.
echo  ─────────────────────────────────────────────────
echo.

:: ── Install dependencies ───────────────────────────
echo  [Step 2/4] Installing dependencies...
echo  Using: %PKG_MANAGER%
echo.
%PKG_MANAGER% install
if %errorlevel% neq 0 (
    echo  ERROR: Dependency installation failed.
    pause
    exit /b 1
)
echo.
echo  ─────────────────────────────────────────────────
echo.

:: ── Build frontend with Vite ──────────────────────
echo  [Step 3/4] Building frontend with Vite...
echo.
%PKG_MANAGER% run build
if %errorlevel% neq 0 (
    echo  ERROR: Frontend build failed.
    pause
    exit /b 1
)
echo.
echo  ─────────────────────────────────────────────────
echo.

:: ── Launch interactive config + Electron build ────
echo  [Step 4/4] Configuring and building Electron app...
echo.
echo  Tip: Use option [4] or [5] in the menu to start the build.
echo       Always bump the version (option 1) for auto-update!
echo.
echo  ─────────────────────────────────────────────────
echo.

:: Run the interactive config script
%PKG_MANAGER% run configure-build
if %errorlevel% neq 0 (
    echo.
    echo  ============================================
    echo   TIP: If the build failed with a symbolic link
    echo   error, try running this .bat file as
    echo   Administrator, or enable Windows Developer
    echo   Mode in Settings ^> Privacy ^& Security ^> For developers.
    echo  ============================================
    pause
    exit /b 1
)

echo.
pause
