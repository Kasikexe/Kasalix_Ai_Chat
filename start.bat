@echo off
setlocal enabledelayedexpansion

title AI Chat - Ollama Client

echo =============================================
echo    AI Chat Client for Ollama
echo =============================================
echo.

REM Check for Ollama
where ollama >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Ollama is not installed or not in PATH.
    echo Download from: https://ollama.com/download
    echo.
    pause
    exit /b 1
)

REM Check if Ollama is already running
curl -s http://localhost:11434/api/tags >nul 2>nul
if %errorlevel% neq 0 (
    echo [INFO] Starting Ollama server...
    start "Ollama" /min cmd /c "ollama serve"
    timeout /t 3 /nobreak >nul
)

REM Verify Ollama is responding
curl -s http://localhost:11434/api/tags >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Could not connect to Ollama at http://localhost:11434
    echo Make sure it's running: ollama serve
    echo.
    pause
    exit /b 1
)

echo [OK] Ollama is running
echo.

REM Install backend dependencies if needed
if not exist "backend\node_modules" (
    echo [INFO] Installing backend dependencies...
    pushd backend
    call bun install
    if %errorlevel% neq 0 (
        echo [ERROR] Bun install failed. Make sure Bun is installed: https://bun.sh
        popd
        pause
        exit /b 1
    )
    popd
)

REM Install frontend dependencies if needed
if not exist "frontend\node_modules" (
    echo [INFO] Installing frontend dependencies...
    pushd frontend
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed.
        popd
        pause
        exit /b 1
    )
    popd
)

echo [OK] Dependencies ready
echo.

REM Start backend in a new window
echo [INFO] Starting backend on https://localhost:3001 ...
start "AI Chat - Backend" cmd /k "cd /d %~dp0backend && bun run dev"

REM Wait a moment for backend to initialize
timeout /t 2 /nobreak >nul

REM Start frontend in a new window
echo [INFO] Starting frontend on https://localhost:5173 ...
start "AI Chat - Frontend" cmd /k "cd /d %~dp0frontend && npm run dev"

echo.
echo =============================================
echo   Both servers are starting up!
echo.
echo   Frontend:  https://localhost:5173
echo   Backend:   https://localhost:3001
echo   Ollama:    http://localhost:11434
echo.
echo   Note: Self-signed certs — accept the security warning in your browser.
echo   Close the terminal windows to stop.
echo =============================================
echo.
pause
