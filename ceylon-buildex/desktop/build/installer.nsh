; Extra installer steps (included by electron-builder's NSIS script).

; A back end left running by a crash would lock its files: stop it before files are replaced or removed.
!macro stopServer
  nsExec::Exec '"$SYSDIR\taskkill.exe" /F /T /IM CeylonBuildexServer.exe'
  Pop $0
!macroend

!macro customInit
  !insertmacro stopServer
!macroend

!macro customUnInit
  !insertmacro stopServer
!macroend

; Uninstall: the documents, the dataset and the settings live in %LOCALAPPDATA%\CeylonBuildex and are kept for a reinstall,
; unless the person asks to remove them. Never asked during an update or a silent uninstall.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    IfSilent keep_data
    SetShellVarContext current
    IfFileExists "$LOCALAPPDATA\CeylonBuildex\*.*" 0 keep_data
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete the downloaded documents, the dataset and your settings?$\r$\n$\r$\n($LOCALAPPDATA\CeylonBuildex)" IDNO keep_data
    RMDir /r "$LOCALAPPDATA\CeylonBuildex"
    keep_data:
  ${endIf}
!macroend
