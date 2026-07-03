@echo off
title Stop AI Chat

echo Stopping AI Chat servers...
echo.

REM Kill processes by port (requires Git Bash, WSL, or netstat approach)
echo Closing ports 3001 and 5173...

for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3001" ^| findstr "LISTENING"') do (
    echo Stopping backend (PID %%a)...
    taskkill /F /PID %%a >nul 2>nul
)

for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":5173" ^| findstr "LISTENING"') do (
    echo Stopping frontend (PID %%a)...
    taskkill /F /PID %%a >nul 2>nul
)

echo.
echo Done. Note: Ollama is left running in the background.
pause
