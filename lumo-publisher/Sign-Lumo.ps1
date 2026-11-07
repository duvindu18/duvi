<#
.SYNOPSIS
    Signs .exe / .dll / .ps1 / .msi files with your lumo publisher certificate (Authenticode, SHA-256)
    and adds a free RFC 3161 timestamp, so signatures stay valid after the certificate expires.

.DESCRIPTION
    Uses only Windows PowerShell 5.1 (Set-AuthenticodeSignature). The certificate is taken from,
    in this order:
      1. -Pfx <file>       (password from -PasswordEnv variable, default LUMO_SIGN_PASSWORD, else asked)
      2. -Thumbprint <x>   (Current User > Personal store)
      3. publisher.json    (next to this script or in .\publisher) -> its signing_thumbprint in the store,
                           else its <slug>-codesign.pfx
    Exit code 0 = every file signed and verified; 1 = at least one failure.

.EXAMPLE
    .\Sign-Lumo.ps1 dist\lumo-materials.exe dist\lumo-materials-setup.exe

.EXAMPLE
    # Inno Setup: Tools > Configure Sign Tools, name "lumo", command:
    #   powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\lumo-publisher\Sign-Lumo.ps1" -Quiet $f
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0, ValueFromRemainingArguments = $true)]
    [string[]]$Path,
    [string]$Pfx = "",
    [string]$Thumbprint = "",
    [string]$PasswordEnv = "LUMO_SIGN_PASSWORD",
    [string[]]$TimestampServer = @(
        "http://timestamp.digicert.com",
        "http://timestamp.sectigo.com",
        "http://timestamp.globalsign.com/tsa/r6advanced1"
    ),
    [switch]$NoTimestamp,
    [switch]$Quiet
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

function Say([string]$Text, [string]$Color = "Gray") { if (-not $Quiet) { Write-Host $Text -ForegroundColor $Color } }

function Find-PublisherJson {
    foreach ($p in @((Join-Path $PSScriptRoot "publisher.json"), (Join-Path $PSScriptRoot "publisher\publisher.json"))) {
        if (Test-Path -LiteralPath $p) { return $p }
    }
    return $null
}

