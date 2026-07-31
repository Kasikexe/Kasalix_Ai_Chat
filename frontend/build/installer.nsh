; ============================================================================
; Custom installer behavior for "Kasalix AI Chat" (Windows Client)
;
; electron-builder's default NSIS template checks whether the app is already
; running and shows a dialog ("Kasalix AI Chat is running. Click OK to close
; it..."). With oneClick + allowElevation, that dialog can end up hidden
; behind the UAC elevation prompt, which makes the installer look permanently
; stuck on "app is running".
;
; This file overrides the `customCheckAppRunning` hook (supported by the
; electron-builder NSIS template) to silently force-close the app instead,
; so the installer never waits on a hidden dialog. Also fixes the same
; freeze in the uninstaller, which uses the same check.
; ============================================================================

!macro customCheckAppRunning
  ; During auto-update (--updated), the app is already exiting on its own —
  ; give it a short grace period to close cleanly before force-killing.
  ${if} ${isUpdated}
    Sleep 300
  ${endIf}

  DetailPrint `Silently closing running "${PRODUCT_NAME}"...`
  ; Force-close every instance of the app so the installer can replace files.
  nsExec::Exec `taskkill /f /im "${APP_EXECUTABLE_FILENAME}"`
  Pop $R0
  ; Give the OS a moment to release file locks before overwriting.
  Sleep 500
!macroend
