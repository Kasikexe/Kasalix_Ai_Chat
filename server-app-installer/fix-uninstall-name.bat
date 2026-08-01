@echo off
setlocal
title Fix Kasalix AI Chat Server - Uninstall Entry Name

:: ── Require Administrator (HKLM registry writes need elevation) ──
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo  [UAC] This fix needs Administrator privileges.
    echo        Relaunching elevated...
    echo.
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

echo.
echo  Fixing the server uninstall entry name ("Name" -> "Kasalix AI Chat Server")...
echo.

:: ── 1. Fix the CURRENT server uninstall entry display name ──
reg add "HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Kasalix AI Chat Server" /v DisplayName /t REG_SZ /d "Kasalix AI Chat Server" /f
reg add "HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Kasalix AI Chat Server" /v UninstallDisplayIcon /t REG_SZ /d "%LOCALAPPDATA%\Kasalix AI Chat Server\Kasalix-AI-Chat-Server.exe" /f

:: ── 2. Also fix the 64-bit view if an entry ever exists there ──
reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Kasalix AI Chat Server" /v DisplayName /t REG_SZ /d "Kasalix AI Chat Server" /f >nul 2>&1

:: ── 3. Remove the STALE old "AI Chat Server" entry (v1.6.0, dir no longer used) ──
if not exist "%LOCALAPPDATA%\AI Chat Server\uninstall.exe" (
    echo  Removing stale old uninstall entry "AI Chat Server"...
    reg delete "HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\AI Chat Server" /f
    reg delete "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\AI Chat Server" /f >nul 2>&1
) else (
    echo  Old "AI Chat Server" install folder still exists - keeping its entry.
)

echo.
echo  Done! The server app should now appear as "Kasalix AI Chat Server"
echo  in Windows Settings - Apps - Installed apps.
echo.
pause
