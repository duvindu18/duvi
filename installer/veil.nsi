; ---------------------------------------------------------------------------
; Veil - Windows installer (NSIS 3.x, Modern UI 2)
;
; Built by installer/build_installer.py, which stages the payload and calls:
;   makensis -DSTAGE=<stage dir> -DVERSION=1.0.0 -DOUTFILE=<exe> installer/veil.nsi
;
; One self-contained VeilSetup.exe carrying a private Python 3.11, the app and
; an offline wheelhouse. The "Choose Components" page is the installation menu:
; pick the inference runtime for your hardware, optional TensorRT, the face
; models and shortcuts. Large NVIDIA / model downloads happen during install.
;
; Silent install:  VeilSetup.exe /S [/ACCEL=cuda|tensorrt|directml|openvino|cpu] [/D=C:\Path]
; ---------------------------------------------------------------------------
Unicode True
ManifestDPIAware true

!ifndef VERSION
  !define VERSION "1.0.0"
!endif
!ifndef STAGE
  !error "Define STAGE (the staged payload directory) - use installer/build_installer.py"
!endif
!ifndef OUTFILE
  !define OUTFILE "VeilSetup-${VERSION}.exe"
!endif

!define APPNAME "Veil"
!define REGKEY "Software\Veil"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Veil"

Name "${APPNAME}"
OutFile "${OUTFILE}"
InstallDir "$PROGRAMFILES64\Veil"
InstallDirRegKey HKLM "${REGKEY}" "InstallDir"
RequestExecutionLevel admin
SetCompressor /SOLID lzma
SetCompressorDictSize 64
BrandingText "Veil ${VERSION} - face anonymization"
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Veil"
VIAddVersionKey "FileDescription" "Veil Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "See NOTICE.txt"

!include "MUI2.nsh"
!include "Sections.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "FileFunc.nsh"
!include "WinVer.nsh"
!include "StrFunc.nsh"
${StrStr}

Var RadioSel
Var GpuName

; ---- look & feel (ember theme bitmaps rendered by the build script) --------
!define MUI_ICON "${STAGE}/veil.ico"
!define MUI_UNICON "${STAGE}/veil.ico"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_RIGHT
!define MUI_HEADERIMAGE_BITMAP "${STAGE}/header.bmp"
!define MUI_HEADERIMAGE_UNBITMAP "${STAGE}/header.bmp"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${STAGE}/wizard.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${STAGE}/wizard.bmp"
!define MUI_ABORTWARNING
!define MUI_COMPONENTSPAGE_SMALLDESC

; ---- pages ------------------------------------------------------------------
!define MUI_WELCOMEPAGE_TITLE "Welcome to Veil ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "Veil detects, tracks and recognises faces in webcams, RTSP streams and video files and anonymizes them in real time.$\r$\n$\r$\nThis setup installs everything Veil needs - a private Python runtime, the application and the components you choose for your hardware. No separate Python, CUDA Toolkit or compiler is required.$\r$\n$\r$\nAn internet connection is needed for the GPU runtimes and face models you select.$\r$\n$\r$\nClick Next to continue."
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${STAGE}/NOTICE.txt"
!define MUI_COMPONENTSPAGE_TEXT_TOP "Detected graphics: $GpuName$\r$\nThe recommended setup type is pre-selected. Choose exactly one inference runtime."
!define MUI_COMPONENTSPAGE_TEXT_COMPLIST "Or select the components to install:"
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_TITLE "Veil is ready"
!define MUI_FINISHPAGE_TEXT "Veil has been installed.$\r$\n$\r$\nAdd photos of people to recognise on the Identities page. They are stored in Documents\Veil\Faces.$\r$\n$\r$\nTo add or change components later, run this setup again."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Launch Veil now"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchUnelevated
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\install.log"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Show the installation log"
!define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; ---- setup types (the drop-down at the top of the components page) ----------
InstType "NVIDIA GPU - CUDA (recommended for GeForce / RTX)"   ; 1
InstType "NVIDIA GPU - CUDA + TensorRT (fastest, larger)"      ; 2
InstType "AMD / Intel / other GPU - DirectML"                  ; 3
InstType "Intel CPU / iGPU / NPU - OpenVINO"                   ; 4
InstType "CPU only - works offline"                            ; 5

