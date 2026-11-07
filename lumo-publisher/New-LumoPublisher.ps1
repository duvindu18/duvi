<#
.SYNOPSIS
    Creates your own free code-signing publisher for lumo: a private root certificate
    and a code-signing certificate issued by it.

.DESCRIPTION
    Uses only what ships with Windows 10/11 (Windows PowerShell 5.1, New-SelfSignedCertificate).
    Nothing is downloaded and the private keys never leave this PC.

    Files written to -OutDir:
      <slug>-codesign.pfx              signing certificate + private key (password protected)  -> used by Sign-Lumo.ps1
      <slug>-codesign.cer              signing certificate, public                              -> TrustedPublisher on target PCs
      <slug>-root.cer                  root certificate, public                                 -> Trusted Root on target PCs
      <slug>-root-PRIVATE-backup.pfx   root certificate + private key (password protected)      -> keep OFFLINE, only for renewal
      publisher.json                   names, thumbprints, validity (read by Sign-Lumo.ps1)

    The root is limited to code signing (extended key usage 1.3.6.1.5.5.7.3.3) and may not issue
    further CAs (pathlength 0), so trusting it on a PC cannot be misused for web (TLS) certificates.
    By default the root's private key is removed from the certificate store after the signing
    certificate is issued; it then exists only in the backup file.

.PARAMETER Publisher
    Name shown by Windows as the publisher ("Verified publisher: <name>"). Default: lumo.

.PARAMETER RootPfx
    Renewal: an existing <slug>-root-PRIVATE-backup.pfx. A new signing certificate is issued from it
    instead of creating a new root, so PCs that already trust your root keep trusting new builds.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File .\New-LumoPublisher.ps1 -Publisher "lumo"

.EXAMPLE
    .\New-LumoPublisher.ps1 -Publisher "lumo" -RootPfx .\publisher\lumo-root-PRIVATE-backup.pfx -Force
#>
[CmdletBinding()]
param(
    [ValidateNotNullOrEmpty()][string]$Publisher = "lumo",
    [string]$Organization = "",
    [ValidatePattern('^([A-Za-z]{2})?$')][string]$Country = "",
    [string]$OutDir = "",
    [ValidateRange(2, 30)][int]$RootYears = 15,
    [ValidateRange(1, 10)][int]$SigningYears = 5,
    [string]$RootPfx = "",
    [switch]$TrustOnThisPC,
    [switch]$KeepRootInStore,
    [switch]$Force
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSVersion.Major -lt 5) { throw "Windows PowerShell 5.1 or newer is needed." }
if (-not (Get-Command New-SelfSignedCertificate -ErrorAction SilentlyContinue)) {
    throw "New-SelfSignedCertificate is not available. Run this in Windows PowerShell on Windows 10 or 11."
}
if ($SigningYears -ge $RootYears) { throw "-SigningYears ($SigningYears) must be smaller than -RootYears ($RootYears)." }
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot "publisher" }

function Format-RdnValue([string]$Value) {
    # RFC 4514 style quoting for characters that would break the subject string.
    if ($Value -match '[,+"\\<>;=#]' -or $Value -ne $Value.Trim()) { return '"' + ($Value -replace '"', '""') + '"' }
    return $Value
}

function New-Subject([string]$CommonName) {
    $parts = @("CN=" + (Format-RdnValue $CommonName))
    if ($Organization) { $parts += "O=" + (Format-RdnValue $Organization) }
    if ($Country)      { $parts += "C=" + $Country.ToUpperInvariant() }
    return ($parts -join ", ")
}

