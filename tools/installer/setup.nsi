Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

Name "RIME Model Predict ${PRODUCT_VERSION}"
OutFile "${OUTPUT}"
; Capture the initiating user's locations BEFORE requesting admin elevation.
; The elevated copy refuses credentials for a different account.
RequestExecutionLevel user
SetCompressor zlib
ShowInstDetails show
ShowUninstDetails show
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Var UserProfile
Var Roaming
Var RimeUser
Var Parent
Var Cache
Var Journal
Var BootRoot
Var Initiator
Var Params

!macro ReadUserContext
  ReadEnvStr $UserProfile "USERPROFILE"
  StrCpy $Roaming $APPDATA
  SetRegView 32
  ReadRegStr $RimeUser HKCU "Software\Rime\Weasel" "RimeUserDir"
  ${If} $RimeUser == ""
    StrCpy $RimeUser "$Roaming\Rime"
  ${EndIf}
  ReadRegStr $Parent HKLM "Software\Rime\Weasel" "InstallDir"
  ${If} $Parent == ""
    StrCpy $Parent "$PROGRAMFILES64\Rime"
  ${EndIf}
!macroend

Function .onInit
!ifdef CANDIDATE
  MessageBox MB_ICONSTOP "Engineering candidate only: the pinned published fork release is missing. Installation is disabled."
  Abort
!endif
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "This package requires Windows x64."
    Abort
  ${EndIf}
  ${GetParameters} $Params
  System::Call 'shell32::IsUserAnAdmin() i.r0'
  ${If} $0 == 0
    !insertmacro ReadUserContext
    UserInfo::GetName
    Pop $Initiator
    ExecShell "runas" "$EXEPATH" '/ELEVATED /PROFILE="$UserProfile" /ROAMING="$Roaming" /RIMEUSER="$RimeUser" /PARENT="$Parent" /INITIATOR="$Initiator"'
    Quit
  ${EndIf}
  ${GetOptions} $Params "/ELEVATED" $0
  ${IfNot} ${Errors}
    ${GetOptions} $Params "/PROFILE=" $UserProfile
    ${GetOptions} $Params "/ROAMING=" $Roaming
    ${GetOptions} $Params "/RIMEUSER=" $RimeUser
    ${GetOptions} $Params "/PARENT=" $Parent
    ${GetOptions} $Params "/INITIATOR=" $Initiator
    UserInfo::GetName
    Pop $0
    ${If} $0 != $Initiator
      MessageBox MB_ICONSTOP "Use the same Windows account for administrator elevation."
      Abort
    ${EndIf}
  ${Else}
    !insertmacro ReadUserContext
  ${EndIf}
  SetShellVarContext all
  StrCpy $BootRoot "$APPDATA\RimePredictInstaller"
  StrCpy $Cache "$BootRoot\cache\${PRODUCT_VERSION}"
  StrCpy $Journal "$BootRoot\journal"
  SetRegView 32
FunctionEnd

Section "Install"
  ; Bootstrap metadata/cache only; every product mutation is an S8 InstallOp.
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "cache-guard.ps1"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -File "$PLUGINSDIR\cache-guard.ps1" -Root "$BootRoot"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    Abort "Refusing unsafe installer cache."
  ${EndIf}
  System::Call 'kernel32::GetFileAttributesW(w "$BootRoot") i.r0'
  IntOp $1 $0 & 0x400
  ${If} $0 != -1
  ${AndIf} $1 != 0
    Abort "Refusing linked installer cache."
  ${EndIf}
  CreateDirectory "$BootRoot"
  ExecWait '"$SYSDIR\icacls.exe" "$BootRoot" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F' $0
  ${If} $0 != 0
    Abort "Cannot protect installer cache."
  ${EndIf}
  SetOutPath "$Cache"
  File /r "${STAGE}\*.*"
  WriteUninstaller "$BootRoot\uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\RimePredict" "DisplayName" "RIME Model Predict"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\RimePredict" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\RimePredict" "UninstallString" '$\"$BootRoot\uninstall.exe$\"'
  WriteRegStr HKLM "Software\RimePredictInstaller" "Cache" "$Cache"
  WriteRegStr HKLM "Software\RimePredictInstaller" "Profile" "$UserProfile"
  WriteRegStr HKLM "Software\RimePredictInstaller" "Roaming" "$Roaming"
  WriteRegStr HKLM "Software\RimePredictInstaller" "RimeUser" "$RimeUser"
  WriteRegStr HKLM "Software\RimePredictInstaller" "Parent" "$Parent"
  ExecWait '"$Cache\installer-host.exe" install --bundle "$Cache\bundle" --program-files "$PROGRAMFILES64" --install-parent "$Parent" --user-profile "$UserProfile" --app-data "$Roaming" --rime-user-directory "$RimeUser" --journal "$Journal" --version "${PRODUCT_VERSION}"' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Installation stopped. The failed operation and retry record are in the installation journal. Exit Weasel and editors, then rerun this installer."
    SetErrorLevel 1
    Abort
  ${EndIf}
  MessageBox MB_ICONINFORMATION "Installation finished. Read predict\activate.md for manual filter activation and predict\restore.md for restoration. Existing custom files were preserved. Start WeaselServer.exe after installation."
SectionEnd

Function un.onInit
  System::Call 'shell32::IsUserAnAdmin() i.r0'
  ${If} $0 == 0
    ExecShell "runas" "$EXEPATH" ""
    Quit
  ${EndIf}
  SetShellVarContext all
  StrCpy $BootRoot "$APPDATA\RimePredictInstaller"
  StrCpy $Journal "$BootRoot\journal"
  SetRegView 32
  ReadRegStr $Cache HKLM "Software\RimePredictInstaller" "Cache"
  ReadRegStr $UserProfile HKLM "Software\RimePredictInstaller" "Profile"
  ReadRegStr $Roaming HKLM "Software\RimePredictInstaller" "Roaming"
  ReadRegStr $RimeUser HKLM "Software\RimePredictInstaller" "RimeUser"
  ReadRegStr $Parent HKLM "Software\RimePredictInstaller" "Parent"
  StrCpy $0 "$BootRoot\cache\${PRODUCT_VERSION}"
  ${If} $Cache != $0
    Abort "Installer cache registry value does not match this uninstaller."
  ${EndIf}
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "cache-guard.ps1"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -File "$PLUGINSDIR\cache-guard.ps1" -Root "$BootRoot"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    Abort "Refusing unsafe uninstaller cache."
  ${EndIf}
FunctionEnd

Section "Uninstall"
  ExecWait '"$Cache\installer-host.exe" uninstall --bundle "$Cache\bundle" --program-files "$PROGRAMFILES64" --install-parent "$Parent" --user-profile "$UserProfile" --app-data "$Roaming" --rime-user-directory "$RimeUser" --journal "$Journal" --version "${PRODUCT_VERSION}"' $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Uninstall stopped. Keep the cache and journal; exit the reported process and retry."
    SetErrorLevel 1
    Abort
  ${EndIf}
  MessageBox MB_ICONINFORMATION "Reinstall official Weasel 0.17.4 from github.com/rime/weasel/releases/tag/0.17.4. Manually remove the filter entry you added. Settings, RIME data and shared models were preserved."
  ; These are fixed installer-owned bootstrap locations, never product/user data.
  !include "${CLEANUP}"
  RMDir "$BootRoot\cache"
  Delete "$BootRoot\uninstall.exe"
  DeleteRegKey HKLM "Software\RimePredictInstaller"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\RimePredict"
SectionEnd
