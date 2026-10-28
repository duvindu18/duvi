# Veil: real-time face anonymization for Windows

Veil detects, tracks and recognises faces in webcam, RTSP and video-file
sources, then blurs, pixelates, boxes or masks them according to a policy you
choose:

| Policy | What gets hidden |
| --- | --- |
| **Everyone** | every detected face |
| **Strangers** *(Option A)* | faces that are not in your identity folder |
| **Targets only** *(Option A)* | only identities marked **Hide** |
| **All but whitelist** *(Option B)* | everyone except identities marked **Visible** |
| **Off** | nothing (detection and recognition only) |

Styles: **Gaussian blur**, **pixelation**, **black box** and **custom PNG
mask**, each with an elliptical or rectangular shape, feathered edges and
adjustable strength and coverage.

The UI follows the warm "ember" glass design of the reference mock-ups and is
adapted for desktop: a navigation rail instead of the tab bar, a resizable
video stage with floating transport controls, and an inspector panel that turns
into a slide-over drawer on narrow windows.

---

## 0. Install with VeilSetup.exe (recommended)

`VeilSetup-<version>.exe` is a single self-contained installer. It needs no
Python, CUDA Toolkit, compiler or command line.

1. Run `VeilSetup-1.0.0.exe` and accept the UAC prompt. The app installs to
   `C:\Program Files\Veil`.
2. On **Choose Components** (the installation menu), setup detects your
   graphics card and pre-selects the matching type:

   | Setup type | Inference runtime | Download during setup |
   | --- | --- | --- |
   | NVIDIA GPU: CUDA | ONNX Runtime GPU + CUDA 12 / cuDNN 9 libraries (pip wheels, no CUDA Toolkit) | ~1.3 GB |
   | NVIDIA GPU: CUDA + TensorRT | as above + TensorRT 10.2 | ~2.3 GB |
   | AMD / Intel / other GPU | DirectML (bundled) | models only |
   | Intel CPU / iGPU / NPU | OpenVINO | ~70 MB |
   | CPU only | bundled, works offline | models only |

   Individual checkboxes: face models (buffalo_l accurate, buffalo_s fast,
   YuNet/SFace fallback), the Microsoft Visual C++ runtime (installed only if
   missing), Start-menu and desktop shortcuts, and the `veil` CLI on `PATH`.
   Exactly one runtime can be selected. Choosing TensorRT selects CUDA too.
3. The progress page streams each step. Everything is also written to
   `C:\Program Files\Veil\install.log`.

If an optional download fails (no internet, NVIDIA sign-in wall), setup falls
back to the next working runtime, finishes with a warning and the app still
works. Run the same setup again to add components, change the runtime or
repair the install. Uninstall from *Settings → Apps* or the Start menu.
Identity photos in `Documents\Veil\Faces` are never deleted.

The only prerequisite for CUDA is an **NVIDIA driver ≥ 551.61**. Setup warns
if it is missing.

Unattended install (IT deployment):

```powershell
VeilSetup-1.0.0.exe /S /ACCEL=cuda          # cuda | tensorrt | directml | openvino | cpu
VeilSetup-1.0.0.exe /S /ACCEL=cpu /D=D:\Apps\Veil
"C:\Program Files\Veil\Uninstall.exe" /S
```

### Building the installer

```bash
# Linux (cross-compile) or Windows, Python 3.11 + internet access
sudo apt install nsis            # Windows: winget install -e --id NSIS.NSIS
pip install -r requirements-dev.txt
python installer/build_installer.py --version 1.0.0
# -> dist/VeilSetup-1.0.0.exe (+ .sha256)
```

The build stages the official Python 3.11.9 x64 runtime (NuGet), the app, an
offline wheelhouse (Qt, OpenCV, NumPy, SciPy, ONNX Runtime CPU + DirectML),
component lists, the `Veil.exe` launcher and the ember-theme installer artwork,
then compiles `installer/veil.nsi`. The `Build Windows installer` GitHub
Actions workflow does the same on every `v*` tag and uploads the exe as an
artifact.

