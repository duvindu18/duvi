<#
.SYNOPSIS
    Builds lumo materials into a signed Windows program and a signed installer. Free tools only.

.DESCRIPTION
    1. finds Python 3.11-3.13 (64-bit) and Inno Setup 6.3+  (missing? the script prints the winget command)
    2. creates .venv-build and installs the pinned packages
    3. runs the unit tests
    4. writes the Windows version resource (publisher name from publisher.json)
    5. PyInstaller -> dist\lumo-materials\lumo-materials.exe  (+ licences of every bundled package)
    6. self-check of the built program (lumo-materials.exe --check)
    7. signs lumo-materials.exe and Install-LumoTrust.ps1 with your publisher (Sign-Lumo.ps1)
    8. Inno Setup -> dist\lumo-materials-setup-<version>.exe, setup and uninstaller signed
    9. verifies the signatures and prints the SHA-256 of the setup

.PARAMETER PublisherDir
    Folder with publisher.json (made by New-LumoPublisher.ps1). Default: ..\..\lumo-publisher\publisher,
    or the LUMO_PUBLISHER_DIR environment variable.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File packaging\build.ps1
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File packaging\build.ps1 -NoSign -SkipTests
#>
[CmdletBinding()]
param(
    [string]$Python = "",
    [string]$PublisherDir = "",
    [string]$InnoSetup = "",
    [switch]$NoSign,
    [switch]$SkipTests,
    [switch]$NoInstaller,
    [switch]$Clean,
    [string]$VCRedist = ""          # path to vc_redist.x64.exe to embed (downloaded when "download")
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Step([string]$Text) { Write-Host ""; Write-Host "==> $Text" -ForegroundColor Cyan }
function Fail([string]$Text) { Write-Host ""; Write-Host "BUILD FAILED: $Text" -ForegroundColor Red; exit 1 }
function Run([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { Fail "$Exe $($Arguments -join ' ') (exit code $LASTEXITCODE)" }
}

# ---------------------------------------------------------------- 1. tools
Step "Looking for Python and Inno Setup"
function Test-Python([string]$Cmd, [string[]]$Pre) {
    try {
        $out = & $Cmd @Pre -c "import sys, struct; print('%d.%d %d' % (sys.version_info[0], sys.version_info[1], struct.calcsize('P') * 8))" 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $out) { return $false }
        $parts = "$out".Trim().Split(" ")
        $v = [version]$parts[0]
        return ($v -ge [version]"3.11" -and $v -lt [version]"3.14" -and $parts[1] -eq "64")
    } catch { return $false }
}
$py = $null; $pyPre = @()
if ($Python) {
    if (Test-Python $Python @()) { $py = $Python } else { Fail "$Python is not a 64-bit Python 3.11 - 3.13" }
} else {
    foreach ($v in @("3.12", "3.13", "3.11")) {
        if ((Get-Command py -ErrorAction SilentlyContinue) -and (Test-Python "py" @("-$v"))) { $py = "py"; $pyPre = @("-$v"); break }
    }
    if (-not $py -and (Get-Command python -ErrorAction SilentlyContinue) -and (Test-Python "python" @())) { $py = "python" }
}
if (-not $py) { Fail "No 64-bit Python 3.11-3.13 found. Install one (free):  winget install Python.Python.3.12" }
Write-Host "Python: $py $($pyPre -join ' ')"

$iscc = $null
if (-not $NoInstaller) {
    $candidates = @($InnoSetup,
        (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
        (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe")) | Where-Object { $_ }
    $iscc = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $iscc) { Fail "Inno Setup 6 not found. Install it (free):  winget install JRSoftware.InnoSetup   (or use -NoInstaller)" }
    # ISCC.exe itself carries no version number: read it from the other Inno Setup files
    $innoVer = $null
    foreach ($f in @("Compil32.exe", "ISCmplr.dll", "Setup.e32", "ISCC.exe")) {
        $p = Join-Path (Split-Path -Parent $iscc) $f
        if (-not (Test-Path -LiteralPath $p)) { continue }
        $vi = (Get-Item -LiteralPath $p).VersionInfo
        foreach ($raw in @($vi.ProductVersion, $vi.FileVersion)) {
            $clean = "$raw" -replace '[^\d\.].*$', ''
            if ($clean -match '^\d+\.\d+' -and [version]$clean -gt [version]"1.0") { $innoVer = [version]$clean; break }
        }
        if ($innoVer) { break }
    }
    Write-Host "Inno Setup: $iscc ($(if ($innoVer) { $innoVer } else { 'version unknown' }))"
    if ($innoVer -and $innoVer -lt [version]"6.3") { Fail "Inno Setup 6.3 or newer is needed (found $innoVer)." }
}

# ---------------------------------------------------------------- publisher
if (-not $PublisherDir) { $PublisherDir = $env:LUMO_PUBLISHER_DIR }
if (-not $PublisherDir) { $PublisherDir = Join-Path (Split-Path -Parent $Root) "lumo-publisher\publisher" }
$pubJson = Join-Path $PublisherDir "publisher.json"
$pub = $null
if (Test-Path -LiteralPath $pubJson) {
    $pub = Get-Content -LiteralPath $pubJson -Raw | ConvertFrom-Json
    Write-Host "Publisher: $($pub.publisher) ($PublisherDir)"
} else {
    Write-Host "No publisher.json in ${PublisherDir}, so building unsigned, without the 'trust publisher' option." -ForegroundColor Yellow
    $NoSign = $true
}
$signScript = Join-Path (Split-Path -Parent $PublisherDir) "Sign-Lumo.ps1"
$trustScript = Join-Path (Split-Path -Parent $PublisherDir) "Install-LumoTrust.ps1"
if (-not $NoSign -and -not (Test-Path -LiteralPath $signScript)) { Fail "Sign-Lumo.ps1 not found next to $PublisherDir" }

# ---------------------------------------------------------------- 2. environment
$venv = Join-Path $Root ".venv-build"
if ($Clean -and (Test-Path $venv)) { Remove-Item -Recurse -Force $venv }
if (-not (Test-Path (Join-Path $venv "Scripts\python.exe"))) {
    Step "Creating the build environment"
    Run $py ($pyPre + @("-m", "venv", $venv))
}
$vpy = Join-Path $venv "Scripts\python.exe"
Step "Installing packages"
Run $vpy @("-m", "pip", "install", "--disable-pip-version-check", "--upgrade", "pip")
Run $vpy @("-m", "pip", "install", "--disable-pip-version-check", "-r", "requirements.txt", "-r", "requirements-build.txt")
& $vpy -m pip freeze | Set-Content -Encoding UTF8 (Join-Path $Root "build-lock.txt")

# ---------------------------------------------------------------- 3. tests
if (-not $SkipTests) {
    Step "Running the unit tests"
    Run $vpy @("-m", "unittest", "discover", "-s", "tests", "-v")
}

# ---------------------------------------------------------------- 4 + 5. build
Step "Building the program (PyInstaller)"
$versionFile = Join-Path $Root "build\version_info.txt"
$viArgs = @("packaging\make_version_info.py", "--out", $versionFile)
if ($pub) { $viArgs += @("--publisher-json", $pubJson) }
Run $vpy $viArgs
$env:LUMO_VERSION_FILE = $versionFile
foreach ($d in @("build\lumo-materials", "dist\lumo-materials")) { if (Test-Path $d) { Remove-Item -Recurse -Force $d } }
Run $vpy @("-m", "PyInstaller", "--noconfirm", "--clean", "--distpath", "dist", "--workpath", "build", "packaging\lumo-materials.spec")
$app = Join-Path $Root "dist\lumo-materials"
$exe = Join-Path $app "lumo-materials.exe"
if (-not (Test-Path $exe)) { Fail "PyInstaller did not produce $exe" }

# licences of everything that was bundled, straight from the installed packages
$licOut = Get-ChildItem -Path $app -Recurse -Directory -Filter "licenses" | Where-Object { $_.FullName -like "*assets*" } | Select-Object -First 1
if ($licOut) {
    $pkgDir = Join-Path $licOut.FullName "packages"
    New-Item -ItemType Directory -Force -Path $pkgDir | Out-Null
    $site = & $vpy -c "import sysconfig; print(sysconfig.get_paths()['purelib'])"
    foreach ($info in Get-ChildItem -Path $site -Directory -Filter "*.dist-info") {
        $name = $info.Name -replace '\.dist-info$', ''
        if ($name -match '^(pip|setuptools|wheel|pyinstaller|pyinstaller_hooks_contrib|altgraph|pefile|pywin32_ctypes|packaging)-') { continue }
        $files = Get-ChildItem -Path $info.FullName -Recurse -File | Where-Object { $_.Name -match '^(LICEN[CS]E|COPYING|NOTICE|AUTHORS)' }
        foreach ($f in $files) { Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $pkgDir "$name-$($f.Name)") -Force }
    }
    $pyLic = Join-Path (& $vpy -c "import sys; print(sys.base_prefix)") "LICENSE.txt"
    if (Test-Path $pyLic) { Copy-Item $pyLic (Join-Path $pkgDir "Python-LICENSE.txt") -Force }
}
$size = (Get-ChildItem -Path $app -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB
Write-Host ("Program folder: {0}  ({1:N0} MB)" -f $app, $size)

# ---------------------------------------------------------------- 6. self-check
Step "Self-check of the built program"
$p = Start-Process -FilePath $exe -ArgumentList "--check" -Wait -PassThru -WindowStyle Hidden
if ($p.ExitCode -ne 0) { Fail "lumo-materials.exe --check returned $($p.ExitCode). See $env:LOCALAPPDATA\lumo-materials\logs\lumo-materials.log" }
Write-Host "OK" -ForegroundColor Green

# ---------------------------------------------------------------- 7. sign the program
$signCmd = $null
if (-not $NoSign) {
    Step "Signing the program as $($pub.publisher)"
    $toSign = @($exe)
    $trustCopy = Join-Path $Root "build\Install-LumoTrust.ps1"
    Copy-Item -LiteralPath $trustScript -Destination $trustCopy -Force
    $toSign += $trustCopy
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $signScript @toSign
    if ($LASTEXITCODE -ne 0) { Fail "signing failed" }
    # Inno replaces $q with a quote and $f with the quoted file name (no embedded quotes: PowerShell 5.1 would mangle them)
    $signCmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `$q$signScript`$q -Quiet `$f"
    $trustScript = $trustCopy
}

# ---------------------------------------------------------------- 8. installer
if (-not $NoInstaller) {
    Step "Building the installer (Inno Setup)"
    $version = (& $vpy -c "import lumo_materials; print(lumo_materials.__version__)").Trim()
    $isArgs = @("/Qp", "/DVersion=$version", "/DDistDir=$app", "/DOutDir=$(Join-Path $Root 'dist')")
    if ($pub) {
        $isArgs += @("/DPublisher=$($pub.publisher)", "/DHAVE_CERTS", "/DPublisherDir=$PublisherDir",
                     "/DRootCerName=$($pub.files.root_cer)", "/DCodesignCerName=$($pub.files.codesign_cer)",
                     "/DTrustScript=$trustScript")
    }
    if ($signCmd) { $isArgs += @("/DSIGN", "/Slumo=$signCmd") }
    if ($VCRedist -eq "download") {
        $VCRedist = Join-Path $Root "build\vc_redist.x64.exe"
        if (-not (Test-Path $VCRedist)) {
            Write-Host "Downloading the Microsoft Visual C++ runtime (free redistributable)"
            Invoke-WebRequest -UseBasicParsing -Uri "https://aka.ms/vs/17/release/vc_redist.x64.exe" -OutFile $VCRedist
        }
    }
    if ($VCRedist) {
        if (-not (Test-Path -LiteralPath $VCRedist)) { Fail "VC++ runtime not found: $VCRedist" }
        if ((Split-Path -Leaf $VCRedist) -ne "vc_redist.x64.exe") {
            $copy = Join-Path $Root "build\vc_redist.x64.exe"
            Copy-Item -LiteralPath $VCRedist -Destination $copy -Force
            $VCRedist = $copy
        }
        $isArgs += "/DVCRedist=$((Resolve-Path -LiteralPath $VCRedist).Path)"
    }
    $isArgs += (Join-Path $Root "packaging\installer.iss")
    Run $iscc $isArgs
    $setup = Join-Path $Root "dist\lumo-materials-setup-$version.exe"
    if (-not (Test-Path $setup)) { Fail "Inno Setup did not produce $setup" }

    # ------------------------------------------------------------ 9. verify
    Step "Verifying"
    foreach ($f in @($exe, $setup)) {
        $sig = Get-AuthenticodeSignature -FilePath $f
        $who = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { "not signed" }
        Write-Host ("{0,-34} {1,-14} {2}" -f (Split-Path -Leaf $f), $sig.Status, $who)
    }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $setup).Hash
    Set-Content -LiteralPath "$setup.sha256" -Value "$hash  $(Split-Path -Leaf $setup)" -Encoding ASCII
    Write-Host ""
    Write-Host "Installer: $setup" -ForegroundColor Green
    Write-Host "SHA-256:   $hash"
    if (-not $NoSign) {
        Write-Host "Status 'UnknownError' only means this PC does not trust your root yet (Install-LumoTrust.ps1)." -ForegroundColor DarkGray
    }
}
