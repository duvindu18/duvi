<#
.SYNOPSIS
    Launch Veil from the project virtualenv. Extra arguments are forwarded,
    e.g.  .\scripts\run.ps1 --headless -i clip.mp4 -o clip_anon.mp4
#>
$repo = Split-Path -Parent $PSScriptRoot
$py = Join-Path $repo ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) { throw "Virtualenv missing - run scripts\setup_windows.ps1 first." }

# Make CUDA / cuDNN / TensorRT DLLs discoverable by ONNX Runtime.
foreach ($dir in @("$env:CUDA_PATH\bin", "$env:CUDNN_PATH\bin", "$env:TENSORRT_PATH\lib")) {
    if ($dir -and (Test-Path $dir) -and ($env:PATH -notlike "*$dir*")) { $env:PATH = "$dir;$env:PATH" }
}
& $py (Join-Path $repo "main.py") @args
exit $LASTEXITCODE
