; NxGen Windows installer additions (electron-builder NSIS include).
;
; 1. One NxGen folder per computer for the built-in database and data: C:\ProgramData\NxGen.
;    Every Windows user of the lab PC runs NxGen against it, so the Users group may modify it.
;    Uninstalling NxGen keeps it: it holds the regulated records.
; 2. An "Activation key" page: the key AICAN supplied is saved to C:\ProgramData\NxGen\activation-key.txt;
;    at its first start NxGen activates with it through the AICAN License Portal and then deletes the file.
;    Left empty, the key is entered on NxGen's activation screen instead.

!ifndef BUILD_UNINSTALLER
  !include nsDialogs.nsh
  !include LogicLib.nsh

  Var NxKeyField
  Var NxActivationKey

  ; electron-builder includes this file before MUI2, and inserts this macro among the pages (after MUI2):
  ; the page functions are defined here so MUI_HEADER_TEXT exists when they compile.
  !macro customPageAfterChangeDir
    Page custom NxKeyPageCreate NxKeyPageLeave

    Function NxKeyPageCreate
      !insertmacro MUI_HEADER_TEXT "Activation key" "Enter the NxGen activation key you received from AICAN."
      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}
      ${NSD_CreateLabel} 0 0 100% 40u "NxGen activates this computer with the key the first time it starts (an internet connection is needed once). Without internet, NxGen offers activation with a license file instead. You can also leave this empty and enter the key in NxGen."
      Pop $0
      ${NSD_CreateLabel} 0 48u 100% 10u "Activation key (NXG-XXXX-XXXX-XXXX):"
      Pop $0
      ${NSD_CreateText} 0 60u 100% 14u "$NxActivationKey"
      Pop $NxKeyField
      nsDialogs::Show
    FunctionEnd

    Function NxKeyPageLeave
      ${NSD_GetText} $NxKeyField $NxActivationKey
      ${If} $NxActivationKey != ""
        StrCpy $0 $NxActivationKey 3
        StrLen $1 $NxActivationKey
        ${If} $0 != "NXG"
        ${OrIf} $1 < 15
          MessageBox MB_ICONEXCLAMATION|MB_OK "The activation key starts with NXG, for example NXG-7K3M-QW9P-X2TA. Check the key, or leave the field empty to enter it later in NxGen."
          Abort
        ${EndIf}
      ${EndIf}
    FunctionEnd
  !macroend
!endif

!macro customInstall
  SetShellVarContext all
  CreateDirectory "$APPDATA\NxGen"
  nsExec::ExecToLog 'icacls "$APPDATA\NxGen" /grant *S-1-5-32-545:(OI)(CI)M'
  ${If} $NxActivationKey != ""
    FileOpen $0 "$APPDATA\NxGen\activation-key.txt" w
    FileWrite $0 "$NxActivationKey"
    FileClose $0
  ${EndIf}
!macroend
