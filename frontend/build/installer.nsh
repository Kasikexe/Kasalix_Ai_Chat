; ============================================================================
; Custom installer behavior for "Kasalix AI Chat" (Windows Client)
;
; electron-builder's default NSIS template checks whether the app is already
; running and shows a dialog ("Kasalix AI Chat is running. Click OK to close
; it..."). With oneClick + allowElevation, that dialog can end up hidden
; behind the UAC elevation prompt, which makes the installer look permanently
; stuck on "app is running".
;
; This file overrides the electron-builder NSIS hooks so the app is closed
; SILENTLY and RELIABLY, with no dialogs and no waiting:
;
;   - customInit:            runs inside .onInit, BEFORE the template's
;                            running-check. Kills the app immediately, so the
;                            check that follows finds nothing and no dialog can
;                            ever be shown.
;   - customCheckAppRunning: replaces the dialog-based check entirely with a
;                            silent close + verify loop (used by both the
;                            installer and the uninstaller).
;   - customUnInit:          same protection at uninstaller startup.
;   - customUnInstallCheck / customUnInstallCheckCurrentUser:
;                            if the OLD version's uninstaller fails during an
;                            upgrade (e.g. it was built without these hooks and
;                            can't close a leftover process), log a warning and
;                            CONTINUE the install instead of hard-aborting with
;                            "Failed to uninstall old application files".
;
; BOTH the current executable name AND the legacy "AI Chat.exe" name are
; killed, because an older install may still run under the old product name.
; ============================================================================

; LogicLib (${If}, ${Do}...) — guarded, so double-include is safe.
!include "LogicLib.nsh"

; ── Silent close routine (shared) ─────────────────────────
; Tries a graceful close first, then force-kills, then waits until the process
; is really gone (bounded retries). NEVER shows a dialog.
; Uses $R0/$R1 as scratch registers.
!macro _KasalixKillOne APPEXE
  ; 1) Graceful close
  nsExec::Exec `taskkill /im "${APPEXE}"`
  Pop $R0
  Sleep 400

  ; 2) Is it still running? (nsProcess returns 0 when the process exists)
  nsProcess::_FindProcess "${APPEXE}"
  Pop $R0
  ${If} $R0 == 0
    ; 3) Force-kill the stubborn instance
    nsExec::Exec `taskkill /f /im "${APPEXE}"`
    Pop $R0
    Sleep 400
  ${EndIf}
!macroend

!macro _KasalixSilentCloseApp
  StrCpy $R1 0
  ${Do}
    ; Kill the current exe name AND the legacy one
    !insertmacro _KasalixKillOne "${APP_EXECUTABLE_FILENAME}"
    !insertmacro _KasalixKillOne "AI Chat.exe"
    !insertmacro _KasalixKillOne "ai-chat-frontend.exe"

    IntOp $R1 $R1 + 1
    ${If} $R1 >= 10
      ; Give up after ~30 seconds of trying - don't freeze the installer.
      ${Break}
    ${EndIf}

    ; 4) Verify everything actually exited before looping again
    nsProcess::_FindProcess "${APP_EXECUTABLE_FILENAME}"
    Pop $R0
    ${If} $R0 != 0
      nsProcess::_FindProcess "AI Chat.exe"
      Pop $R0
    ${EndIf}
    ${If} $R0 != 0
      nsProcess::_FindProcess "ai-chat-frontend.exe"
      Pop $R0
    ${EndIf}
  ${LoopWhile} $R0 == 0
!macroend

; ── customInit: runs in .onInit, BEFORE the running-check ─
!macro customInit
  ${if} ${isUpdated}
    ; Auto-update: the app is already exiting on its own — let it finish
    Sleep 300
  ${endIf}

  DetailPrint `Silently closing running "${PRODUCT_NAME}"...`
  !insertmacro _KasalixSilentCloseApp

  ; Remove stale OLD-version uninstall entries so that uninstallOldVersion
  ; (called later by installSection.nsh) finds nothing and returns right away.
  DetailPrint `Skipping old version uninstall (clearing stale registry entry).`
  ; If a stale entry exists, the template retries the old uninstaller 5 times
  ; and then shows the "appCannotBeClosed" Retry/Cancel dialog - even though
  ; the app is NOT actually running. The new install simply overwrites the old
  ; files, so skipping the old uninstaller is safe and intentional.
  DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY}"
  DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY}"
  !ifdef UNINSTALL_REGISTRY_KEY_2
    DeleteRegKey HKCU "${UNINSTALL_REGISTRY_KEY_2}"
    DeleteRegKey HKLM "${UNINSTALL_REGISTRY_KEY_2}"
  !endif
  ; A failed delete (e.g. missing key on a non-elevated fallback) must not
  ; leave a stale error flag that unrelated code could trip on.
  ClearErrors
!macroend

; ── customCheckAppRunning: replaces the dialog-based check ─
; Used by installSection.nsh AND uninstaller.nsh (un.checkAppRunning).
!macro customCheckAppRunning
  ${if} ${isUpdated}
    Sleep 300
  ${endIf}

  DetailPrint `Silently closing running "${PRODUCT_NAME}"...`
  !insertmacro _KasalixSilentCloseApp
!macroend

; ── customUnInit: same protection at uninstaller startup ──
!macro customUnInit
  DetailPrint `Silently closing running "${PRODUCT_NAME}"...`
  !insertmacro _KasalixSilentCloseApp
!macroend

; ── customUnInstallCheck: don't hard-abort if the OLD uninstaller fails ──
; handleUninstallResult calls these instead of showing the
; "Failed to uninstall old application files" dialog + Quit when the old
; version (built without these hooks) cannot uninstall cleanly. The new files
; simply overwrite the old ones.
!macro customUnInstallCheck
  DetailPrint `Previous version could not be uninstalled cleanly - continuing install anyway.`
!macroend

!macro customUnInstallCheckCurrentUser
  DetailPrint `Previous (per-user) version could not be uninstalled cleanly - continuing install anyway.`
!macroend
