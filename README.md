# lumo materials 2.0: native Windows PBR material library

<img src="lumo_materials/assets/icons/app-512.png" width="96" alt="lumo logo: the bold lumo wordmark and its line, black on a white tile">

A real Windows program (Qt / PySide6, no browser, no local web server). It has a frameless pure-dark window with its
own minimise, maximise and close buttons, and still snaps, resizes and casts a shadow like any Windows window. It
works fully offline, is free and open source end to end, and is signed with your own publisher.

```
lumo_materials/
  engine/      maps from photos: seamless (periodic FFT / blend / mirror), de-lighting, albedo, normal (OpenGL),
               roughness, metallic, height (16-bit), AO, seam score, 12 material types, adjustments, map-set import,
               CPU thumbnail renderer                                              (numpy + Pillow only)
  library/     the library on disk (same layout as before), trash, drafts, export ZIP / folder, settings
  jobs.py      the editor's background jobs (preview, save, import, adjust)        (no Qt)
  viewmodel.py pager, grid and filter logic                                        (no Qt)
  ui/          the program: frameless window, sidebar, card grid + pager, inspector, editor, trash, drafts,
               settings, dialogs, Direct3D 12 PBR viewer (Qt RHI) with Direct3D 11 / OpenGL / CPU fallbacks
  shaders/     GLSL 440 sources, compiled to .qsb (HLSL for Direct3D, SPIR-V, GLSL) at build time
  assets/      Inter font, icons, licence texts
packaging/     PyInstaller spec, Inno Setup script, wizard images, build.ps1, make_icons.py (renders the logo)
tests/         63 unit tests (engine, library, jobs, UI logic, meshes, preview framing)
.github/       GitHub Actions: tests, UI smoke tests, build, install test, release
```

## Build on GitHub (no Windows PC needed)

Every push to the `lumo-materials` branch runs `.github/workflows/lumo-materials.yml` on a clean Windows
machine:

1. unit tests
2. UI smoke test from source: every page is driven with sample materials and screenshots are saved
3. shaders compiled
4. program and installer built with the VC++ runtime embedded
5. the built .exe smoke-tested again
6. silent per-user install, `--check` and uninstall
7. a pre-release `lumo-materials-v<version>-build.<n>` with the setup and its SHA-256 is published

The test output, screenshots and logs of every run are force-pushed to the `lumo-materials-ci` branch.

The build is signed only if two repository secrets exist:

- `LUMO_PUBLISHER_B64`: base64 of a zip of your `lumo-publisher\publisher` folder
- `LUMO_SIGN_PASSWORD`: its password

Without them the installer is unsigned. Adding them means your signing key leaves your PC. Signing locally
with `build.ps1` avoids that.

## Build the installer (on Windows, one command)

Free tools needed once:

```powershell
winget install Python.Python.3.12
winget install JRSoftware.InnoSetup
```

Create your publisher once with `lumo-publisher\New-LumoPublisher.ps1` (see its README), keeping the two folders
side by side:

```
<anywhere>\lumo-publisher\      New-LumoPublisher.ps1, Sign-Lumo.ps1, Install-LumoTrust.ps1, publisher\
<anywhere>\lumo-materials\      this project
```