; =============================================================================
Section "!Veil application (required)" SecCore
  SectionIn RO
  SetOutPath "$INSTDIR"
  ; Remove stale code from a previous version; installed packages are kept and
  ; reconciled by provision.py.
  RMDir /r "$INSTDIR\app\app"
  File /r "${STAGE}/payload/*.*"
  FileOpen $0 "$INSTDIR\app\installed.flag" w
  FileWrite $0 "${VERSION}"
  FileClose $0

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "${REGKEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "${REGKEY}" "Version" "${VERSION}"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "Veil ${VERSION}"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "Veil"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\veil.ico"
  WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKLM "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1
SectionEnd

SectionGroup /e "Inference runtime (choose one)" SecGrpRuntime
  Section "NVIDIA CUDA 12 + cuDNN 9 (download ~1.3 GB)" SecCuda
    SectionIn 1 2
  SectionEnd
  Section /o "DirectML - AMD, Intel, NVIDIA (DirectX 12)" SecDml
    SectionIn 3
  SectionEnd
  Section /o "Intel OpenVINO (download ~70 MB)" SecOv
    SectionIn 4
  SectionEnd
  Section /o "CPU only (included, offline)" SecCpu
    SectionIn 5
  SectionEnd
SectionGroupEnd

Section /o "NVIDIA TensorRT 10 (download ~1 GB, needs CUDA)" SecTrt
  SectionIn 2
SectionEnd

SectionGroup /e "Face models" SecGrpModels
  Section "InsightFace buffalo_l - most accurate (download 280 MB)" SecBufL
    SectionIn 1 2 3 4 5
  SectionEnd
  Section /o "InsightFace buffalo_s - fastest (download 120 MB)" SecBufS
    SectionIn 4 5
  SectionEnd
  Section "OpenCV YuNet + SFace - lightweight fallback (download 40 MB)" SecYunet
    SectionIn 1 2 3 4 5
  SectionEnd
SectionGroupEnd

Section "Phone & Blackmagic Camera receiver (MediaMTX)" SecPhone
  SectionIn 1 2 3 4 5
  SetOutPath "$INSTDIR\runtimes\mediamtx"
  File /r "${STAGE}/mediamtx/*.*"
SectionEnd

Section "Microsoft Visual C++ Runtime (installed if missing)" SecVc
  SectionIn 1 2 3 4 5
SectionEnd

Section "Start menu shortcuts" SecStart
  SectionIn 1 2 3 4 5
  SetShellVarContext all
  CreateDirectory "$SMPROGRAMS\Veil"
  CreateShortCut "$SMPROGRAMS\Veil\Veil.lnk" "$INSTDIR\Veil.exe" "" "$INSTDIR\veil.ico" 0
  CreateShortCut "$SMPROGRAMS\Veil\Uninstall Veil.lnk" "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Desktop shortcut" SecDesk
  SectionIn 1 2 3 4 5
  SetShellVarContext all
  CreateShortCut "$DESKTOP\Veil.lnk" "$INSTDIR\Veil.exe" "" "$INSTDIR\veil.ico" 0
SectionEnd

Section /o "Add 'veil' command-line tool to PATH" SecPath
SectionEnd

