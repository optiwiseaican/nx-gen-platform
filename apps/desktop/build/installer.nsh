; NxGen Windows installer additions (electron-builder NSIS include).
; One NxGen folder per computer for the built-in database and data: C:\ProgramData\NxGen.
; Every Windows user of the lab PC runs NxGen against it, so the Users group may modify it.
; Uninstalling NxGen keeps it: it holds the regulated records.
!macro customInstall
  SetShellVarContext all
  CreateDirectory "$APPDATA\NxGen"
  nsExec::ExecToLog 'icacls "$APPDATA\NxGen" /grant *S-1-5-32-545:(OI)(CI)M'
!macroend