| File | Role |
| --- | --- |
| `installer/veil.nsi` | NSIS installer: pages, setup types, components menu, GPU detection, uninstaller |
| `installer/launcher.nsi` | `Veil.exe`, which starts the app on the private Python with the app icon |
| `installer/provision.py` | runs during setup: VC++ runtime, offline/online packages, models, verification, PATH |
| `installer/requirements/*.txt` | pinned package sets per component |
| `installer/build_installer.py` | stages everything and runs `makensis` |

---

## 1. System architecture

```
┌──────────────────────────────── GUI thread (PySide6) ───────────────────────────────┐
│  MainWindow ─ NavRail ─ LivePage · IdentitiesPage · ExportPage · SettingsPage        │
│        ▲ frameReady (coalesced)    ▲ stats / status / warnings / errors (queued)     │
│        │                           │                                                 │
│  PipelineController (Qt bridge: latest-frame mailbox, signals, start/stop/record)    │
└────────┼───────────────────────────┼─────────────────────────────────────────────────┘
         │                           │ plain callbacks (thread-safe)
┌────────┴───────────────────────────┴──────── app/core (Qt-free) ───────────────────────┐
│                                                                                         │
│  Capture ──q_in──▶ Inference ─────────────────────q_render──▶ Render ──▶ QImage mailbox │
│  thread    (3/16)  thread                          (2, drop    thread                   │
│                    detect → ByteTrack → recognise   oldest)    scale + QPainter overlay │
│                    → policy → anonymize                                                 │
│                           │                                                             │
│                           └──writer.q (64)──▶ Writer thread ──▶ MP4 / AVI / MKV         │
│                                                                                         │
│  Supervisor thread: starts the workers, joins them, finalises the writer, reports       │
│  the outcome (completed / stopped / error) exactly once.                                │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

### Module map

```
main.py                     CLI entry: GUI (default), --headless export, --hardware report
app/
├── core/                   processing engine, importable without Qt
│   ├── config.py           typed dataclass config (JSON in %APPDATA%\Veil)
│   ├── hardware.py         ONNX Runtime provider discovery + fallback chain
│   ├── models.py           model download with retries / size checks
│   ├── engine.py           SCRFD+ArcFace and YuNet+SFace backends; device fallback / OOM recovery
│   ├── scrfd_arcface.py    native SCRFD / ArcFace inference on ONNX Runtime (no insightface package)
│   ├── tracker.py          ByteTrack (Kalman + two-stage IoU association)
│   ├── face_db.py          identity folder, embedding cache, cosine matching
│   ├── anonymizer.py       policy decision + Gaussian / pixelate / box / mask rendering
│   ├── sources.py          webcam / RTSP / file capture worker, reconnects, corrupt-frame skipping
│   ├── writer.py           background encoder, codec fallback, disk-space guard
│   └── pipeline.py         thread orchestration, recognition scheduling, stats
├── gui/
│   ├── theme.py            Ember palette, QSS, fonts
│   ├── widgets.py          glass cards, pills, circle buttons, glass slider, video view, flow layout
│   ├── icons.py            QPainter vector icons + app icon
│   ├── bridge.py           PipelineController + overlay painter
│   ├── context.py          shared config / face DB, debounced saving
│   ├── tasks.py            QThreadPool helper for blocking jobs
│   ├── winstyle.py         Windows 11 DWM dark/ember title bar, taskbar identity
│   ├── main_window.py
│   └── pages/              live, identities, export, settings
└── utils/                  paths, logging, errors, Unicode-safe image I/O, rate meters
tests/                      unit + pipeline + offscreen GUI tests (run without models)
installer/                  VeilSetup.exe build (NSIS script, launcher, provisioning, pinned component lists)
scripts/                    setup_windows.ps1, build_opencv_cuda.ps1, run.ps1
faces/                      your identity photos (git-ignored)
```

### Thread design

| Thread | Owns | Input → output | Back-pressure policy |
| --- | --- | --- | --- |
| **GUI** | widgets | signals → paint | never blocks; frames coalesced to the latest one |
| **Capture** | `cv2.VideoCapture` | device → `q_in` | live: **drop-oldest** (bounded latency); export: **blocking** (no frame lost) |
| **Inference** | `FaceEngine`, `ByteTracker`, `Anonymizer` | `q_in` → `q_render`, `writer.q` | the only stage that does heavy work; ONNX Runtime and OpenCV release the GIL |
| **Render** | overlay painter | `q_render` → QImage mailbox | drop-oldest; pre-scales to the view's device-pixel size so the GUI thread only blits |
| **Writer** | `cv2.VideoWriter` | `writer.q` → disk | export: blocking; live recording: drops when the encoder lags |
| **Supervisor** | lifecycle | – | `stop()` never blocks the caller, so a stalled RTSP read can't freeze the UI |
| **Pool** (`QThreadPool`) | – | model loading, re-indexing, webcam probing, hardware probe | – |

Recognition is scheduled per track instead of per frame. Unidentified tracks
are retried every *N* frames, identified ones are re-verified rarely, and at
most *K* faces are embedded per frame. Identity is decided by majority vote
over a sliding window, so a single bad match cannot un-blur someone.
Privacy-safe start (*fail closed*) hides every new or unconfirmed face until
recognition has decided, and **Hold after loss** keeps blurring a face for a
few frames after the detector loses it to avoid one-frame "flashes".

### Error handling

| Situation | Behaviour |
| --- | --- |
| Webcam missing / busy / blocked by privacy settings | tries DirectShow → MSMF → ANY, then a clear message naming the likely cause |
| Webcam unplugged while running | up to 3 re-open attempts, then a clean stop with an error |
| RTSP unreachable / drops | TCP transport, 8 s open / 5 s read timeouts, 8 reconnects with exponential back-off (1–16 s); credentials are redacted in UI and logs |
| Corrupted video frames | skipped (up to 120), reported as a warning, export continues |
| Unreadable / unsupported file | `CorruptVideoError` before any processing starts |
| **CUDA / TensorRT out of memory** | detected from the runtime error text; the engine is rebuilt on the next device of the chain (TensorRT → CUDA → DirectML → OpenVINO → CPU) and the frame is retried; the UI shows a warning and keeps running |
| InsightFace not installable / model download fails | automatic fallback to OpenCV YuNet + SFace |
| Codec unavailable | per-container codec fallback (`mp4v`/`avc1`, `XVID`/`MJPG`) |
| Disk almost full | recording stops with a message before the file gets corrupted |
| Unexpected exception | logged to `%APPDATA%\Veil\logs\veil.log`, shown in a dialog, pipeline stopped cleanly |

---

## 2. Developer setup from source (PowerShell)

End users don't need this section. Use VeilSetup.exe (section 0).

Tested target: **Windows 11 23H2/24H2 x64, Python 3.11**. Windows 10 22H2
works too, but the ember-tinted title bar needs Windows 11.

### 2.1 Base tools

```powershell
winget install -e --id Python.Python.3.11
winget install -e --id Git.Git
```

Open a **new** PowerShell window afterwards so `py` and `git` are on `PATH`.
No C++ compiler is needed: the InsightFace models run through Veil's own
SCRFD/ArcFace implementation, not the `insightface` package.

### 2.2 NVIDIA CUDA / cuDNN (skip for DirectML / OpenVINO / CPU)

`onnxruntime-gpu==1.19.2` needs **CUDA 12.x** and **cuDNN 9.x**. TensorRT
**10.x** is optional and roughly doubles throughput on RTX cards.

1. Update the NVIDIA driver to **≥ 551.61** (GeForce/Studio or the data-center driver).
   Check with `nvidia-smi`.
2. Install **CUDA Toolkit 12.4**:
   ```powershell
   winget install -e --id Nvidia.CUDA --version 12.4
   ```
   (or download *cuda_12.4.1_551.78_windows.exe* from developer.nvidia.com/cuda-downloads.)
   The installer sets `CUDA_PATH`.
3. Install **cuDNN 9.x for CUDA 12**: download the Windows *zip* from
   developer.nvidia.com/cudnn, extract it to `C:\Program Files\NVIDIA\CUDNN\v9`, then:
   ```powershell
   [Environment]::SetEnvironmentVariable("CUDNN_PATH", "C:\Program Files\NVIDIA\CUDNN\v9", "User")
   $p = [Environment]::GetEnvironmentVariable("Path", "User")
   [Environment]::SetEnvironmentVariable("Path", "$p;C:\Program Files\NVIDIA\CUDNN\v9\bin\12.6;C:\Program Files\NVIDIA\CUDNN\v9\bin", "User")
   ```
   (The cuDNN 9 *exe* installer puts DLLs in `bin\12.x`; the zip puts them in `bin`. Both are listed above.)
4. *(Optional)* **TensorRT 10.4 GA** for CUDA 12: extract the zip to `C:\TensorRT-10.4`, then:
   ```powershell
   [Environment]::SetEnvironmentVariable("TENSORRT_PATH", "C:\TensorRT-10.4", "User")
   $p = [Environment]::GetEnvironmentVariable("Path", "User")
   [Environment]::SetEnvironmentVariable("Path", "$p;C:\TensorRT-10.4\lib", "User")
   ```
   The first TensorRT start compiles engines (1–3 min). They are cached in
   `%LOCALAPPDATA%\Veil\trt_engines`, so later starts are instant.
5. Open a new terminal and verify:
   ```powershell
   nvidia-smi
   Get-Command cudnn64_9.dll, cublas64_12.dll | Select-Object Source
   ```

### 2.3 Project environment

Automated (recommended):

```powershell
git clone https://github.com/duvindu18/duvi.git veil
cd veil
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\scripts\setup_windows.ps1 -Accelerator cuda      # or: directml | openvino | cpu
```

Manual equivalent:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip==24.2
pip install -r requirements.txt
# Without a CUDA Toolkit install, the CUDA 12 / cuDNN 9 libraries can come from PyPI:
pip install -r installer\requirements\cuda.txt
python main.py --hardware
```