; Hidden, always last: install the selected components with the bundled Python.
Section "-Provision" SecProvision
  StrCpy $0 "cpu"
  ${If} ${SectionIsSelected} ${SecCuda}
    StrCpy $0 "cuda"
  ${ElseIf} ${SectionIsSelected} ${SecDml}
    StrCpy $0 "directml"
  ${ElseIf} ${SectionIsSelected} ${SecOv}
    StrCpy $0 "openvino"
  ${EndIf}

  StrCpy $1 ""
  ${If} ${SectionIsSelected} ${SecTrt}
    StrCpy $1 "$1 --tensorrt"
  ${EndIf}
  ${If} ${SectionIsSelected} ${SecVc}
    StrCpy $1 "$1 --vcredist"
  ${EndIf}
  ${If} ${SectionIsSelected} ${SecPath}
    StrCpy $1 "$1 --add-path"
  ${EndIf}
  ${If} ${SectionIsSelected} ${SecPhone}
    StrCpy $1 "$1 --firewall"
  ${EndIf}

  StrCpy $2 ""
  ${If} ${SectionIsSelected} ${SecBufL}
    StrCpy $2 "$2buffalo_l,"
  ${EndIf}
  ${If} ${SectionIsSelected} ${SecBufS}
    StrCpy $2 "$2buffalo_s,"
  ${EndIf}
  ${If} ${SectionIsSelected} ${SecYunet}
    StrCpy $2 "$2yunet,"
  ${EndIf}

  DetailPrint "Installing components ($0). Downloads can take several minutes..."
  SetDetailsPrint listonly
  nsExec::ExecToLog '"$INSTDIR\python\python.exe" -E -s -u "$INSTDIR\provision.py" --accel $0 $1 --models "$2"'
  Pop $3
  SetDetailsPrint both

  ${GetSize} "$INSTDIR" "/S=0K" $4 $5 $6
  WriteRegDWORD HKLM "${UNINST_KEY}" "EstimatedSize" $4

  ${If} $3 == "1"
    MessageBox MB_ICONSTOP|MB_OK "Veil's packages could not be installed.$\r$\n$\r$\nSee $INSTDIR\install.log for details, then run this setup again." /SD IDOK
    SetErrorLevel 1
  ${ElseIf} $3 == "2"
    MessageBox MB_ICONEXCLAMATION|MB_OK "Veil was installed, but some optional components need attention (see the list above or install.log).$\r$\n$\r$\nVeil automatically falls back to the next best runtime, so it is ready to use." /SD IDOK
  ${ElseIf} $3 != "0"
    MessageBox MB_ICONSTOP|MB_OK "Component setup did not run (code $3). See $INSTDIR\install.log." /SD IDOK
    SetErrorLevel 1
  ${EndIf}
SectionEnd

; ---- component descriptions -------------------------------------------------
!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecCore} "Veil, a private Python 3.11 runtime, Qt, OpenCV and NumPy. Installed offline."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecGrpRuntime} "The engine that runs the face models. Pick the one matching your graphics hardware."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecCuda} "Best for NVIDIA GeForce/RTX/Quadro. Downloads ONNX Runtime GPU with the CUDA 12 and cuDNN 9 libraries - no CUDA Toolkit needed, only an NVIDIA driver 551.61 or newer."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDml} "GPU acceleration on any DirectX 12 graphics card (AMD Radeon, Intel Arc/Iris/UHD, NVIDIA). Included in this setup."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecOv} "Optimised for Intel CPUs, integrated graphics and NPUs."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecCpu} "Runs everywhere, no download. Slower: use the buffalo_s or YuNet models."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecTrt} "NVIDIA TensorRT 10.2 roughly doubles CUDA throughput. The first start builds an optimised engine (1-3 minutes)."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecGrpModels} "Face detection and recognition models. Missing models are downloaded automatically on first use."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecBufL} "SCRFD-10G detector + ArcFace R50 recogniser. Highest accuracy (default)."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecBufS} "SCRFD-500M detector + ArcFace MobileFaceNet. Several times faster, for CPUs."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecYunet} "OpenCV YuNet + SFace. Tiny models used as an automatic fallback."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecPhone} "Receive live video from Blackmagic Camera (or any RTMP/SRT app) on a phone over Wi-Fi and anonymize it in real time. Bundled, no download. Adds a firewall rule for private networks only."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecVc} "Microsoft Visual C++ 2015-2022 x64 runtime required by ONNX Runtime and OpenCV."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecStart} "Veil entries in the Start menu."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesk} "A Veil icon on the desktop."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecPath} "Lets you run 'veil --headless -i in.mp4 -o out.mp4' from any terminal."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; =============================================================================
Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Veil requires 64-bit Windows 10 or Windows 11." /SD IDOK
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_ICONSTOP "Veil requires Windows 10 or Windows 11." /SD IDOK
    Abort
  ${EndIf}
  SetRegView 64

  ; Detect the graphics adapters to pre-select the best setup type.
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "(Get-CimInstance Win32_VideoController | ForEach-Object { $$_.Name }) -join $\', $\'"'
  Pop $0
  Pop $GpuName
  ${If} $0 != "0"
  ${OrIf} $GpuName == ""
    StrCpy $GpuName "unknown"
  ${EndIf}
  ; Strip the trailing line break PowerShell appends.
  StrCpy $1 $GpuName 2 -2
  ${If} $1 == "$\r$\n"
    StrCpy $GpuName $GpuName -2
  ${EndIf}

  StrCpy $R1 "cpu"
  ${StrStr} $1 $GpuName "NVIDIA"
  ${StrStr} $2 $GpuName "AMD"
  ${StrStr} $3 $GpuName "Radeon"
  ${StrStr} $4 $GpuName "Intel"
  ${If} $1 != ""
    StrCpy $R1 "cuda"
  ${ElseIf} $2 != ""
  ${OrIf} $3 != ""
  ${OrIf} $4 != ""
    StrCpy $R1 "directml"
  ${EndIf}

  ; Command-line override for unattended installs: /ACCEL=...
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/ACCEL=" $R2
  ${IfNot} ${Errors}
    StrCpy $R1 $R2
  ${EndIf}

  ${If} $R1 == "cuda"
    SetCurInstType 0
    StrCpy $RadioSel ${SecCuda}
  ${ElseIf} $R1 == "tensorrt"
    SetCurInstType 1
    StrCpy $RadioSel ${SecCuda}
  ${ElseIf} $R1 == "directml"
    SetCurInstType 2
    StrCpy $RadioSel ${SecDml}
  ${ElseIf} $R1 == "openvino"
    SetCurInstType 3
    StrCpy $RadioSel ${SecOv}
  ${Else}
    SetCurInstType 4
    StrCpy $RadioSel ${SecCpu}
  ${EndIf}
