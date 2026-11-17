# Installs PC Agent autosave for the current user:
#  - Python dependency (psutil)
#  - a logon task that runs "autosave watch" in the background
#  - desktop shortcuts: "Save all now" and "Save all + shut down"
# Run in a normal (non-admin) PowerShell from the pcagent folder:
#   powershell -ExecutionPolicy Bypass -File scripts\install_autosave.ps1
param(
    [int]$IntervalMinutes = 10,
    [switch]$Uninstall
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$taskName = "PCAgent Autosave"
$desktop = [Environment]::GetFolderPath("Desktop")

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item "$desktop\Save all now.lnk", "$desktop\Save all + shut down.lnk" -ErrorAction SilentlyContinue
    Write-Host "Removed."
    exit 0
}

$py = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $py) { throw "Python 3.11+ not found on PATH. Install it from python.org first." }
$pyw = Join-Path (Split-Path $py) "pythonw.exe"
& $py -c "import sys; assert sys.version_info >= (3, 11), 'Python 3.11+ required'"
& $py -m pip install --user -r "$root\requirements.txt"

# Logon task: runs in YOUR desktop session (it has to, to press keys in your apps).
$action = New-ScheduledTaskAction -Execute $pyw -Argument "-m autosave watch --interval $IntervalMinutes" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

$shell = New-Object -ComObject WScript.Shell
foreach ($s in @(
    @{ Name = "Save all now"; Args = "-m autosave save" },
    @{ Name = "Save all + shut down"; Args = "-m autosave shutdown" })) {
    $lnk = $shell.CreateShortcut("$desktop\$($s.Name).lnk")
    $lnk.TargetPath = $py
    $lnk.Arguments = $s.Args
    $lnk.WorkingDirectory = $root
    $lnk.Save()
}

Write-Host "Installed. Autosave runs every $IntervalMinutes min while you are idle."
Write-Host "Log + reports: $env:LOCALAPPDATA\PCAgent\autosave"
Write-Host "Check what it detects:  cd `"$root`"; python -m autosave list"