Then in `lumo-materials`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File packaging\build.ps1
```

The script creates `.venv-build`, installs the pinned packages, runs the tests, builds `dist\lumo-materials\` with
PyInstaller, self-checks it (`lumo-materials.exe --check`), signs the program, builds
`dist\lumo-materials-setup-2.0.0.exe` with Inno Setup (the setup and the uninstaller are signed too), verifies the
signatures and writes the SHA-256 next to the setup.
Options: `-NoSign`, `-SkipTests`, `-NoInstaller`, `-Clean`, `-PublisherDir PATH`, `-Python PATH`.
Internet is needed only for the `pip install` step. After that, building and the program itself are offline.

## The installer

- Installs **per user by default** (`%LOCALAPPDATA%\Programs\lumo materials`, no administrator rights). The first page
  offers "Install for all users" instead.
- Start menu entry, optional desktop shortcut, and an "Apps & features" entry with your publisher name.
- Optional, off by default: **Trust the publisher on this PC**. It runs `Install-LumoTrust.ps1`, which only accepts a
  code-signing-only root. The uninstaller removes this trust again.
- After installing, it runs the self-check and reports a problem if there is one.
- Uninstall removes the program only. It asks whether to remove the settings, drafts and logs as well (default No).
  **It never removes the material library**, and it keeps the data folder if the library is inside it.
- A running lumo materials is closed through the Windows Restart Manager before files are replaced.

Settings stay in `%LOCALAPPDATA%\lumo-materials\data`, the same folder version 1 used, so the chosen library folder
carries over. Uninstall version 1 (`lumo-materials.exe --uninstall`) before or after installing 2.0. Its uninstaller
does not touch the library either.

## Run from source (any OS)

```
pip install -r requirements.txt
python -m lumo_materials             # the program
python -m lumo_materials --check     # headless self-check
python -m unittest discover -s tests
```

## What the program does

| Area | Features |
|---|---|
| Library | card grid with a card-size slider (or Ctrl + wheel; columns follow the window width, cards centred) or list; lit-sphere or flat thumbnails that fill the card; skeleton cards while thumbnails load, steady thumbnails at every card size; folder colours per category (right-click a category); pager (12 / 24 / 48 / 96 per page), search over name / tags / description (`/` or Ctrl F), category pills, favourites, sort by date / name / category / resolution, multi-select with Move, Tag, Favourite, Export and Trash, trash with Undo, Rescan (F5) |
| Inspector | switching shows the new material at once (its thumbnail and a skeleton, never the previous one), loads a fast 1024 px preview, and keeps the last 10 plus the neighbours in the grid preloaded; Direct3D 12 3D preview (GGX PBR, parallax occlusion from the height map, studio reflections, 4x MSAA; sphere / plane / both, orbit, zoom, spin), the six maps (click one to view it alone), fill-bar rows for tiling, displacement, light (Studio, Softbox, Window, Overcast, Dramatic) and background, details, Adjust and Export |
| Repeated images | every saved material keeps fingerprints of its photo or map files (SHA-256 and a 64-bit difference hash). Opening a photo or map set that is already in the library — the same file under any name, or the same picture re-saved or resized — shows a notice with *Show* and asks before saving a second copy. Materials from older versions are fingerprinted once in the background |
| New from photo | drop a photo anywhere or press Ctrl N; tile size of the preview; type preset guessed from the file name; seamless mode, de-lighting, height, normal, roughness, metallic and AO sliders with a live preview and a seam score; saves at 512 to 4096 px; name, category (pick or create) and tags (type and press Enter or comma) in the save form |
| Import map set | up to 24 files, roles guessed from file names (`_Color`, `_NormalGL/DX`, `_Rough`, `_Metal`, `_Displacement`, `_AO`, `_ORM`, `_Gloss`…), DirectX normals flipped, missing maps generated, then adjusted |
| Adjust maps | per-map controls (exposure, contrast, saturation, hue, normal strength / smoothing / flip, roughness, metallic, height, AO, output size). Always absolute and applied to the untouched originals; save as Replace or as a copy |
| Drafts | leaving work you changed asks *Keep as draft / Discard* (no prompt when nothing changed); drafts reopen exactly where you left them |
| Export | ZIP or folder (never overwrites), OpenGL / DirectX normals, plain or engine names, packed ORM, 8- or 16-bit height |
| Controls | sliders and choice rows ignore the mouse wheel, so scrolling a panel never changes a value; rounded menus and drop-downs |
| Motion | sliding switches, card hover easing, thumbnails and previews that fade in, page cross-fades, toasts and dialogs that ease in (Settings > Animations turns it all off) |
| Settings | accent colour, card thumbnails, tags on cards, animations, splash, window at start, materials per page, sort, trash confirmation, repeated-image warning, default type / seamless mode / output size, preview resolution, generate missing maps, PNG compression, renderer, preview shape / light / background / spin, editor tile size, export defaults, reset |
| Window | splash screen with the bold *lumo* wordmark and its light line while the library opens; frameless dark window with custom caption buttons, Aero Snap, Win+Arrow, edge resizing, Windows 11 rounded corners, single instance (opening a second copy hands its files to the first) |

## Tested

- **Unit tests:** 63 tests pass on Linux and on Windows (GitHub Actions). They cover the engine, the library (incl.
  Explorer renames / copies, trash, adjusted originals, export), the editor's save and adjust jobs, the pager / grid
  logic, the meshes, the preview camera framing, repeated-image detection (same file, re-saved / resized copy,
  plain pictures that must not match, older materials), folder colours and the flat previews.
- **The real program on Windows:** every CI run drives the interface from source and from the built .exe. That
  covers the library, inspector, list view, search, multi-select, new from photo + save, import + save, adjust + save
  as copy, the repeated-photo notice, drafts, trash with undo, every settings section and a live accent change,
  flat thumbnails, the card size across its whole range (thumbnails must not reload), menus, dialogs, maximise
  and narrow window. It fails on any exception or Qt
  critical message. The 3D preview ran on **Direct3D 12** with no errors or warnings (on GitHub's software D3D12
  adapter, as those machines have no GPU).
- **Speed (2-core CI-class machine, 2048 px photo):** saving takes about 2.8 s instead of 7.0 s (map generation
  1.5 s instead of 3.2 s with one shared FFT spectrum and parallel channels; PNG writing 0.4 s instead of 2.0 s;
  previews 0.45 s instead of 1.4 s). Loading a material for the preview takes 0.3 s instead of 1.0 s, and a cached
  or preloaded one skips loading entirely.
- **The installer:** a silent per-user install, the self-check of the installed program, the Start menu shortcut and
  a clean uninstall are checked on every run.
- **Not covered by CI:** a real NVIDIA GPU (the same Direct3D 12 code path, in hardware), the "install for all users"
  mode, the publisher-trust option, and the VC++ runtime install on a PC that lacks it (the CI machine already has it).
- Map generation from a single photo is a heuristic: height, normal and AO come from brightness, and metallic cannot
  be measured from a photo. Import scanned maps when you need exact values.
