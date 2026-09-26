; Kasalix AI Chat Server - NSIS Installer Script (Python backend)
; NSIS (Nullsoft Scriptable Install System) is open-source under the zlib/libpng license.
; Completely free for commercial use - no license purchase required.
;
; This variant ships the PyInstaller-built Python backend (backend.exe + _internal\)
; instead of the Bun/TypeScript source. Build with:
;   makensis /DVERSION=x.x.x setup.nsi
; or via build-setup.bat.

!define PRODUCT_NAME "Kasalix AI Chat Server"
!define PRODUCT_VERSION "0.12.0"

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

; Application display name - defines $(^Name) so the uninstall entry,
; MUI pages, and window titles use the real product name instead of the
; literal string "Name".
Name "${PRODUCT_NAME}"

; Set compression - zlib (commercially friendly license)
SetCompressor zlib

; Request admin privileges
RequestExecutionLevel admin

; Modern UI (built-in, no extra plugins needed)
!include "MUI2.nsh"
!include "LogicLib.nsh"

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
; Using LOCALAPPDATA instead of Program Files because the server needs write
; access for logs, runtime data, and generated images. Program Files is
; read-only for non-admin users.
InstallDir "$LOCALAPPDATA\${PRODUCT_NAME}"
InstallDirRegKey HKLM "${PRODUCT_DIR_REGKEY}" ""

; ---- Show details ----
ShowInstDetails show
ShowUnInstDetails show

; ================================================================
; Section: Main Installation
; ================================================================
Section "Server Files" SEC_MAIN
    SetOutPath "$INSTDIR"

    ; Copy the self-contained Python backend (backend.exe + _internal\ bundled
    ; runtime). NEVER bundle any local data/ dir or .env - each install must
    ; start with a clean slate (accounts, conversations, settings).
    ; PyInstaller layout: backend/dist/backend with backend.exe and _internal
    SetOutPath "$INSTDIR\backend"
    File /r /x "data" /x ".env" "..\backend\dist\backend\*.*"

    ; Copy frontend dist
    SetOutPath "$INSTDIR\frontend\dist"
    File /r "..\frontend\dist\*.*"

    ; Copy certificate generator (NOT the certs themselves - each install
    ; generates unique certs; the Python backend also auto-generates them)
    SetOutPath "$INSTDIR\certs"
    File "..\certs\generate-certs.cjs"

    ; Create release directory for auto-update files
    SetOutPath "$INSTDIR\release"
    ; Create placeholder (empty directory won't be created by NSIS)
    File /nonfatal "..\release\.gitkeep"

    ; Copy start/stop scripts (to root) - installed under the canonical names
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

    ; Create shortcuts - main shortcut points to the GUI app
    CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
    CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\${PRODUCT_NAME}.lnk" "$INSTDIR\Kasalix-AI-Chat-Server.exe" "" "$INSTDIR\Kasalix-AI-Chat-Server.exe" 0
    CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\Stop Server.lnk" "$INSTDIR\stop-server.bat" "" "$INSTDIR\stop-server.bat" 0
    CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\Uninstall.lnk" "$INSTDIR\uninstall.exe"
    CreateShortCut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\Kasalix-AI-Chat-Server.exe" "" "$INSTDIR\Kasalix-AI-Chat-Server.exe" 0

    ; Windows Firewall: allow inbound connections on the server port so other
    ; devices on ANY network type (Ethernet, Wi-Fi, Public) can reach the
    ; server. Without this, Windows silently drops LAN clients — they "connect
    ; then fail". A dedicated rule scoped to the exe avoids the "allow on
    ; public networks" prompt entirely.
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Kasalix AI Chat Server"'
    nsExec::ExecToLog 'netsh advfirewall firewall add rule name="Kasalix AI Chat Server" dir=in action=allow program="$INSTDIR\backend\backend.exe" protocol=TCP localport=3001 profile=any'
SectionEnd

; The Python backend is self-contained (PyInstaller) - no Bun/node_modules
; runtime needed. Certificates are auto-generated by the backend on first run,
; or by the Server GUI via certs\generate-certs.cjs.

; ================================================================
; Uninstaller
; ================================================================
Section "Uninstall"
    ; Stop the server first (ExecWait waits for it to finish)
    ExecWait '"$INSTDIR\stop-server.bat"'

    ; Remove the firewall rule added during install
    nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="Kasalix AI Chat Server"'

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

; ================================================================
; In-app self-update: after a SUCCESSFUL SILENT install (launched by
; the running app's updater), start the freshly installed app so the
; update round-trips without the user clicking anything.
; ================================================================
Function .onInstSuccess
  ${If} ${Silent}
    Exec '"$INSTDIR\Kasalix-AI-Chat-Server.exe"'
  ${EndIf}
FunctionEnd