For a non-NVIDIA GPU, replace the ONNX Runtime package (only one flavour can
be installed at a time):

```powershell
pip uninstall -y onnxruntime-gpu
pip install onnxruntime-directml==1.19.2      # AMD / Intel Arc / any DX12 GPU
# or: pip install onnxruntime-openvino==1.19.0  (Intel CPU/iGPU/NPU)
# or: pip install onnxruntime==1.19.2           (CPU only)
```

`python main.py --hardware` should list `TensorrtExecutionProvider`,
`CUDAExecutionProvider` (or `DmlExecutionProvider` / `OpenVINOExecutionProvider`).

### 2.4 OpenCV with CUDA (optional)

The default **InsightFace** backend already runs on the GPU through ONNX
Runtime, so the pip OpenCV wheel is enough. You only need a CUDA build of
OpenCV to run the lightweight **YuNet + SFace** backend on the GPU.
`scripts\build_opencv_cuda.ps1` automates it:

```powershell
winget install -e --id Kitware.CMake
winget install -e --id Ninja-build.Ninja
.\scripts\build_opencv_cuda.ps1 -CudaArch 8.6   # 7.5 RTX20 · 8.6 RTX30 · 8.9 RTX40 · 12.0 RTX50
```

The script loads the MSVC x64 environment, clones `opencv` and
`opencv_contrib` 4.10.0, and configures them with:

```
-DWITH_CUDA=ON -DWITH_CUDNN=ON -DOPENCV_DNN_CUDA=ON -DCUDA_ARCH_BIN=<arch>
-DCUDA_FAST_MATH=ON -DWITH_CUBLAS=ON -DBUILD_opencv_world=ON -DBUILD_opencv_python3=ON
-DOPENCV_EXTRA_MODULES_PATH=opencv_contrib/modules -DPYTHON3_EXECUTABLE=.venv\Scripts\python.exe
```

It then builds with Ninja (45–120 min), installs into the venv, removes the pip
OpenCV wheels that would shadow the build, and registers the OpenCV and CUDA
`bin` folders in `cv2\config.py`. Python 3.8 and later ignore `PATH` when
loading extension DLLs, so this registration is required. Verify with:

```powershell
python -c "import cv2; print(cv2.cuda.getCudaEnabledDeviceCount())"
```

---

## 3. Running

```powershell
.\scripts\run.ps1                 # GUI (adds CUDA/cuDNN/TensorRT dirs to PATH for this process)
python main.py                    # GUI, if the venv is active and PATH is already set
```

### GUI workflow

1. **Identities** (`Ctrl+2`): click *Add person* and pick 3–10 photos, or
   *Import folder*. Mark each person **Visible** (whitelist), **Neutral** or
   **Hide** (target). You can also enroll the largest face straight from the
   live view with the *enroll* button.
