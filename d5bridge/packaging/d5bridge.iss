; Inno Setup script: iscc packaging\d5bridge.iss  (after PyInstaller)
#define AppVersion "1.2.0"
[Setup]
AppId={{6E7B1D4C-5D2B-4E3A-9F55-D5B1D9E0A001}
AppName=D5 Bridge
AppVersion={#AppVersion}
AppPublisher=D5 Bridge
DefaultDirName={autopf}\D5 Bridge
DefaultGroupName=D5 Bridge
OutputDir=..\dist
OutputBaseFilename=D5BridgeSetup-{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
ChangesAssociations=yes

[Files]
Source: "..\dist\D5Bridge\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{group}\D5 Bridge"; Filename: "{app}\D5Bridge.exe"
Name: "{group}\Install 3ds Max toolbar button"; Filename: "{app}\_internal\max_plugin\install_max_plugin.bat"
Name: "{autodesktop}\D5 Bridge"; Filename: "{app}\D5Bridge.exe"; Tasks: desktopicon

[Tasks]
Name: desktopicon; Description: "Desktop shortcut"; Flags: unchecked
Name: maxplugin; Description: "Install the D5 Bridge button into 3ds Max"

[Run]
Filename: "{app}\_internal\max_plugin\install_max_plugin.bat"; Tasks: maxplugin; Flags: runhidden waituntilterminated
Filename: "{app}\D5Bridge.exe"; Description: "Start D5 Bridge"; Flags: postinstall nowait skipifsilent

[Registry]
Root: HKA; Subkey: "Software\Classes\SystemFileAssociations\.max\shell\D5Bridge"; ValueType: string; ValueData: "Open in D5 Bridge"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\SystemFileAssociations\.max\shell\D5Bridge\command"; ValueType: string; ValueData: """{app}\D5Bridge.exe"" ""%1"""
Root: HKA; Subkey: "Software\Classes\SystemFileAssociations\.fbx\shell\D5Bridge"; ValueType: string; ValueData: "Open in D5 Bridge"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\SystemFileAssociations\.fbx\shell\D5Bridge\command"; ValueType: string; ValueData: """{app}\D5Bridge.exe"" ""%1"""
Root: HKA; Subkey: "Software\Classes\Directory\shell\D5Bridge"; ValueType: string; ValueData: "Open in D5 Bridge (Megascans)"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\Directory\shell\D5Bridge\command"; ValueType: string; ValueData: """{app}\D5Bridge.exe"" ""%1"""
