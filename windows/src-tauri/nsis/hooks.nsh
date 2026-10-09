; Hooks for the NSIS installer (Tauri's template, bundle.windows.nsis.installerHooks).
;
; ── Uninstall ─────────────────────────────────────────────────────────────────
;
; The app stages lumo-hook.exe (and the same relay as coucou-hook.exe, its name
; up to 0.3.1, for hooks written then) into %LOCALAPPDATA%\Coucou\bin at launch, so the
; installer never recorded it and the default uninstaller leaves it behind. The
; inbox and the log live in the same place and are ours too. (These folders kept
; their old name when the app became Lumo: Claude Code's hooks point at bin\.)
;
; Claude Code's own settings.json is deliberately NOT touched here: it belongs to
; the user, it may contain hooks from other tools, and rewriting somebody's
; config from an uninstaller with no diff and no consent is exactly what the rest
; of this app goes out of its way not to do. A relay that is gone exits 0 without
; printing anything, so a leftover entry costs nothing beyond a dead path.
;
; ── Upgrading from Coucou ─────────────────────────────────────────────────────
;
; Up to 0.3.0 the app was called Coucou. Tauri's template derives from
; productName the per-user install folder (%LOCALAPPDATA%\<productName>), the
; Add/Remove Programs key (HKCU\…\Uninstall\<productName>), the key remembering
; the folder (HKCU\Software\<publisher>\<productName>), the shortcuts
; (<productName>.lnk) and the autostart value (HKCU\…\Run\<productName>). So the
; Lumo installer does not see a Coucou install and would leave it next to the
; new one: two entries in Settings → Apps, two Start menu shortcuts, two apps
; starting at login. Once Lumo is in place, these hooks retire the Coucou
; install: its program files, its Add/Remove Programs entry, its shortcuts (a
; desktop one is replaced by a Lumo one) and its autostart value (moved over to
; Lumo when it was there). Coucou's main binary is coucou.exe.
;
; ── coucou.exe → lumo.exe ────────────────────────────────────────────────────
;
; Up to 0.3.1 Lumo's own main binary was coucou.exe too (the crate's name); it
; is lumo.exe now (mainBinaryName, tauri.windows.conf.json). Installed over an
; older Lumo, the installer closes a coucou.exe still running from the install
; folder, deletes it, and points the Lumo shortcuts and autostart value that
; still started it at lumo.exe.
;
; Nothing of the user's is touched. Settings (%APPDATA%\Coucou), the relay, the
; inbox, the log and the recap (%LOCALAPPDATA%\Coucou\…), the WebView's data
; (%LOCALAPPDATA%\fr.louisraille.coucou) and the keys in Credential Manager
; (fr.louisraille.coucou) do not depend on productName. Coucou's own uninstaller
; is NOT run for that reason: its uninstall hook deletes %LOCALAPPDATA%\Coucou\bin,
; the relay Claude Code's hooks point at, and the inbox. Only the three files the
; old installer wrote are deleted, so its folder — the same one as the data —
; stays.
;
; A Coucou installed from the .msi (per machine) is uninstalled through Windows
; Installer, as Tauri's template did for a .msi of the same name before.

!define LEGACY_PRODUCTNAME "Coucou"
; The main binary of Coucou, and of Lumo up to 0.3.1.
!define LEGACY_MAINBINARYNAME "coucou"
!define LEGACY_UNINSTKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Coucou"
!define RUN_KEY "Software\Microsoft\Windows\CurrentVersion\Run"
!define STARTUP_APPROVED_KEY "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"

; The folder Coucou was installed in, or "" when there is no Coucou install.
Var LegacyDir

; Sets $LegacyDir. The installer wrote its folder to Software\<publisher>\Coucou;
; the default per-user folder stands in when only the uninstall key is left.
!macro LumoFindLegacyInstall
  StrCpy $LegacyDir ""
  ReadRegStr $R8 SHCTX "${LEGACY_UNINSTKEY}" "UninstallString"
  ReadRegStr $R9 SHCTX "Software\${MANUFACTURER}\${LEGACY_PRODUCTNAME}" ""
  ${If} $R9 != ""
    StrCpy $LegacyDir $R9
  ${ElseIf} $R8 != ""
    StrCpy $LegacyDir "$LOCALAPPDATA\${LEGACY_PRODUCTNAME}"
  ${EndIf}
!macroend

; A Coucou still running from its folder holds its files and, sharing Lumo's
; single-instance identifier, would keep a freshly installed Lumo from
; starting: it is closed first, exactly as the template then closes a running
; Lumo (same macro, same messages; its labels are numbered by line, so the two
; checks in this section cannot clash).
!macro NSIS_HOOK_PREINSTALL
  !insertmacro LumoFindLegacyInstall
  ${If} $LegacyDir != ""
  ${AndIf} $LegacyDir != $INSTDIR
  ${AndIf} ${FileExists} "$LegacyDir\${LEGACY_MAINBINARYNAME}.exe"
    !insertmacro CheckIfAppIsRunning "$LegacyDir\${LEGACY_MAINBINARYNAME}.exe" "${LEGACY_PRODUCTNAME}"
  ${EndIf}
  ; An older Lumo, still running as coucou.exe from this folder.
  ${If} ${FileExists} "$INSTDIR\${LEGACY_MAINBINARYNAME}.exe"
    !insertmacro CheckIfAppIsRunning "$INSTDIR\${LEGACY_MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro LumoFindLegacyInstall
  ${If} $LegacyDir != ""
    DetailPrint "Removing the previous install (${LEGACY_PRODUCTNAME}) from $LegacyDir"

    ; Its autostart value, when it starts that install's coucou.exe, moves over
    ; to Lumo (the app writes it again at launch, the way the autostart plugin
    ; does: the exe's path and a space).
    ReadRegStr $R7 HKCU "${RUN_KEY}" "${LEGACY_PRODUCTNAME}"
    ${If} $R7 != ""
      ${StrCase} $R7 $R7 "L"
      ${StrCase} $R6 "$LegacyDir\${LEGACY_MAINBINARYNAME}.exe" "L"
      ${StrLoc} $R5 $R7 $R6 ">"
      ${If} $R5 != ""
        DeleteRegValue HKCU "${RUN_KEY}" "${LEGACY_PRODUCTNAME}"
        DeleteRegValue HKCU "${STARTUP_APPROVED_KEY}" "${LEGACY_PRODUCTNAME}"
        WriteRegStr HKCU "${RUN_KEY}" "${PRODUCTNAME}" "$INSTDIR\${MAINBINARYNAME}.exe "
      ${EndIf}
    ${EndIf}

    ; Its shortcuts, only when they start that install's coucou.exe.
    !insertmacro IsShortcutTarget "$SMPROGRAMS\${LEGACY_PRODUCTNAME}.lnk" "$LegacyDir\${LEGACY_MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$SMPROGRAMS\${LEGACY_PRODUCTNAME}.lnk"
      Delete "$SMPROGRAMS\${LEGACY_PRODUCTNAME}.lnk"
    ${EndIf}
    !insertmacro IsShortcutTarget "$DESKTOP\${LEGACY_PRODUCTNAME}.lnk" "$LegacyDir\${LEGACY_MAINBINARYNAME}.exe"
    Pop $0
    ${If} $0 = 1
      !insertmacro UnpinShortcut "$DESKTOP\${LEGACY_PRODUCTNAME}.lnk"
      Delete "$DESKTOP\${LEGACY_PRODUCTNAME}.lnk"
      ; There was one on the desktop: there still is, for Lumo.
      ${IfNot} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
        CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
        !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
      ${EndIf}
    ${EndIf}

    ; Its program files, unless Lumo was just installed over them. The folder
    ; itself goes only if nothing else is in it (the data usually is).
    ${If} $LegacyDir != $INSTDIR
      Delete "$LegacyDir\${LEGACY_MAINBINARYNAME}.exe"
      Delete "$LegacyDir\coucou-hook.exe"
      Delete "$LegacyDir\uninstall.exe"
      RMDir "$LegacyDir"
    ${EndIf}

    ; Its Add/Remove Programs entry and the key that remembered its folder.
    DeleteRegKey SHCTX "${LEGACY_UNINSTKEY}"
    DeleteRegKey SHCTX "Software\${MANUFACTURER}\${LEGACY_PRODUCTNAME}"
  ${EndIf}

  ; The relay an older Lumo bundled under its old name: lumo-hook.exe now.
  ; (The copy in %LOCALAPPDATA%\Coucou\bin, which hooks run, is the app's.)
  Delete "$INSTDIR\coucou-hook.exe"

  ; An older Lumo's coucou.exe in this folder: gone, and what started it
  ; starts lumo.exe now.
  ${If} ${FileExists} "$INSTDIR\${LEGACY_MAINBINARYNAME}.exe"
    DetailPrint "Removing ${LEGACY_MAINBINARYNAME}.exe, now ${MAINBINARYNAME}.exe"
    Delete "$INSTDIR\${LEGACY_MAINBINARYNAME}.exe"
  ${EndIf}
  ReadRegStr $R7 HKCU "${RUN_KEY}" "${PRODUCTNAME}"
  ${If} $R7 != ""
    ${StrCase} $R7 $R7 "L"
    ${StrCase} $R6 "$INSTDIR\${LEGACY_MAINBINARYNAME}.exe" "L"
    ${StrLoc} $R5 $R7 $R6 ">"
    ${If} $R5 != ""
      WriteRegStr HKCU "${RUN_KEY}" "${PRODUCTNAME}" "$INSTDIR\${MAINBINARYNAME}.exe "
    ${EndIf}
  ${EndIf}
  !insertmacro IsShortcutTarget "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${LEGACY_MAINBINARYNAME}.exe"
  Pop $0
  ${If} $0 = 1
    Delete "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  ${EndIf}
  !insertmacro IsShortcutTarget "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${LEGACY_MAINBINARYNAME}.exe"
  Pop $0
  ${If} $0 = 1
    Delete "$DESKTOP\${PRODUCTNAME}.lnk"
    CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
    !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
  ${EndIf}

  ; A Coucou .msi: Windows Installer's own uninstall, as the template runs for
  ; a .msi of the current name (the user confirms it).
  StrCpy $R4 0
  ${Do}
    EnumRegKey $R3 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall" $R4
    ${If} $R3 == ""
      ${Break}
    ${EndIf}
    IntOp $R4 $R4 + 1
    ReadRegStr $R7 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R3" "DisplayName"
    ReadRegStr $R6 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R3" "Publisher"
    ${If} "$R7$R6" == "${LEGACY_PRODUCTNAME}${MANUFACTURER}"
      ReadRegStr $R7 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\$R3" "UninstallString"
      ${StrCase} $R6 $R7 "L"
      ${StrLoc} $R5 $R6 "msiexec" ">"
      ${If} $R5 == 0
        DetailPrint "Removing the previous install (${LEGACY_PRODUCTNAME}, Windows Installer)"
        ExecWait '$R7' $R5
        ${Break}
      ${EndIf}
    ${EndIf}
  ${Loop}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  RMDir /r "$LOCALAPPDATA\Coucou\bin"
  RMDir /r "$LOCALAPPDATA\Coucou\inbox"
  Delete "$LOCALAPPDATA\Coucou\coucou.log"
!macroend
