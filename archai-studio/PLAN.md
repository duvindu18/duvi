# ArchAI Studio: Plan

Status: **approved**. Publisher: Seedform. Licence: proprietary (so no SignPath workflow; see section 9).

ArchAI Studio is a Windows 11 desktop app for architectural practice. It runs
offline and talks only to AI services on your own PC: Ollama for text and code,
ComfyUI for images. It never uploads anything.

---

> **Change (owner's request, after M5):** setup can now download and install what's needed
> (Ollama, gpt-oss:20b, nomic-embed-text, ComfyUI portable, SDXL, SDXL Canny ControlNet and,
> optionally, Flux.1 schnell). It runs only when you tick items and click Download, uses only the
> official sources (GitHub releases, Hugging Face, Ollama), and checks every file's SHA-256. The
> app stays offline otherwise. Programs are installed only by the Setup.exe build, never the Store build.

## 1. Where the code goes

This git repository already holds another project (Veil, a Python and Android
app) with its own `README.md`, `.gitignore` and GitHub workflow. To keep the two
apart, ArchAI Studio lives in its own folder:

```
duvi/
├── android/ app/ installer/ ...   ← Veil (left alone)
└── archai-studio/                 ← everything for this project
```

All commands below run inside `archai-studio/`. Its GitHub workflow only runs
when files in `archai-studio/` change, so it won't interfere with Veil's builds.

## 2. Skills available in this session

| Needed for | Skill | Status |
|---|---|---|
| UI, icon, splash, installer art | `frontend-design` | installed |
| The 4 bundled starter skills | `skill-creator` | installed |
| Report export (.docx) | `docx` | installed |
| Report export (.pdf) | `pdf` | installed |
| Area schedule (.xlsx) | `xlsx` | installed |
| Extra design checks | `design:accessibility-review`, `design:ux-copy` | installed |

**Nothing is missing, so nothing needs installing.** I'll use
`accessibility-review` to check contrast and keyboard use on the dark theme, and
`ux-copy` for the wizard's plain-language fix messages.

## 3. What can and cannot be tested from here

I'm working in a Linux cloud machine, not on your PC. So:

- **Can do here:** write all the code, lint, typecheck, unit tests, and
  Playwright end-to-end tests of the real Electron app on a virtual screen. The
  tests use small **fake Ollama and ComfyUI servers** that I write, so they run
  without a GPU or models.
- **Builds the Windows installers:** a GitHub Actions job on a free
  Windows runner builds `Setup.exe` and the `.msix` on each milestone and
  attaches them as downloads. MSIX packaging only runs on Windows.
- **Only you can do, on your PC:** test with your real RTX 5080, Ollama and
  ComfyUI; install and uninstall on a fresh Windows 11 machine; turn Wi-Fi off
  and try everything; run the Windows App Certification Kit (WACK). For each
  milestone I'll write a short checklist (`VERIFY.md`) of what to click and what
  you should see.

## 4. Architecture in plain language

An Electron app has two halves:

1. **Main process** (Node.js, "the back office"). It has full access to your
   PC. It opens the database, reads and writes files, and is the **only** part
   that talks to Ollama, ComfyUI and (when you click) GitHub.
2. **Renderer** (React, "the shop window"). This is the screen you see. It is
   locked down: no file access and no network. It can only ask the main
   process for things through a short, fixed list of requests (the **IPC
   allow-list**, section 6). Every request is checked before anything runs.

A **preload** script sits between them and exposes only that allow-list, typed
in TypeScript so a mistake shows up when the code is compiled, not on your
machine.

```
┌───────────────────────────── ArchAI Studio ──────────────────────────────┐
│  Renderer (React, sandboxed, no Node, no network)                        │
│    Wizard · Chat · Script Studio · Visual Studio · Skills · Docs · Settings│
│                    │ window.archai.* (typed, allow-listed)               │
│  Preload  ─────────┘                                                     │
│                    │ ipcRenderer.invoke / events, every payload checked  │
│  Main process (Node)                                                     │
│    ├─ ollama.ts     → http://127.0.0.1:11434  (chat, tags, embeddings)   │
│    ├─ comfy.ts      → http://127.0.0.1:8188   (prompt, ws, view, free)   │
│    ├─ db.ts         → SQLite file in your data folder                    │
│    ├─ skills.ts     → skills folder; GitHub only on button click         │
│    ├─ net-guard.ts  → refuses any host not on the list                   │
│    └─ export.ts     → .docx / .pdf / .xlsx                               │
└──────────────────────────────────────────────────────────────────────────┘
```

### Security choices

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  `webSecurity: true`. Navigation and new windows blocked. Devtools only in dev
  builds.
- **One network guard in the main process.** Every outgoing request goes
  through `net-guard.ts`, which allows only:
  - loopback addresses (`127.0.0.1`, `localhost`, `::1`) on the ports set in
    Settings;
  - `github.com`, `api.github.com`, `codeload.github.com`, and only while a
    "Import from GitHub" or "Check for updates" click is in progress.
  Any other host is refused and logged on your PC. There is no telemetry, crash
  reporting or analytics library at all.
- **Content-Security-Policy, stricter than you asked.** You asked for a CSP that
  only allows 127.0.0.1. I propose the renderer gets **no network at all**
  (`connect-src 'self'`). Everything goes through the main process, and generated
  images are shown via a private `archai-img://` scheme. A bug in the screen code
  can't reach anything, and the loopback-only rule is enforced in one place.
  Full policy:
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob: archai-img:; font-src 'self'; connect-src 'self';
  worker-src 'self' blob:; object-src 'none'; frame-src 'none';
  base-uri 'none'; form-action 'none'`
  (`'unsafe-inline'` styles and `blob:` workers are what Monaco needs. No
  inline scripts.)
- **Monaco, fonts and icons are bundled** in the app, with no CDN.
- **Payload checks:** every IPC request is validated with `zod` schemas from
  `src/shared/ipc.ts`.

### GPU memory: an important detail

gpt-oss:20b takes about 13–14 GB of your 16 GB VRAM. SDXL in ComfyUI needs
7–10 GB. **They don't fit at the same time.** If both stay loaded, Windows
spills into system RAM and everything slows down a lot. So the app takes turns:

- Before an image job starts, it tells Ollama to unload the model
  (`keep_alive: 0`). The Prompt helper runs first, then the model is unloaded,
  then the render starts.
- Before a chat after image work, it calls ComfyUI's `POST /free` to release
  VRAM.
- A small "GPU: Chat / Images" indicator shows which one is loaded. You can turn
  this off in Settings ("Keep both loaded") if you later use smaller models.

The context-length warning in Chat is based on the same numbers: 8192 is safe,
and above about 16k the app warns you the model may not fit in 16 GB.

## 5. Folder tree

```
archai-studio/
├── PLAN.md  CLAUDE.md  README.md  SIGNING.md  PRIVACY.md  CHANGELOG.md
├── CODE_SIGNING_POLICY.md          (only if the licence is open source)
├── VERIFY.md                       checklist for you per milestone
├── package.json  tsconfig*.json  electron.vite.config.ts  eslint.config.js
├── electron-builder.yml            packaging (NSIS + AppX)
├── store-identity.json             Partner Center values (placeholders)
├── build/                          installer art, icon.ico, appx tiles, installer.nsh
├── resources/
│   ├── workflows/                  ComfyUI API-format templates (*.json)
│   ├── skills/                     4 bundled starter skills (SKILL.md each)
│   ├── prompts/                    system prompts: chat + one per script target
│   └── fonts/                      bundled grotesk font (OFL licence)
├── design/                         icon.svg, splash.svg, source art
├── scripts/
│   ├── make-icons.mjs              SVG → .ico (16–256) + Store PNG tiles
│   ├── make-selfsigned-cert.ps1    local MSIX sideload testing only
│   └── capture-screenshots.ts      4 Store screenshots via Playwright
├── src/
│   ├── shared/                     ipc.ts (channel contract + zod), types.ts
│   ├── main/
│   │   ├── index.ts  window.ts  csp.ts  net-guard.ts  protocol.ts
│   │   ├── settings.ts  paths.ts  db/ (schema.sql, migrations, repo-*.ts)
│   │   ├── services/ollama.ts  comfy.ts  checks.ts  gpu.ts
│   │   ├── features/chat.ts  scripts.ts  images.ts  skills.ts  docs.ts  export.ts
│   │   └── updater.ts              manual "Check for updates" only
│   ├── preload/index.ts
│   └── renderer/
│       ├── main.tsx  App.tsx  theme/ (tokens.css, light/dark)
│       ├── components/             shared UI (buttons, panels, banner, dialog)
│       └── pages/  Wizard/ Chat/ Scripts/ Visual/ Skills/ Documents/ Settings/
├── tests/
│   ├── unit/                       Vitest
│   ├── e2e/                        Playwright for Electron
│   └── fakes/                      fake Ollama + fake ComfyUI servers
└── .github/workflows/  ci.yml  release.yml   (copied to repo root, path-filtered)
```

## 6. IPC map (the allow-list)

`invoke` = request and reply. `event` = main pushes updates (for example,
streaming text).

| Channel | Kind | Purpose |
|---|---|---|
| `app:info` | invoke | version, data paths, build type (exe/store) |
| `settings:get` / `settings:set` | invoke | read/write settings (validated) |
| `settings:export` / `settings:import` | invoke | save/load settings JSON via file dialog |
| `dialog:pickFolder` / `dialog:pickFile` | invoke | native pickers (main returns the path) |
| `checks:run` | invoke | wizard checks → list of {id, ok, detail, fix} |
| `projects:list` / `create` / `rename` / `archive` | invoke | projects |
| `chat:models` | invoke | Ollama `/api/tags` |
| `chat:send` | invoke | start a stream, returns streamId |
| `chat:chunk` / `chat:done` / `chat:error` | event | streamed tokens, skills used, stats |
| `chat:cancel` | invoke | stop a stream |
| `chat:history` / `chat:threads` | invoke | load past chats |
| `scripts:targets` | invoke | the 6 targets and their file extensions |
| `scripts:generate` / `explain` / `fix` | invoke | streams through `chat:*` events |
| `scripts:save` | invoke | Save As dialog → .py / .lsp / .ts (written by main) |
| `scripts:list` | invoke | project's saved scripts |
| `images:workflows` | invoke | templates + your imported workflows |
| `images:importWorkflow` | invoke | validate and store your API-format JSON |
| `images:models` | invoke | checkpoints/ControlNets from ComfyUI `/object_info` |
| `images:promptHelp` | invoke | gpt-oss → {prompt, negative} |
| `images:generate` | invoke | queue job, returns jobId |
| `images:progress` / `images:done` / `images:error` | event | from ComfyUI websocket |
| `images:cancel` | invoke | ComfyUI `/interrupt` |
| `gallery:list` / `gallery:reveal` / `gallery:delete` | invoke | gallery (delete asks first) |
| `gpu:state` | event | which side holds VRAM |
| `skills:list` / `skills:toggle` | invoke | library |
| `skills:previewGithub` / `skills:previewLocal` | invoke | fetch/unpack to a quarantine folder, return SKILL.md + file list |
| `skills:confirmImport` / `skills:remove` | invoke | move from quarantine into library / remove (asks first) |
| `skills:approveScript` / `skills:runScript` | invoke | see section 7.4 |
| `docs:add` / `docs:list` / `docs:remove` / `docs:ask` | invoke | phase 2 documents |
| `export:docx` / `export:pdf` / `export:xlsx` | invoke | phase 2 exports |
| `updates:check` | invoke | manual check (.exe build only; the Store updates itself) |

Anything not in this table can't be called from the screen.

## 7. Feature design notes

### 7.1 First-run wizard
Checks run in parallel, each with a 3-second timeout:
1. Ollama reachable (`GET /api/version`).
2. `gpt-oss:20b` in `/api/tags`.
3. ComfyUI reachable (`GET /system_stats`), which also reports ComfyUI's GPU.
4. NVIDIA GPU present (`nvidia-smi --query-gpu=name,memory.total` if found;
   otherwise the GPU list from ComfyUI; otherwise "unknown").
5. Free disk space on the chosen data drive (warn under 20 GB).

A failed check shows a plain-language fix, a link to open in your browser and a
command with a Copy button (for example, `ollama pull gpt-oss:20b`). The app
never downloads a model itself. For ComfyUI on an RTX 50-series card, the fix
text notes that ComfyUI needs a PyTorch build with CUDA 12.8 or newer. There's
also a "Re-check" button, and the wizard can be reopened from Settings.

Data folder: default `C:\Users\<you>\ArchAI Studio`, plus an optional separate
gallery folder (for example `D:\ArchAI Gallery`). A tiny pointer file in
`%APPDATA%` remembers where you put them.

### 7.2 Chat
Streaming from `/api/chat` (newline-delimited JSON), cancellable. The model
picker comes from `/api/tags`. Context length defaults to 8192, with the VRAM
warning above. Every thread belongs to a project. The system prompt is in
`resources/prompts/chat.md`: Sri Lankan and tropical practice, metric units, and
a standing instruction to verify regulations (UDA, local authority) and any
structural figures against source documents. gpt-oss "thinking" text can be
shown in a collapsible section or hidden.

### 7.3 Script Studio
Six targets, each with its own prompt file: conventions, required imports and a
known-good example.
- Dynamo Python (Revit): `clr`, `RevitServices`, `TransactionManager`, `OUT`
- pyRevit: `pyrevit.revit`, `forms`, `script` output, `__title__`
- Grasshopper Python (Rhino 8, CPython 3): `# r:` requirements, `ghpythonlib`,
  `Rhino.Geometry`
- AutoLISP: `defun c:`, `vl-load-com`, error handler, undo marks
- Blender Python: `bpy`, operators versus data API, `bmesh`
- Excel / Office Scripts: `function main(workbook: ExcelScript.Workbook)`

Flow: describe → generate → Monaco view → Copy / Save. There are "Explain this
script" and "Fix this error" (paste a traceback) buttons. A fixed banner says to
review the script before running it. The app has no code path that runs scripts
in Revit, Rhino or AutoCAD.

### 7.4 Skills
- Format: a folder with `SKILL.md` and YAML frontmatter `name` and
  `description`, plus optional files.
- **Import from GitHub:** paste a URL like
  `https://github.com/owner/repo/tree/main/skills/foo`. The app downloads the
  repo zip from `codeload.github.com`, extracts only that folder into a
  quarantine folder (with size limits and blocking of `../` paths), and shows
  SKILL.md and the list of files. Nothing goes into your library until you
  click Import. The same applies to a local folder or .zip.
- **At chat time:** step 1, the model gets only names and descriptions and
  replies with the ones it wants (at most 3). Step 2, those SKILL.md texts are
  added to the system prompt. The chat shows "Skills used: …". You can also pin
  skills by hand.
- **Scripts that come with a skill never run automatically.** To run one, you
  approve that exact skill and script in a dialog that shows the full code. The
  approval is tied to the file's fingerprint (SHA-256), so if the file changes
  you're asked again. Approved scripts run as a separate process in the skill's
  folder, with a timeout, and output is shown. For v1 I propose to support only
  Python and PowerShell scripts.
- Four bundled skills, written with `skill-creator`: Dynamo/pyRevit scripting,
  Grasshopper scripting, design statement writing, and architectural render
  prompt writing.

### 7.5 Visual Studio
- Modes: text-to-image; sketch or massing → render (ControlNet: canny, depth,
  lineart); image variation (img2img with a denoise slider).
- Templates in `resources/workflows/` (SDXL first; Flux templates marked as
  optional, because they need extra nodes). Each template has a small
  `*.meta.json` that says which node gets the prompt, seed, image and so on. Model
  filenames are **not** hard-coded: they're picked from the lists your ComfyUI
  reports, so the templates work with whichever checkpoints you have.
- Importing your own workflow: the app checks that it's API format (not the UI
  save format), then asks which nodes are the positive prompt, negative prompt,
  seed and input image.
