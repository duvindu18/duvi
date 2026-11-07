; Inno Setup 6.3+ script for lumo materials (free: https://jrsoftware.org/isinfo.php)
; Built by build.ps1, which passes:
;   /DVersion=2.0.0 /DPublisher="lumo" /DDistDir=... /DOutDir=...
;   /DHAVE_CERTS /DPublisherDir=... /DRootCerName=lumo-root.cer /DCodesignCerName=lumo-codesign.cer   (publisher found)
;   /DSIGN /Slumo="powershell.exe ... Sign-Lumo.ps1 -Quiet $f"                                         (signing on)
;   /DVCRedist=path\vc_redist.x64.exe                                                                 (bundle the VC++ runtime)

#ifndef Version
  #define Version "2.0.0"
#endif
#ifndef Publisher
  #define Publisher "lumo"
#endif
#ifndef DistDir
  #define DistDir "..\dist\lumo-materials"
#endif
#ifndef OutDir
  #define OutDir "..\dist"
#endif

#define AppName "lumo materials"
#define ExeName "lumo-materials.exe"

[Setup]
AppId={{047E1956-4D1A-4A40-B067-AB5DBE7D409C}
AppName={#AppName}
AppVersion={#Version}
AppVerName={#AppName} {#Version}
AppPublisher={#Publisher}
AppCopyright=Copyright (C) {#Publisher}
VersionInfoVersion={#Version}
VersionInfoCompany={#Publisher}
VersionInfoDescription={#AppName} setup
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#Version}
; per-user install by default (no administrator rights); the user may choose "all users" in the first dialog
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog commandline
DefaultDirName={autopf}\{#AppName}
DisableProgramGroupPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#OutDir}
OutputBaseFilename=lumo-materials-setup-{#Version}
SetupIconFile=..\lumo_materials\assets\icons\app.ico
UninstallDisplayIcon={app}\{#ExeName}
UninstallDisplayName={#AppName}
WizardStyle=modern
WizardImageFile=wizard.bmp,wizard-2x.bmp
WizardSmallImageFile=wizard-small.bmp,wizard-small-2x.bmp
Compression=lzma2/ultra64
SolidCompression=yes
LZMAUseSeparateProcess=yes
CloseApplications=yes
RestartApplications=no
SetupLogging=yes
#ifdef SIGN
SignTool=lumo
SignedUninstaller=yes
#endif

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"
#ifdef HAVE_CERTS
Name: "trustpublisher"; Description: "Trust the publisher ""{#Publisher}"" on this PC (Windows then shows it as a verified publisher)"; GroupDescription: "Publisher:"; Flags: unchecked
#endif

[Files]
Source: "{#DistDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
#ifdef HAVE_CERTS
Source: "{#PublisherDir}\{#RootCerName}"; DestDir: "{app}\publisher"; Flags: ignoreversion
Source: "{#PublisherDir}\{#CodesignCerName}"; DestDir: "{app}\publisher"; Flags: ignoreversion
Source: "{#PublisherDir}\publisher.json"; DestDir: "{app}\publisher"; Flags: ignoreversion
Source: "{#TrustScript}"; DestDir: "{app}\publisher"; Flags: ignoreversion
#endif

#ifdef VCRedist
; Microsoft Visual C++ 2015-2022 runtime (x64): installed only if this PC does not have it yet
; the file must be named vc_redist.x64.exe (build.ps1 makes sure of that)
Source: "{#VCRedist}"; Flags: dontcopy
#endif

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#ExeName}"; Comment: "Offline PBR material library"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#ExeName}"; Tasks: desktopicon

[Run]
#ifdef HAVE_CERTS
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\publisher\Install-LumoTrust.ps1"" -RootCer ""{app}\publisher\{#RootCerName}"" -PublisherCer ""{app}\publisher\{#CodesignCerName}"" -Scope {code:TrustScope} -Quiet"; Flags: runhidden waituntilterminated; Tasks: trustpublisher; StatusMsg: "Adding the publisher to the trusted list..."
#endif
Filename: "{app}\{#ExeName}"; Description: "Start {#AppName}"; Flags: nowait postinstall skipifsilent

[UninstallRun]
#ifdef HAVE_CERTS
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\publisher\Install-LumoTrust.ps1"" -RootCer ""{app}\publisher\{#RootCerName}"" -PublisherCer ""{app}\publisher\{#CodesignCerName}"" -Scope {code:TrustScope} -Remove -Quiet"; Flags: runhidden waituntilterminated; RunOnceId: "RemovePublisherTrust"; Tasks: trustpublisher
#endif

[Code]
function VCRedistNeeded: Boolean;
var
  Installed: Cardinal;
  Major, Minor: Cardinal;
begin
  { 14.40 or newer (VS 2022 17.10+) is what current Qt / Python builds expect }
  Result := True;
  if RegQueryDWordValue(HKLM64, 'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64', 'Installed', Installed) and (Installed = 1) and
     RegQueryDWordValue(HKLM64, 'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64', 'Major', Major) and
     RegQueryDWordValue(HKLM64, 'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64', 'Minor', Minor) then
    Result := (Major < 14) or ((Major = 14) and (Minor < 40));
end;

function TrustScope(Param: String): String;
begin
  if IsAdminInstallMode then
    Result := 'Machine'
  else
    Result := 'User';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
#ifdef VCRedist
    if VCRedistNeeded then
    begin
      WizardForm.StatusLabel.Caption := 'Installing the Microsoft Visual C++ runtime...';
      ExtractTemporaryFile('vc_redist.x64.exe');
      { the runtime installs machine-wide: Windows asks for administrator approval if setup is not elevated }
      if not ShellExec('runas', ExpandConstant('{tmp}\vc_redist.x64.exe'), '/install /quiet /norestart', '',
                       SW_HIDE, ewWaitUntilTerminated, ResultCode) then
        ResultCode := -1;
      { 0 = installed, 1638 = a newer version is present, 3010 = installed, restart pending }
      if (ResultCode <> 0) and (ResultCode <> 1638) and (ResultCode <> 3010) then
        SuppressibleMsgBox('The Microsoft Visual C++ runtime could not be installed (code ' + IntToStr(ResultCode) +
          '). Install it from https://aka.ms/vs/17/release/vc_redist.x64.exe if the program does not start.',
          mbError, MB_OK, IDOK);
    end;
#endif
    WizardForm.StatusLabel.Caption := 'Checking the installation...';
    { headless self-check: map engine + library round trip in a temporary folder }
    if not Exec(ExpandConstant('{app}\{#ExeName}'), '--check', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      ResultCode := -1;
    if ResultCode <> 0 then
      SuppressibleMsgBox('{#AppName} was installed, but its self-check did not pass (code ' + IntToStr(ResultCode) +
        '). The log is in ' + ExpandConstant('{localappdata}') + '\lumo-materials\logs.', mbError, MB_OK, IDOK);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir, Escaped: String;
  Content: AnsiString;
begin
  if CurUninstallStep <> usPostUninstall then
    exit;
  DataDir := ExpandConstant('{localappdata}\lumo-materials');
  if (not DirExists(DataDir)) or UninstallSilent then
    exit;
  if MsgBox('Also remove the settings, drafts and logs of {#AppName}?' + #13#10#13#10 + DataDir + #13#10#13#10 +
            'Your material library is never removed by the uninstaller.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) <> IDYES then
    exit;
  { never delete a folder that holds the library }
  if LoadStringFromFile(DataDir + '\data\settings.json', Content) then
  begin
    Escaped := DataDir;
    StringChangeEx(Escaped, '\', '\\', True);
    if Pos(Lowercase(Escaped), Lowercase(String(Content))) > 0 then
    begin
      MsgBox('Your library is stored inside ' + DataDir + ', so this folder is kept.', mbInformation, MB_OK);
      exit;
    end;
  end;
  { only our own sub-folders: an older lumo materials may still live in this folder }
  DelTree(DataDir + '\data', True, True, True);
  DelTree(DataDir + '\logs', True, True, True);
  RemoveDir(DataDir);
end;