function ConvertTo-Plain([Security.SecureString]$Secure) {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

function Read-NewPassword {
    while ($true) {
        $a = Read-Host -AsSecureString "Password for the .pfx files (at least 12 characters)"
        $b = Read-Host -AsSecureString "Repeat the password"
        $pa = ConvertTo-Plain $a; $pb = ConvertTo-Plain $b
        if ($pa -ne $pb)       { Write-Host "The passwords differ. Try again." -ForegroundColor Yellow; continue }
        if ($pa.Length -lt 12) { Write-Host "Too short. Use at least 12 characters." -ForegroundColor Yellow; continue }
        return $a
    }
}

$slug = ($Publisher.ToLowerInvariant() -replace '[^a-z0-9]+', '-').Trim('-')
if (-not $slug) { $slug = "publisher" }

$files = [ordered]@{
    codesign_pfx = Join-Path $OutDir "$slug-codesign.pfx"
    codesign_cer = Join-Path $OutDir "$slug-codesign.cer"
    root_cer     = Join-Path $OutDir "$slug-root.cer"
    root_backup  = Join-Path $OutDir "$slug-root-PRIVATE-backup.pfx"
    json         = Join-Path $OutDir "publisher.json"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$existing = @($files.codesign_pfx, $files.codesign_cer, $files.json) | Where-Object { Test-Path $_ }
if (-not $RootPfx) { $existing += @($files.root_cer, $files.root_backup) | Where-Object { Test-Path $_ } }
if ($existing -and -not $Force) {
    throw ("A publisher already exists here:`n  " + ($existing -join "`n  ") +
           "`nUse -Force to replace it, or -RootPfx to renew the signing certificate from the existing root.")
}

$password = Read-NewPassword
$rootImported = $false

if ($RootPfx) {
    # ---------- renewal: reuse the existing root ----------
    if (-not (Test-Path $RootPfx)) { throw "Root backup not found: $RootPfx" }
    Write-Host "Loading root from $RootPfx ..."
    $rootPw = Read-Host -AsSecureString "Password of the root backup (Enter = same as above)"
    if ($rootPw.Length -eq 0) { $rootPw = $password }
    $imported = Import-PfxCertificate -FilePath $RootPfx -CertStoreLocation Cert:\CurrentUser\My -Password $rootPw -Exportable
    $root = @($imported | Where-Object { $_.HasPrivateKey -and $_.Subject -eq $_.Issuer })[0]
    if (-not $root) { throw "$RootPfx does not contain a self-signed root with its private key." }
    $rootImported = $true
    $rootPath = [IO.Path]::GetFullPath($RootPfx)
    $backupPath = [IO.Path]::GetFullPath($files.root_backup)
    if ($rootPath -ne $backupPath) { Copy-Item -LiteralPath $RootPfx -Destination $files.root_backup -Force }
} else {
    # ---------- new root ----------
    Write-Host "Creating root certificate '$Publisher Root CA' (RSA 4096, $RootYears years) ..."
    $root = New-SelfSignedCertificate `
        -Subject (New-Subject "$Publisher Root CA") `
        -FriendlyName "$Publisher Root CA" `
        -KeyAlgorithm RSA -KeyLength 4096 -HashAlgorithm SHA256 `
        -KeyExportPolicy Exportable `
        -KeyUsage CertSign, CRLSign, DigitalSignature -KeyUsageProperty Sign `
        -CertStoreLocation Cert:\CurrentUser\My `
        -NotBefore (Get-Date).AddDays(-1) -NotAfter (Get-Date).AddYears($RootYears) `
        -TextExtension @(
            "2.5.29.19={critical}{text}ca=1&pathlength=0",
            "2.5.29.37={text}1.3.6.1.5.5.7.3.3"
        )
    $rootImported = $true
    Export-PfxCertificate -Cert $root -FilePath $files.root_backup -Password $password -ChainOption EndEntityCertOnly | Out-Null
}

try {
    $leafNotAfter = (Get-Date).AddYears($SigningYears)
    if ($leafNotAfter -gt $root.NotAfter) { $leafNotAfter = $root.NotAfter.AddDays(-1) }

    Write-Host "Creating code-signing certificate '$Publisher' (RSA 3072, valid until $($leafNotAfter.ToString('yyyy-MM-dd'))) ..."
    $leaf = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject (New-Subject $Publisher) `
        -FriendlyName "$Publisher code signing" `
        -Signer $root `
        -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
        -KeyExportPolicy Exportable `
        -KeyUsage DigitalSignature `
        -CertStoreLocation Cert:\CurrentUser\My `
        -NotBefore (Get-Date).AddDays(-1) -NotAfter $leafNotAfter

    Export-PfxCertificate -Cert $leaf -FilePath $files.codesign_pfx -Password $password -ChainOption EndEntityCertOnly | Out-Null
    Export-Certificate -Cert $leaf -FilePath $files.codesign_cer -Type CERT | Out-Null
    Export-Certificate -Cert $root -FilePath $files.root_cer -Type CERT | Out-Null
}
finally {
    if ($rootImported -and -not $KeepRootInStore) {
        # The root key now lives only in the backup .pfx. Remove it (and its key) from the store.
        Remove-Item -LiteralPath ("Cert:\CurrentUser\My\" + $root.Thumbprint) -DeleteKey -ErrorAction SilentlyContinue
    }
}

$info = [ordered]@{
    publisher          = $Publisher
    subject            = $leaf.Subject
    signing_thumbprint = $leaf.Thumbprint
    signing_not_after  = $leaf.NotAfter.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    root_subject       = $root.Subject
    root_thumbprint    = $root.Thumbprint
    root_not_after     = $root.NotAfter.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    files              = [ordered]@{
        codesign_pfx = Split-Path -Leaf $files.codesign_pfx
        codesign_cer = Split-Path -Leaf $files.codesign_cer
        root_cer     = Split-Path -Leaf $files.root_cer
        root_backup  = Split-Path -Leaf $files.root_backup
    }
    created_by         = "New-LumoPublisher.ps1"
    created_utc        = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
}
$info | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $files.json -Encoding UTF8

if ($TrustOnThisPC) {
    & (Join-Path $PSScriptRoot "Install-LumoTrust.ps1") -RootCer $files.root_cer -PublisherCer $files.codesign_cer -Scope User
}

Write-Host ""
Write-Host "Publisher '$Publisher' created in $OutDir" -ForegroundColor Green
Write-Host "  signing certificate  $($leaf.Thumbprint)  (also kept in Current User > Personal for Sign-Lumo.ps1)"
Write-Host "  root certificate     $($root.Thumbprint)"
Write-Host ""
Write-Host "Keep $(Split-Path -Leaf $files.root_backup) and the password OFFLINE (USB stick, password manager)." -ForegroundColor Yellow
Write-Host "Never ship the .pfx files. Ship only the .cer files."
