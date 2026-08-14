; Kasalix AI Chat Server — NSIS Installer Script
; NSIS (Nullsoft Scriptable Install System) is open-source under the zlib/libpng license.
; Completely free for commercial use - no license purchase required.
;
; To compile: Install NSIS from https://nsis.sourceforge.io/Download
; Then right-click this file -> "Compile NSIS Script"
; Or run: makensis setup.nsi

!define PRODUCT_NAME "Kasalix AI Chat Server"
!define PRODUCT_VERSION "0.10.15"

; Allow override from command line: makensis /DVERSION=x.x.x setup.nsi
!ifdef VERSION
  !undef PRODUCT_VERSION
  !define PRODUCT_VERSION "${VERSION}"
!endif
!define PRODUCT_PUBLISHER "Kasik"
!define PRODUCT_WEB_SITE "https://kasalix.app"
!define PRODUCT_DIR_REGKEY "Software\Microsoft\Windows\CurrentVersion\App Paths\Kasalix AI Chat Server\Kasalix-AI-Chat-Server.exe"
!define PRODUCT_UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"
!define PRODUCT_UNINST_ROOT_KEY "HKLM"

; Application display name — defines $(^Name) so the uninstall entry,
; MUI pages, and window titles use the real product name instead of the
; literal string "Name".
Name "${PRODUCT_NAME}"

; Set compression — zlib (commercially friendly license)
SetCompressor zlib

; Request admin privileges
RequestExecutionLevel admin

; Modern UI (built-in, no extra plugins needed)
!include "MUI2.nsh"

; ---- Modern UI Settings ----
!define MUI_ABORTWARNING
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"
!define MUI_HEADERIMAGE
!define MUI_COMPONENTSPAGE_SMALLDESC

; ---- Page definitions ----
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "..\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\Kasalix-AI-Chat-Server.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start Kasalix AI Chat Server now"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

; ---- Language ----
!insertmacro MUI_LANGUAGE "English"

; ---- Output file ----
OutFile "output\Kasalix-AI-Chat-Server-Setup-${PRODUCT_VERSION}.exe"

; ---- Version info ----
VIProductVersion "${PRODUCT_VERSION}.0"
VIAddVersionKey /LANG=${LANG_ENGLISH} "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=${LANG_ENGLISH} "FileDescription" "${PRODUCT_NAME} Installer"
VIAddVersionKey /LANG=${LANG_ENGLISH} "LegalCopyright" "${PRODUCT_PUBLISHER}"

; ---- Default installation directory ----
; Using LOCALAPPDATA instead of Program Files because Bun needs write access
; for lockfiles, logs, and runtime data. Program Files is read-only for non-admin users.
InstallDir "$LOCALAPPDATA\${PRODUCT_NAME}"
InstallDirRegKey HKLM "${PRODUCT_DIR_REGKEY}" ""

; ---- Show details ----
ShowInstDetails show
ShowUnInstDetails show