2. **Live** (`Ctrl+1`): choose *Webcam*, *RTSP stream* or *Video file* and
   press ▶ (`Space`). Pick a policy and style in the inspector. Changes apply
   instantly while running. Use ● (`Ctrl+R`) to record the anonymized stream,
   📷 (`Ctrl+S`) for a snapshot, ■ (`Esc`) to stop.
3. **Export** (`Ctrl+3`): queue files (or drag and drop them) and press ▶.
   Every frame is processed with the current Live settings. Overlays are never
   burned in.
4. **Settings** (`Ctrl+4`): backend, accelerator, VRAM cap, detector size,
   tracking and recognition scheduling, and the hardware report.

### Headless / batch

```powershell
# Anonymize a file at full speed (every frame), whitelist two people:
python main.py --headless -i "D:\clips\lobby.mp4" -o "D:\out\lobby_anon.mp4" `
    --policy whitelist --whitelist Alice Bob --style pixelate --intensity 80

# Record an anonymized RTSP stream until Ctrl+C:
python main.py --headless -i "rtsp://user:pass@10.0.0.20:554/stream1" -o cam.mp4 --policy all

# Force a device / backend:
python main.py --headless -i in.mkv -o out.mkv --device directml --backend yunet
```

Exit codes: `0` success, `1` processing error, `2` bad arguments.

### Tests

```powershell
pip install -r requirements-dev.txt
python -m pytest -q
```

The suite uses a synthetic face engine, so it runs on any machine without
models or a GPU. It covers the tracker, the anonymizer policies and styles,
the face DB cache, threaded export end to end, missing-source errors, and an
offscreen GUI smoke test.

### Packaging

See section 0, *Building the installer*. NVIDIA libraries are never bundled
in the exe. They are downloaded from PyPI or NVIDIA during setup, only when
you select them.

---

## 4. Detection defaults and performance tuning

The defaults favour **recall**: a missed face is a privacy leak, while a
false positive only blurs a patch of background.

* **Detector input: Auto.** 960 px on GPUs (finds faces down to about 10 px
  in 1080p) and 640 px on CPU. Confidence is 0.35, low-score recovery 0.15 and
  the minimum face size 10 px.
* **Tracks start immediately** (`Confirm after 1 hit`). Faces that are not yet
  identified are hidden (*privacy-safe start*), and a face stays hidden for 8
  frames after the detector briefly loses it.
* **Full-face coverage.** The anonymized region always contains the *entire*
  detected face box. The ellipse is scaled by √2, because an inscribed ellipse
  only reaches the box corners at that size. Margin is added for soft edges
  and coverage, and the region extends upward over the forehead and hairline.
  Faces cut by the frame border keep their full mask shape. A unit test checks
  this pixel by pixel for every shape and edge setting.


| Knob | Where | Effect |
| --- | --- | --- |
| Accelerator → TensorRT + FP16 | Settings | fastest on RTX (≈2× CUDA) |
| Model pack `buffalo_s` | Settings | ~3× faster than `buffalo_l`, slightly less accurate |
| Detector input 320/640 | Settings | big speed-up; misses very small / distant faces |
| Max faces per frame | Settings → Recognition | caps recognition cost in crowds |
| Retry / re-verify intervals | Settings → Recognition | fewer embeddings per second |
| VRAM limit | Settings | leave memory for games/other apps; OOM still falls back gracefully |

Throughput depends heavily on GPU, resolution and face count. Check the
*Performance* card in the Live inspector, which shows capture/inference fps,
latency and dropped frames as they happen, then tune the knobs above.

## 5. Privacy notes

* Identity photos stay local in `faces/` and the cache lives in `%LOCALAPPDATA%\Veil`.
  Nothing is uploaded. Only the model files are downloaded on first run.
* Snapshots and recordings are taken from the **anonymized** frame. The original
  frame is used only in memory, for enrolment.
* Check the consent and data-protection rules that apply to you (for example
  GDPR Art. 9 for biometric data) before you recognise identifiable people.