- Style presets: tropical modern, Geoffrey Bawa-inspired courtyard, brutalist,
  Scandinavian, night exterior, interior daylight. Each preset is a prompt
  fragment plus a negative prompt fragment.
- Progress comes from ComfyUI's websocket (`/ws?clientId=`). Results come from
  `/view`. PNGs are saved with the prompt, negative prompt, seed, model and
  workflow in PNG text metadata, the same way ComfyUI does it, so they open back
  in ComfyUI. Each project has its own gallery.

### 7.6 Documents (phase 2)
PDF text is extracted locally (`pdfjs-dist`), page by page, then split into
chunks of about 800 tokens. Embeddings come from `nomic-embed-text` via
`/api/embed`. Vectors are stored in SQLite as blobs and searched with plain
cosine similarity, which is fast enough for thousands of pages and needs no
extra native add-on. Answers include `[UDA Regulations 2021, p. 34]`-style
citations, and clicking one opens that page. Exports: project report to `.docx`
(the `docx` library, following the docx skill) and `.pdf` (rendered from the
same layout with Electron's built-in PDF printer and the bundled font), and an
area schedule to `.xlsx` (`exceljs`, following the xlsx skill) with real
formulas for the totals.

### 7.7 Settings
Endpoints (loopback only, port editable), default chat, script and embedding
models, context length, data and gallery folders, light/dark theme, GPU
turn-taking, and settings export/import as JSON.

### 7.8 Database (SQLite, `better-sqlite3`)
Tables: `projects`, `threads`, `messages`, `scripts`, `images`, `workflows`,
`skills`, `skill_script_approvals`, `documents`, `chunks` (with vector blob),
and `settings_kv`. Migrations are numbered SQL files. WAL mode is on.

## 8. Look and feel (with `frontend-design`)
Calm and architectural, like a drawing set. The default theme is dark
graphite, with a warm off-white light theme. There's one accent colour: I
propose laterite red-orange (Sri Lankan laterite and terracotta). Spacing is
generous, on an 8 px grid, with thin hairline rules instead of boxes and
tabular numbers. The bundled font is a grotesk under the OFL licence (I propose
**Hanken Grotesk** or **Inter**), and code uses **JetBrains Mono**. Both are
bundled as files, so there are no web fonts.

Deliverables: `icon.svg` turned into a multi-size `.ico` (16–256 px) and every
Store PNG tile size (44, 50, 150, 310×150, 310 and their scales), NSIS sidebar
and header bitmaps, a splash screen, and 4 Store screenshots captured with
Playwright from the running app against the fake servers.

## 9. Packaging, updates and signing
- **NSIS:** file `ArchAI-Studio-Setup-<version>.exe`. It's an assisted installer
  (`oneClick: false`) where you choose the folder, per-user by default, with
  desktop and Start menu shortcuts. A custom `installer.nsh` makes the
  uninstaller ask "Keep your projects, chats and images?" (default **Keep**). It
  only deletes the data folder if you say no.
- **AppX/MSIX** for the Store. The identity values come from
  `store-identity.json`.
- npm scripts: `dev`, `lint`, `typecheck`, `test`, `e2e`, `dist:exe`,
  `dist:msix`, `dist`.
- **Updates:** the .exe build has a "Check for updates" button in Settings that
  looks at this repo's GitHub Releases and never checks on its own. The Store
  build hides the button, because the Store handles updates.
- **Signing (free):**
  - Store: Microsoft re-signs the MSIX for free. `SIGNING.md` shows which
    Partner Center page each value comes from (Product identity: *Package/Identity/Name*,
    *Package/Identity/Publisher*, *Package/Properties/PublisherDisplayName*).
  - SignPath Foundation: only if you pick MIT. This needs a `release.yml`
    prepared with placeholder secrets and a `CODE_SIGNING_POLICY.md`.
    SignPath has to approve the project first, and they require a public
    repository.
  - `make-selfsigned-cert.ps1` is for **sideload testing on your own PC only.**
    It does not stop SmartScreen warnings for other people.
  - `.gitignore` blocks `*.pfx`, `*.p12`, `*.cer`, `*.key`, `*.pem`, `.env*`
    and certificate folders.
- Ollama, ComfyUI and model weights are never bundled.

## 10. Milestones

Each milestone ends with lint, typecheck, unit tests and a Playwright smoke test
(all must pass), plus a CLAUDE.md update, a git commit and push, a short summary
for you, and a `VERIFY.md` section for your PC.

| # | Milestone | You'll be able to… |
|---|---|---|
| **M0** | Scaffold: electron-vite + React + TS, security baseline (CSP, sandbox, net-guard, IPC contract), ESLint, Vitest, Playwright, fake servers, CI on a Windows runner | open an empty, locked-down window; CI builds an unsigned Setup.exe |
| **M1** | Design system and shell: fonts, tokens, dark/light, navigation, projects, SQLite, Settings | create "Kandy Residence" and switch themes |
| **M2** | First-run wizard | see clear red/green checks; stop Ollama and see it reported |
| **M3** | Chat | stream answers from gpt-oss, pick models, set context, view history per project |
| **M4** | Script Studio | generate, explain and fix scripts for the 6 targets, then save .py/.lsp |
| **M5** | Visual Studio | text-to-image, sketch → render, variations, prompt helper, presets, gallery |
| **M6** | Skills library and the 4 bundled skills | import from GitHub or a folder, with the auto-pick of skills in chat |
| **M7** | Visual assets and packaging: icon set, installer art, splash, NSIS + MSIX, signing files, Store screenshots | install and uninstall Setup.exe; sideload the MSIX; run WACK |
| **M8** | Documents (phase 2): PDF Q&A with page citations, .docx/.pdf/.xlsx export | ask "what's the setback rule?" and get a page reference |
| **M9** | Finish: README, SIGNING, PRIVACY, CHANGELOG, hardening, "Done" checklist | go through section 9 of your brief on a fresh PC |

I'll check in with you after M2, M5, M7 and M9 (or sooner if something is
blocked).

## 11. Risks and how I'll handle them
- **Native module (`better-sqlite3`) on Windows:** electron-builder rebuilds it
  for Electron on the Windows CI runner. If that gives trouble, the fallback is
  Node's built-in `node:sqlite`. I'd ask you before switching.
- **ComfyUI workflows vary a lot:** this is why the templates use the meta file
  plus model lists from your ComfyUI, instead of fixed filenames.
- **WACK:** I can't run it here. I'll follow the known Electron and MSIX
  requirements (tile sizes, no restricted capabilities other than
  `runFullTrust`), and you run WACK at M7.
- **gpt-oss tool output:** skill picking asks for a small JSON answer. If the
  model replies badly, the app falls back to keyword matching, so chat never
  breaks.

## 12. Questions for you (before I start M0)
1. **Licence:** MIT (open source, enables free SignPath signing for the .exe,
   but the repo must be public) or PROPRIETARY (Store-only signing, the .exe
   stays unsigned)?
2. **Publisher name** for the installer and Store listing.
3. **OK to build in the `archai-studio/` subfolder** of this repo (section 1)?
4. Any changes to the plan. Two things to look at: the stricter "renderer has
   no network" CSP and the GPU turn-taking.

Partner Center values aren't needed until M7.
