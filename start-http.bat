@echo off
title AI Chat - HTTP Mode

echo =============================================
echo    AI Chat - HTTP Mode (for phone/Android)
echo =============================================
echo.
echo Starting in HTTP mode so phones can connect
echo without HTTPS certificate errors.
echo.
echo    After it starts, open your phone browser to:
echo    http://[PC-IP]:3001/download
echo.
echo =============================================
echo.

start.bat --http