function Get-Password([string]$ForFile) {
    $envValue = [Environment]::GetEnvironmentVariable($PasswordEnv)
    if ($envValue) { return $envValue }
    $s = Read-Host -AsSecureString "Password for $(Split-Path -Leaf $ForFile)"
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Open-Pfx([string]$File) {
    $flags = [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::UserKeySet
    $cert = New-Object Security.Cryptography.X509Certificates.X509Certificate2((Resolve-Path -LiteralPath $File).Path, (Get-Password $File), $flags)
    if (-not $cert.HasPrivateKey) { throw "$File has no private key." }
    return $cert
}

function Get-FromStore([string]$Thumb) {
    $t = ($Thumb -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
    $c = Get-ChildItem -LiteralPath Cert:\CurrentUser\My | Where-Object { $_.Thumbprint -eq $t } | Select-Object -First 1
    if ($c -and $c.HasPrivateKey) { return $c }
    return $null
}

# ---------- pick the certificate ----------
$cert = $null
if ($Pfx) {
    $cert = Open-Pfx $Pfx
} elseif ($Thumbprint) {
    $cert = Get-FromStore $Thumbprint
    if (-not $cert) { throw "No certificate with private key and thumbprint $Thumbprint in Current User > Personal." }
} else {
    $json = Find-PublisherJson
    if (-not $json) { throw "No -Pfx, no -Thumbprint and no publisher.json found. Run New-LumoPublisher.ps1 first." }
    $info = Get-Content -LiteralPath $json -Raw | ConvertFrom-Json
    $cert = Get-FromStore $info.signing_thumbprint
    if (-not $cert) {
        $pfxFile = Join-Path (Split-Path -Parent $json) $info.files.codesign_pfx
        if (-not (Test-Path -LiteralPath $pfxFile)) { throw "Signing certificate $($info.signing_thumbprint) is not in the store and $pfxFile is missing." }
        $cert = Open-Pfx $pfxFile
    }
}

$codeSigningOid = "1.3.6.1.5.5.7.3.3"
$eku = $cert.Extensions | Where-Object { $_ -is [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] }
if (-not $eku -or -not ($eku.EnhancedKeyUsages | Where-Object { $_.Value -eq $codeSigningOid })) {
    throw "Certificate $($cert.Subject) is not a code-signing certificate."
}
if ($cert.NotAfter -lt (Get-Date)) { throw "Certificate $($cert.Subject) expired on $($cert.NotAfter). Renew it with New-LumoPublisher.ps1 -RootPfx ..." }
if ($cert.NotAfter -lt (Get-Date).AddDays(60)) { Say "Warning: the signing certificate expires on $($cert.NotAfter.ToString('yyyy-MM-dd'))." Yellow }

Say "Signing as: $($cert.Subject)  [$($cert.Thumbprint)]"

# ---------- collect files ----------
$targets = New-Object System.Collections.Generic.List[string]
foreach ($p in $Path) {
    $p = $p.Trim('"')
    $items = @(Get-ChildItem -Path $p -File -ErrorAction SilentlyContinue)
    if ($items.Count -eq 0) { Write-Host "Not found: $p" -ForegroundColor Red; $targets.Add("?" + $p); continue }
    foreach ($i in $items) { $targets.Add($i.FullName) }
}

# ---------- sign + verify ----------
$failed = 0
foreach ($file in $targets) {
    if ($file.StartsWith("?")) { $failed++; continue }
    $signed = $false
    $lastError = ""
    $servers = if ($NoTimestamp) { @($null) } else { $TimestampServer }
    foreach ($ts in $servers) {
        try {
            $sigArgs = @{ FilePath = $file; Certificate = $cert; HashAlgorithm = "SHA256"; IncludeChain = "NotRoot"; Force = $true }
            if ($ts) { $sigArgs.TimestampServer = $ts }
            $r = Set-AuthenticodeSignature @sigArgs
            if ($r.SignerCertificate -and $r.SignerCertificate.Thumbprint -eq $cert.Thumbprint) { $signed = $true; break }
            $lastError = "$($r.Status): $($r.StatusMessage)"
        } catch {
            $lastError = $_.Exception.Message
        }
        if ($ts) { Say "  timestamp server $ts failed, trying the next one ..." DarkYellow }
    }
    if (-not $signed) {
        Write-Host "FAILED  $file`n        $lastError" -ForegroundColor Red
        $failed++
        continue
    }

    $v = Get-AuthenticodeSignature -FilePath $file
    $okSigner = $v.SignerCertificate -and $v.SignerCertificate.Thumbprint -eq $cert.Thumbprint
    $okStamp  = $NoTimestamp -or ($null -ne $v.TimeStamperCertificate)
    if (-not $okSigner -or $v.Status -eq "HashMismatch" -or $v.Status -eq "NotSigned") {
        Write-Host "FAILED  $file`n        verification: $($v.Status) $($v.StatusMessage)" -ForegroundColor Red
        $failed++
    } elseif (-not $okStamp) {
        Write-Host "FAILED  $file`n        signed, but no timestamp server answered (use -NoTimestamp to accept)" -ForegroundColor Red
        $failed++
    } elseif ($v.Status -eq "Valid") {
        Say "OK      $file  (trusted on this PC)" Green
    } else {
        # Typically "UnknownError: ... root certificate which is not trusted" until the root is trusted here.
        Say "OK      $file  (signed; this PC does not trust your root yet: run Install-LumoTrust.ps1 to check)" Green
    }
}

if ($failed -gt 0) { Write-Host "$failed file(s) failed." -ForegroundColor Red; exit 1 }
exit 0
