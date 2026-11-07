# lumo materials 2.0: native Windows PBR material library

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
               settings, dialogs, OpenGL 3.3 PBR viewer with automatic CPU fallback
  assets/      Inter font, icons, licence texts
packaging/     PyInstaller spec, Inno Setup script, wizard images, build.ps1
tests/         53 unit tests (engine, library, jobs, UI logic, meshes)
```

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
| Library | card grid (columns follow the window width) or list, pager (12 / 24 / 48 / 96 per page), search over name / tags / description (`/` or Ctrl F), category pills, favourites, sort by date / name / category / resolution, multi-select with Move, Tag, Favourite, Export and Trash, trash with Undo, Rescan (F5) |
| Inspector | GPU 3D preview (sphere / plane / both, orbit, zoom, spin), the six maps (click one to view it alone), fill-bar rows for tiling, displacement, light (Studio, Softbox, Window, Overcast, Dramatic) and background, details, Adjust and Export |
| New from photo | drop a photo anywhere or press Ctrl N; type preset guessed from the file name; seamless mode, de-lighting, height, normal, roughness, metallic and AO sliders with a live preview and a seam score; saves at 512 to 4096 px |
| Import map set | up to 24 files, roles guessed from file names (`_Color`, `_NormalGL/DX`, `_Rough`, `_Metal`, `_Displacement`, `_AO`, `_ORM`, `_Gloss`…), DirectX normals flipped, missing maps generated, then adjusted |
| Adjust maps | per-map controls (exposure, contrast, saturation, hue, normal strength / smoothing / flip, roughness, metallic, height, AO, output size). Always absolute and applied to the untouched originals; save as Replace or as a copy |
| Drafts | leaving unsaved work asks *Keep as draft / Discard*; drafts reopen exactly where you left them |
| Export | ZIP or folder (never overwrites), OpenGL / DirectX normals, plain or engine names, packed ORM, 8- or 16-bit height |
| Window | frameless dark window with custom caption buttons, Aero Snap, Win+Arrow, edge resizing, Windows 11 rounded corners, single instance (opening a second copy hands its files to the first) |

## Tested and not tested

- **Tested here** (Linux, Python 3.13): `python -m unittest discover -s tests` passes all 53 tests. They cover the
  engine (seamless quality, OpenGL normal convention, de-lighting, every preset, adjustments, import guessing and
  assembly, 16-bit PNG, rendering), the library (layout, Explorer renames / copies / loose folders, trash, categories,
  adjusted originals, export), the editor's save and adjust jobs end to end, and the pager, grid and mesh logic.
  `--check` passes. Ruff finds no errors.
- **Not run yet:** the Qt interface, the OpenGL viewer, the frameless-window code, PyInstaller, Inno Setup and
  `build.ps1`. No Qt and no Windows were available where this was written. The first `build.ps1` run on your PC is
  their first real test. If something fails, the build output or
  `%LOCALAPPDATA%\lumo-materials\logs\lumo-materials.log` shows where.
- Map generation from a single photo is a heuristic, as before: height, normal and AO come from brightness, and metallic
  cannot be measured from a photo. Import scanned maps when you need exact values.
