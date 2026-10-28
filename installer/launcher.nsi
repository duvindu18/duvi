; Veil.exe - tiny launcher that starts the app with the bundled Python.
; Built by installer/build_installer.py:
;   makensis -DOUTFILE=<Veil.exe> -DICON=<veil.ico> -DVERSION=1.0.0 installer/launcher.nsi
Unicode True
ManifestDPIAware true
!include "FileFunc.nsh"

!ifndef VERSION
  !define VERSION "1.0.0"
!endif

Name "Veil"
OutFile "${OUTFILE}"
Icon "${ICON}"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
SetCompressor /SOLID lzma

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Veil"
VIAddVersionKey "FileDescription" "Veil - face anonymization"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "See NOTICE.txt"

Section
  ${GetParameters} $0
  IfFileExists "$EXEDIR\python\pythonw.exe" +3
    MessageBox MB_ICONSTOP "Veil's Python runtime is missing.$\r$\nRun VeilSetup.exe again to repair the installation."
    Quit
  SetOutPath "$EXEDIR\app"
  ; -E / -s isolate the private runtime from any system Python settings.
  Exec '"$EXEDIR\python\pythonw.exe" -E -s "$EXEDIR\app\main.py" $0'
SectionEnd
