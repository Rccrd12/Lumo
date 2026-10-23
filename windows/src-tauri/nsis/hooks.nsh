; Hooks for the NSIS installer (Tauri's template, bundle.windows.nsis.installerHooks).
;
; ── Install ───────────────────────────────────────────────────────────────────
;
; The template remembers the install folder under Software\<publisher>\Lumo,
; and the publisher comes from the app identifier. Up to 0.4.0 that was another
; one: its key is left behind with nothing reading it, so it goes.
;
; ── Uninstall ─────────────────────────────────────────────────────────────────
;
; The inbox and the log live in %LOCALAPPDATA%\com.rccrd12.lumo, where the
; installer never recorded them, so they go here. (The rest of that folder is
; the WebView's data, which the template removes when the user asks it to
; delete the app's data.)
;
; The relay in bin\lumo-hook.exe stays. Claude Code's own settings.json is
; deliberately NOT touched here: it belongs to the user, it may contain hooks
; from other tools, and rewriting somebody's config from an uninstaller with no
; diff and no consent is exactly what the rest of this app goes out of its way
; not to do. So Lumo's hooks may outlive the app, and a missing relay would
; turn each of them into a "hook error" in Claude Code. The relay that stays
; finds no app on the other end and exits at once without printing anything.

!macro NSIS_HOOK_POSTINSTALL
  DeleteRegKey HKCU "Software\louisraille\${PRODUCTNAME}"
  DeleteRegKey /ifempty HKCU "Software\louisraille"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  RMDir /r "$LOCALAPPDATA\com.rccrd12.lumo\inbox"
  Delete "$LOCALAPPDATA\com.rccrd12.lumo\lumo.log"
!macroend