; ══════════════════════════════════════════════════════════════
; Section: Main Installation
; ══════════════════════════════════════════════════════════════
Section "Server Files" SEC_MAIN
    SetOutPath "$INSTDIR"

    ; Copy backend (runtime code + deps only — NEVER bundle the local data/ dir
    ; or .env, otherwise every install ships the builder's accounts,
    ; conversations, speed test results, and plaintext settings password)
    File /r /x "node_modules" /x ".git" /x "data" /x "generated_images" /x ".env" "..\backend\*.*"

    ; Copy frontend dist
    SetOutPath "$INSTDIR\frontend\dist"
    File /r "..\frontend\dist\*.*"

    ; Copy certificates
    SetOutPath "$INSTDIR\certs"
    File /nonfatal "..\certs\*.*"

    ; Create release directory for auto-update files
    SetOutPath "$INSTDIR\release"
    ; Create placeholder (empty directory won't be created by NSIS)
    File /nonfatal "..\release\.gitkeep"

    ; Copy start/stop scripts (to root) — kept as fallback
    SetOutPath "$INSTDIR"
    File "run-server.bat"
    File "stop-server.bat"

    ; Copy the Server GUI Electron app
    SetOutPath "$INSTDIR"
    File /nonfatal "..\server-gui\release\Kasalix-AI-Chat-Server*.exe"

    ; Copy legal / license files (Apache-2.0 LICENSE + NOTICE + third-party notices)
    SetOutPath "$INSTDIR"
    File "..\LICENSE"
    File "..\NOTICE"
    File "..\THIRD_PARTY_NOTICES.md"

    ; Create uninstaller
    WriteUninstaller "$INSTDIR\uninstall.exe"

    ; Registry: add to Add/Remove Programs
    WriteRegStr ${PRODUCT_UNINST_ROOT_KEY} "${PRODUCT_UNINST_KEY}" "DisplayName" "${PRODUCT_NAME}"
    WriteRegStr ${PRODUCT_UNINST_ROOT_KEY} "${PRODUCT_UNINST_KEY}" "UninstallDisplayIcon" "$INSTDIR\Kasalix-AI-Chat-Server.exe"
    WriteRegStr ${PRODUCT_UNINST_ROOT_KEY} "${PRODUCT_UNINST_KEY}" "UninstallString" "$INSTDIR\uninstall.exe"
    WriteRegStr ${PRODUCT_UNINST_ROOT_KEY} "${PRODUCT_UNINST_KEY}" "DisplayIcon" "$INSTDIR\Kasalix-AI-Chat-Server.exe"
    WriteRegStr ${PRODUCT_UNINST_ROOT_KEY} "${PRODUCT_UNINST_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
    WriteRegStr ${PRODUCT_UNINST_ROOT_KEY} "${PRODUCT_UNINST_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
    WriteRegStr ${PRODUCT_UNINST_ROOT_KEY} "${PRODUCT_UNINST_KEY}" "URLInfoAbout" "${PRODUCT_WEB_SITE}"
    WriteRegStr ${PRODUCT_UNINST_ROOT_KEY} "${PRODUCT_UNINST_KEY}" "NoModify" "1"
    WriteRegStr ${PRODUCT_UNINST_ROOT_KEY} "${PRODUCT_UNINST_KEY}" "NoRepair" "1"

    ; Clean up stale uninstall entries from older installs (old product name)
    DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\AI Chat Server"

    ; Create shortcuts — main shortcut points to the GUI app
    CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
    CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk" "$INSTDIR\Kasalix-AI-Chat-Server.exe" "" "$INSTDIR\Kasalix-AI-Chat-Server.exe" 0
    CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\Stop Server.lnk" "$INSTDIR\stop-server.bat" "" "$INSTDIR\stop-server.bat" 0
    CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\Uninstall.lnk" "$INSTDIR\uninstall.exe"
    CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\Kasalix-AI-Chat-Server.exe" "" "$INSTDIR\Kasalix-AI-Chat-Server.exe" 0
SectionEnd

; NOTE: Bun check is handled by run-server.bat when the user starts the server.
; The installer does not check for Bun — keeping it simple with no external plugins.

; ══════════════════════════════════════════════════════════════
; Uninstaller
; ══════════════════════════════════════════════════════════════
Section "Uninstall"
    ; Stop the server first (ExecWait waits for it to finish)
    ExecWait '"$INSTDIR\stop-server.bat"'

    ; Remove shortcuts
    Delete "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk"
    Delete "$SMPROGRAMS\${PRODUCT_NAME}\Stop Server.lnk"
    Delete "$SMPROGRAMS\${PRODUCT_NAME}\Uninstall.lnk"
    RmDir "$SMPROGRAMS\${PRODUCT_NAME}"
    Delete "$DESKTOP\${PRODUCT_NAME}.lnk"

    ; Remove registry keys
    DeleteRegKey ${PRODUCT_UNINST_ROOT_KEY} "${PRODUCT_UNINST_KEY}"
    DeleteRegKey HKLM "${PRODUCT_DIR_REGKEY}"
    ; Clean up stale uninstall entries from older installs (old product name)
    DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\AI Chat Server"

    ; Remove installed files
    RmDir /r "$INSTDIR\backend"
    RmDir /r "$INSTDIR\frontend"
    RmDir /r "$INSTDIR\certs"
    RmDir /r "$INSTDIR\release"
    RmDir /r "$INSTDIR\ffmpeg"
    Delete "$INSTDIR\LICENSE"
    Delete "$INSTDIR\NOTICE"
    Delete "$INSTDIR\THIRD_PARTY_NOTICES.md"
    RmDir /r "$INSTDIR\licenses"
    Delete "$INSTDIR\run-server.bat"
    Delete "$INSTDIR\stop-server.bat"
    Delete "$INSTDIR\Kasalix-AI-Chat-Server.exe"
    Delete "$INSTDIR\uninstall.exe"
    RmDir "$INSTDIR"

    SetAutoClose true
SectionEnd
