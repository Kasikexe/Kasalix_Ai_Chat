@echo off
title Kasalix Changelog Tool
cd /d "%~dp0changelog-tool"

:: Load token from .env if GH_TOKEN is not already set
if "%GH_TOKEN%"=="" (
  if exist ".env" (
    for /f "tokens=1,* delims==" %%a in ('findstr /b "GH_TOKEN" .env') do set "GH_TOKEN=%%b"
  )
)

node index.js %*
echo.
echo Press any key to exit...
pause >nul
