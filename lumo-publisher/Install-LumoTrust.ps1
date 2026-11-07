<#
.SYNOPSIS
    Makes a PC trust (or stop trusting) your lumo publisher.

.DESCRIPTION
    Adds <slug>-root.cer to "Trusted Root Certification Authorities" and <slug>-codesign.cer to
    "Trusted Publishers". Afterwards Windows shows your publisher name as verified on files you signed.

    -Scope Machine  all users of the PC; needs administrator rights (the lumo installer uses this,
                    only when the user ticks "Trust the lumo publisher on this PC").
    -Scope User     only the current user, no admin rights; Windows asks for confirmation once.
    -Remove         takes both certificates out again (the uninstaller calls this).

    The root is restricted to code signing (EKU 1.3.6.1.5.5.7.3.3, pathlength 0): it cannot be used to
    vouch for web sites. Certificates that are not a lumo-style code-signing root are refused.

.EXAMPLE
    .\Install-LumoTrust.ps1 -RootCer .\publisher\lumo-root.cer -PublisherCer .\publisher\lumo-codesign.cer -Scope Machine
.EXAMPLE
    .\Install-LumoTrust.ps1 -RootCer .\publisher\lumo-root.cer -PublisherCer .\publisher\lumo-codesign.cer -Scope Machine -Remove
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$RootCer,
    [string]$PublisherCer = "",
    [ValidateSet("Machine", "User")][string]$Scope = "Machine",
    [switch]$Remove,
    [switch]$Quiet
)

Set-StrictMode -Version 2
$ErrorActionPreference = 'Stop'

function Say([string]$Text, [string]$Color = "Gray") { if (-not $Quiet) { Write-Host $Text -ForegroundColor $Color } }

function Read-Cert([string]$File) {
    if (-not (Test-Path -LiteralPath $File)) { throw "Not found: $File" }
    return New-Object Security.Cryptography.X509Certificates.X509Certificate2((Resolve-Path -LiteralPath $File).Path)
}

$location = if ($Scope -eq "Machine") { "LocalMachine" } else { "CurrentUser" }
if ($Scope -eq "Machine") {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "-Scope Machine needs administrator rights. Run elevated, or use -Scope User."
    }
}

$root = Read-Cert $RootCer
if ($root.HasPrivateKey) { throw "$RootCer contains a private key. Only the public .cer may be installed." }

# Refuse anything that is not a code-signing-only, self-signed CA with pathlength 0.
$bc  = $root.Extensions | Where-Object { $_ -is [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension] }
$eku = $root.Extensions | Where-Object { $_ -is [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] }
$ekuValues = if ($eku) { @($eku.EnhancedKeyUsages | ForEach-Object { $_.Value }) } else { @() }
if ($root.Subject -ne $root.Issuer -or -not $bc -or -not $bc.CertificateAuthority -or
    -not $bc.HasPathLengthConstraint -or $bc.PathLengthConstraint -ne 0 -or
    $ekuValues.Count -ne 1 -or $ekuValues[0] -ne "1.3.6.1.5.5.7.3.3") {
    throw "$RootCer is not a code-signing-only root (self-signed, CA, pathlength 0, EKU code signing). Refusing to trust it."
}

$publisher = $null
if ($PublisherCer) {
    $publisher = Read-Cert $PublisherCer
    if ($publisher.HasPrivateKey) { throw "$PublisherCer contains a private key. Only the public .cer may be installed." }
    if ($publisher.Issuer -ne $root.Subject) { throw "$PublisherCer was not issued by $($root.Subject)." }
}

function Set-InStore([Security.Cryptography.X509Certificates.X509Certificate2]$Cert, [string]$StoreName) {
    $store = New-Object Security.Cryptography.X509Certificates.X509Store($StoreName, $location)
    $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    try {
        $found = @($store.Certificates | Where-Object { $_.Thumbprint -eq $Cert.Thumbprint })
        if ($Remove) {
            foreach ($f in $found) { $store.Remove($f) }
            if ($found.Count) { Say "Removed  $($Cert.Subject)  from $location\$StoreName" } else { Say "Absent   $($Cert.Subject)  in $location\$StoreName" }
        } elseif ($found.Count -eq 0) {
            $store.Add($Cert)
            Say "Added    $($Cert.Subject)  to $location\$StoreName" Green
        } else {
            Say "Present  $($Cert.Subject)  in $location\$StoreName"
        }
    } finally { $store.Close() }
}

Set-InStore $root "Root"
if ($publisher) { Set-InStore $publisher "TrustedPublisher" }

if (-not $Remove -and $publisher) {
    $chain = New-Object Security.Cryptography.X509Certificates.X509Chain
    $chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
    [void]$chain.ChainPolicy.ApplicationPolicy.Add((New-Object Security.Cryptography.Oid("1.3.6.1.5.5.7.3.3")))
    if ($chain.Build($publisher)) { Say "This PC now trusts code signed by $($publisher.Subject)." Green }
    else {
        $why = ($chain.ChainStatus | ForEach-Object { $_.StatusInformation.Trim() }) -join "; "
        Write-Host "Installed, but the chain does not validate yet: $why" -ForegroundColor Yellow
    }
}
exit 0
