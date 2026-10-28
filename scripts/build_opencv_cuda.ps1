<#
.SYNOPSIS
    Builds OpenCV 4.10 + contrib with CUDA/cuDNN for the Veil virtualenv.

.DESCRIPTION
    Only needed if you want the YuNet/SFace backend (and OpenCV resize/convert
    ops) on the GPU. The default InsightFace backend runs on the GPU through
    ONNX Runtime and does NOT need a CUDA build of OpenCV.

    Prerequisites (install first):
      * Visual Studio 2022 Build Tools with "Desktop development with C++"
      * CMake >= 3.27         winget install -e --id Kitware.CMake
      * Ninja                 winget install -e --id Ninja-build.Ninja
      * Git                   winget install -e --id Git.Git
      * CUDA Toolkit 12.4 and cuDNN 9.x (see README)

    Run from an "x64 Native Tools Command Prompt for VS 2022" PowerShell
    (or this script calls vcvars64.bat for you). Build time: 45-120 minutes.

.PARAMETER CudaArch
    Compute capability of your GPU: 7.5 (RTX 20xx/T4), 8.6 (RTX 30xx), 8.9 (RTX 40xx), 12.0 (RTX 50xx).
#>
[CmdletBinding()]
param(
    [string]$CudaArch = "8.6",
    [string]$OpenCVVersion = "4.10.0",
    [string]$WorkDir = "C:\opencv-build"
)
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$venvPy = Join-Path $repo ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPy)) { throw "Run scripts\setup_windows.ps1 first (.venv not found)." }
if (-not $env:CUDA_PATH) { throw "CUDA_PATH is not set - install the CUDA Toolkit 12.x first." }

# Load the MSVC x64 environment into this PowerShell session.
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
cmd /c "`"$vsPath\VC\Auxiliary\Build\vcvars64.bat`" && set" | ForEach-Object {
    if ($_ -match "^(.*?)=(.*)$") { Set-Item -Path "env:$($matches[1])" -Value $matches[2] }
}

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
Set-Location $WorkDir
if (-not (Test-Path "opencv")) { git clone --depth 1 --branch $OpenCVVersion https://github.com/opencv/opencv.git }
if (-not (Test-Path "opencv_contrib")) { git clone --depth 1 --branch $OpenCVVersion https://github.com/opencv/opencv_contrib.git }

$pyRoot = & $venvPy -c "import sys; print(sys.base_prefix)"
$pyInclude = & $venvPy -c "import sysconfig; print(sysconfig.get_paths()['include'])"
$pyLib = Join-Path $pyRoot "libs\python311.lib"
$numpyInclude = & $venvPy -c "import numpy; print(numpy.get_include())"
$sitePackages = & $venvPy -c "import sysconfig; print(sysconfig.get_paths()['purelib'])"

$cmakeArgs = @(
    "-S", "opencv", "-B", "build", "-G", "Ninja",
    "-DCMAKE_BUILD_TYPE=Release",
    "-DOPENCV_EXTRA_MODULES_PATH=$WorkDir/opencv_contrib/modules",
    "-DWITH_CUDA=ON", "-DWITH_CUDNN=ON", "-DOPENCV_DNN_CUDA=ON",
    "-DCUDA_ARCH_BIN=$CudaArch", "-DCUDA_ARCH_PTX=",
    "-DCUDA_FAST_MATH=ON", "-DWITH_CUBLAS=ON", "-DENABLE_FAST_MATH=ON",
    "-DWITH_NVCUVID=OFF", "-DWITH_NVCUVENC=OFF",
    "-DBUILD_opencv_world=ON", "-DBUILD_opencv_python3=ON",
    "-DBUILD_TESTS=OFF", "-DBUILD_PERF_TESTS=OFF", "-DBUILD_EXAMPLES=OFF", "-DBUILD_DOCS=OFF",
    "-DWITH_FFMPEG=ON", "-DWITH_MSMF=ON", "-DWITH_DSHOW=ON", "-DWITH_OPENGL=ON",
    "-DPYTHON3_EXECUTABLE=$venvPy",
    "-DPYTHON3_INCLUDE_DIR=$pyInclude",
    "-DPYTHON3_LIBRARY=$pyLib",
    "-DPYTHON3_NUMPY_INCLUDE_DIRS=$numpyInclude",
    "-DPYTHON3_PACKAGES_PATH=$sitePackages",
    "-DOPENCV_SKIP_PYTHON_LOADER=OFF"
)
cmake @cmakeArgs
cmake --build build --config Release --parallel
cmake --install build

# The pip wheel would shadow the CUDA build - remove it.
& $venvPy -m pip uninstall -y opencv-contrib-python opencv-python opencv-python-headless

# Python 3.8+ no longer searches PATH for DLLs; register OpenCV and CUDA bin dirs.
$loaderCfg = Get-ChildItem -Recurse -Filter "config.py" (Join-Path $sitePackages "cv2") | Select-Object -First 1
Add-Content $loaderCfg.FullName "BINARIES_PATHS = [r'$WorkDir\build\install\x64\vc17\bin', r'$env:CUDA_PATH\bin'] + BINARIES_PATHS"

& $venvPy -c "import cv2; print(cv2.__version__, 'CUDA devices:', cv2.cuda.getCudaEnabledDeviceCount())"
Write-Host "OpenCV with CUDA installed into .venv" -ForegroundColor Green
