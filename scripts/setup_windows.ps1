<#
.SYNOPSIS
    One-shot environment setup for Veil on Windows 10/11 x64.

.DESCRIPTION
    Creates .venv with Python 3.11, installs the pinned dependencies for the
    chosen accelerator, removes the duplicate OpenCV wheel that insightface's
    dependency chain pulls in, pre-downloads the face models and prints a
    hardware / execution-provider report.

.PARAMETER Accelerator
    cuda      NVIDIA GPU via CUDA 12.x + cuDNN 9.x (+ TensorRT 10.x if installed)  [default]
    directml  Any DirectX 12 GPU (AMD, Intel Arc/iGPU, NVIDIA) - no CUDA install needed
    openvino  Intel CPU / iGPU / NPU
    cpu       Portable CPU-only build

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\setup_windows.ps1 -Accelerator cuda
#>
[CmdletBinding()]
param(
    [ValidateSet("cuda", "directml", "openvino", "cpu")]
    [string]$Accelerator = "cuda",
    [string]$Python = "py -3.11",
    [switch]$Dev
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor DarkYellow }

Step "Checking Python 3.11"
$pyExe, $pyArgs = $Python.Split(" ", 2)
& $pyExe $pyArgs --version
if ($LASTEXITCODE -ne 0) {
    throw "Python 3.11 not found. Install it with:  winget install -e --id Python.Python.3.11"
}

if (-not (Test-Path ".venv")) {
    Step "Creating virtual environment (.venv)"
    & $pyExe $pyArgs -m venv .venv
}
$venvPy = Join-Path (Get-Location) ".venv\Scripts\python.exe"

Step "Upgrading pip / setuptools / wheel"
& $venvPy -m pip install --upgrade pip==24.2 setuptools==75.1.0 wheel==0.44.0 Cython==3.0.11

Step "Installing dependencies for '$Accelerator'"
$req = Get-Content requirements.txt
switch ($Accelerator) {
    "cuda"     { $ort = "onnxruntime-gpu==1.19.2" }
    "directml" { $ort = "onnxruntime-directml==1.19.2" }
    "openvino" { $ort = "onnxruntime-openvino==1.19.0" }
    "cpu"      { $ort = "onnxruntime==1.19.2" }
}
$tmpReq = Join-Path $env:TEMP "veil-requirements.txt"
$req | ForEach-Object { if ($_ -match "^onnxruntime") { $ort } else { $_ } } | Set-Content $tmpReq -Encoding ascii

# Remove any other ONNX Runtime flavour first: they share the 'onnxruntime' module name.
& $venvPy -m pip uninstall -y onnxruntime onnxruntime-gpu onnxruntime-directml onnxruntime-openvino 2>$null | Out-Null
& $venvPy -m pip install -r $tmpReq
if ($LASTEXITCODE -ne 0) {
    throw @"
pip install failed. If the error mentions insightface / 'Microsoft Visual C++ 14.0 is required', install the
build tools and re-run this script:
    winget install -e --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
"@
}
if ($Dev) { & $venvPy -m pip install pytest==8.3.3 pyinstaller==6.10.0 }

Step "De-duplicating OpenCV (keep opencv-contrib-python only)"
& $venvPy -m pip uninstall -y opencv-python opencv-python-headless opencv-contrib-python-headless 2>$null | Out-Null
& $venvPy -m pip install --force-reinstall --no-deps opencv-contrib-python==4.10.0.84

if ($Accelerator -eq "cuda") {
    Step "Checking CUDA / cuDNN runtime DLLs"
    $cudaBin = if ($env:CUDA_PATH) { Join-Path $env:CUDA_PATH "bin" } else { $null }
    if (-not $cudaBin -or -not (Test-Path (Join-Path $cudaBin "cublas64_12.dll"))) {
        Write-Warning "CUDA 12.x not found (CUDA_PATH unset or cublas64_12.dll missing). See README section 'CUDA / cuDNN'."
    }
    $cudnn = Get-Command cudnn64_9.dll -ErrorAction SilentlyContinue
    if (-not $cudnn) {
        Write-Warning "cudnn64_9.dll is not on PATH. ONNX Runtime will fall back to CPU until cuDNN 9 is installed."
    }
    $trt = Get-Command nvinfer_10.dll -ErrorAction SilentlyContinue
    if ($trt) { Write-Host "TensorRT 10 detected: $($trt.Source)" -ForegroundColor Green }
    else { Write-Host "TensorRT not found (optional) - CUDA provider will be used." }
}

Step "Downloading face models (InsightFace buffalo_l + YuNet/SFace fallback)"
& $venvPy -c @"
from app.core.config import EngineConfig, Backend, Device
from app.core.engine import FaceEngine
for backend in (Backend.YUNET, Backend.INSIGHTFACE):
    try:
        e = FaceEngine(EngineConfig(backend=backend, device=Device.CPU))
        print('  ready:', e.describe())
    except Exception as exc:
        print('  WARNING:', backend.value, '->', exc)
"@

Step "Hardware report"
& $venvPy main.py --hardware

Write-Host "`nSetup complete. Start the app with:  .\.venv\Scripts\python.exe main.py" -ForegroundColor Green