FunctionEnd

Function .onSelChange
  ; Exactly one inference runtime may be selected.
  !insertmacro StartRadioButtons $RadioSel
    !insertmacro RadioButton ${SecCuda}
    !insertmacro RadioButton ${SecDml}
    !insertmacro RadioButton ${SecOv}
    !insertmacro RadioButton ${SecCpu}
  !insertmacro EndRadioButtons
  ; TensorRT builds on CUDA.
  ${If} ${SectionIsSelected} ${SecTrt}
    !insertmacro SelectSection ${SecCuda}
    !insertmacro UnselectSection ${SecDml}
    !insertmacro UnselectSection ${SecOv}
    !insertmacro UnselectSection ${SecCpu}
    StrCpy $RadioSel ${SecCuda}
  ${EndIf}
FunctionEnd

Function LaunchUnelevated
  ; Start through Explorer so Veil runs as the normal (non-admin) user.
  Exec '"$WINDIR\explorer.exe" "$INSTDIR\Veil.exe"'
FunctionEnd

; =============================================================================
Section "Uninstall"
  SetRegView 64
  IfFileExists "$INSTDIR\python\python.exe" 0 +2
    nsExec::ExecToLog '"$INSTDIR\python\python.exe" -E -s "$INSTDIR\provision.py" --remove-path --remove-firewall --keep-wheels'

  SetShellVarContext all
  Delete "$SMPROGRAMS\Veil\Veil.lnk"
  Delete "$SMPROGRAMS\Veil\Uninstall Veil.lnk"
  RMDir "$SMPROGRAMS\Veil"
  Delete "$DESKTOP\Veil.lnk"

  ; Only remove what setup created - never a blanket RMDir /r "$INSTDIR".
  RMDir /r "$INSTDIR\python"
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\runtimes"
  RMDir /r "$INSTDIR\wheels"
  RMDir /r "$INSTDIR\requirements"
  Delete "$INSTDIR\provision.py"
  Delete "$INSTDIR\Veil.exe"
  Delete "$INSTDIR\veil.cmd"
  Delete "$INSTDIR\veil.ico"
  Delete "$INSTDIR\NOTICE.txt"
  Delete "$INSTDIR\install.log"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKLM "${UNINST_KEY}"
  DeleteRegKey HKLM "${REGKEY}"

  SetShellVarContext current
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete Veil's settings, logs and model cache for this user?$\r$\n$\r$\nYour identity photos in Documents\Veil\Faces are never deleted automatically." /SD IDNO IDNO keep
    RMDir /r "$APPDATA\Veil"
    RMDir /r "$LOCALAPPDATA\Veil"
  keep:
SectionEnd
