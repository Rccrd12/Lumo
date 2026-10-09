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
; The app stages lumo-hook.exe into %LOCALAPPDATA%\com.rccrd12.lumo\bin at
; launch, so the installer never recorded it and the default uninstaller leaves
; it behind. The inbox and the log live in the same place and are ours too.
; (The rest of that folder is the WebView's data, which the template removes
; when the user asks it to delete the app's data.)
;
; Claude Code's own settings.json is deliberately NOT touched here: it belongs to
; the user, it may contain hooks from other tools, and rewriting somebody's
; config from an uninstaller with no diff and no consent is exactly what the rest
; of this app goes out of its way not to do. A relay that is gone exits 0 without
; printing anything, so a leftover entry costs nothing beyond a dead path.

!macro NSIS_HOOK_POSTINSTALL
  DeleteRegKey HKCU "Software\louisraille\${PRODUCTNAME}"
  DeleteRegKey /ifempty HKCU "Software\louisraille"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  RMDir /r "$LOCALAPPDATA\com.rccrd12.lumo\bin"
  RMDir /r "$LOCALAPPDATA\com.rccrd12.lumo\inbox"
  Delete "$LOCALAPPDATA\com.rccrd12.lumo\lumo.log"
!macroend
