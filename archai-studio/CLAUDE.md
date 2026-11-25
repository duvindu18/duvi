# ArchAI Studio: notes for Claude

Offline Electron desktop app for an architect (Windows 11). Read PLAN.md for the full design.
The owner is an architect, not a developer: explain decisions in plain language.

## Commands (run inside `archai-studio/`)
- `npm run dev`: app with hot reload
- `npm run lint` / `npm run typecheck` / `npm test` (Vitest) / `npm run e2e` (builds, then Playwright)
- On Linux containers: `xvfb-run -a npm run e2e`. Root needs `--no-sandbox` (handled in tests/e2e/launch.ts).
- `npm run check`: everything above in order. Must pass before every commit.
- `npm run dist:exe` / `dist:msix` / `dist`: Windows packaging (MSIX only on Windows; CI does this).

## Rules that must not be broken
- No telemetry or analytics, and no network except loopback AI services. GitHub only on an explicit click
  (purposes `github-import` / `update-check` in `src/shared/net-policy.ts`).
- Main process: all requests go through `guardedFetch` (src/main/net-guard.ts); ESLint bans `fetch`/`http` elsewhere.
- Screen (renderer): no network (CSP `connect-src 'self'`), no Node. ESLint bans fetch/WebSocket/electron imports.
- New IPC channel = add to `src/shared/channels.ts` + zod schema and type in `src/shared/ipc.ts` + handler in main.
  A unit test enforces that the schemas match the channel list.
- Never auto-download models. Never run skill scripts without a per-script approval (hash-bound).
- Never commit certificates or keys (.gitignore). Ask the owner before deleting user files.

## Owner decisions
- Publisher: **Seedform** (the owner's architecture studio, Colombo). Licence: **proprietary** (package.json
  "UNLICENSED", LICENSE.md). So there is no SignPath workflow: the Store MSIX is re-signed free by Microsoft, and the
  direct Setup.exe ships unsigned (SmartScreen warns other people). The self-signed script is for local sideload tests only.

## Decisions log
- M0: The app lives in `archai-studio/` because the repo root holds a separate project (Veil).
- M0: Screen served from `app://archai/` (custom privileged scheme), not file://, so CSP headers apply
  and path traversal is blocked (`resolveInside`). Node reports origin "null" for custom schemes, so
  sender checks compare protocol and host (`isAppUrl`).
- M0: TypeScript 6.0 (typescript-eslint doesn't support TS 7 yet). Electron 45, Vite 8 (rolldown), electron-vite 6.
- M0: Preload is built as a single CJS file (`index.cjs`), required for sandboxed preloads.
- M1: SQLite via better-sqlite3 13. It ships N-API prebuilds (including win32-x64) that load in both
  Node (Vitest) and Electron, so no native rebuild step is needed.
- M1: settings.json lives in userData (%APPDATA%\ArchAI Studio). The DB lives in the data folder
  (default ~/ArchAI Studio, override with ARCHAI_DATA_DIR). Changing the data folder applies on next start.
- M1: Design system: Archivo variable (wdth axis) with wide titles, graphite + paper palette, single accent
  "Lunuganga moss" #93B37E (light theme #4B763B). The bottom status strip is drawn as a drawing-sheet
  title block, and it's the only element drawn with linework. No all-caps labels, no card grids.
  Tokens live in src/renderer/src/theme/tokens.css.
- M1: Projects are archived, never deleted (unique names among active projects, case-insensitive).
- E2E tests launch the app folder ('.') so package.json supplies the name and version; dialogs are stubbed via app.evaluate.
- M2: First-run wizard (Welcome, Checks, Folders, Ready). Checks never download anything; each failure has
  plain text, an optional PowerShell command (copied via the `clipboard:writeText` IPC; renderer permissions
  stay fully denied) and an optional https link that opens in the browser on click.
- M2: GPU detection order: nvidia-smi, then ComfyUI /system_stats, then Electron getGPUInfo (vendor 0x10de).
- M2: DB opens lazily (src/main/db/store.ts), so nothing is written until setup confirms the data folder.
- M2: The title block pings Ollama /api/version and ComfyUI /system_stats every 20 s (loopback only).
- E2E: `launchApp({ dirs, seed })` writes settings.json before launch. By default it seeds firstRunComplete=true;
  pass `seed: null` on relaunches to read what the app saved.
- Theme input: the owner's **Seedform** design system (claude.ai artifact b9ae09c9-…). The owner said the current UI
  is fine, so only these were taken: square-cut 2px corners (circles only for status dots), hairlines instead of
  shadows, square-cap mitred icons, laterite (#E07A55 / #A84E33) for errors, Cloud Dancer #F0EEE9 light ground,
  and an optional "Phthalo" theme (#123524 ground, sand #D4B786 accent). Archivo stays; Seedform's fonts and logo are
  NOT used for the app (they are the studio's identity, not the product's).
- Writing style (UI copy AND model system prompts, from Seedform's voice guide): UK / Sri Lankan English (colour,
  centre, metres, programme), areas in m², numerals for all measurements, sentence case, no exclamation marks, plain
  words, short sentences. Local words (midula, pila) are fine; explain them the first time.
- M3: Chat streams Ollama /api/chat (NDJSON) through ChatService (src/main/features/chat.ts). Chunks are batched
  every 40 ms into `chat:chunk` events; `chat:done` carries the saved message. Stop aborts the request and saves the
  partial reply with meta.stopped. History is trimmed to fit num_ctx (about 3.5 chars per token, 2048 tokens kept for the reply).
  gpt-oss gets `think: "medium"`; its reasoning is stored and shown in a collapsed "Reasoning" section.
- M3: System prompt: resources/prompts/chat.md, bundled into main via `?raw`. Sri Lankan practice context, metric,
  Seedform voice, and a mandatory "check against source documents" note for regulations and structural figures.
- M3: GPU turn-taking: GpuCoordinator frees ComfyUI (/free) before chat if images last used the GPU, and unloads the
  chat model (keep_alive 0) before images (wired in M5).
- M3: Model replies are rendered with react-markdown + remark-gfm. No raw HTML, images are shown as text, and only
  https links are live (they open in the browser).
- M4: Script Studio reuses ChatService with `kind: 'script'` threads and a per-target system prompt
  (resources/prompts/scripts/_common.md + <target>.md, each with conventions and a known-good example).
  The first fenced block of the reply goes into Monaco (`extractCode`), and the rest shows as Notes.
  Saved scripts are written as UTF-8 with CRLF and recorded in the `scripts` table. The app has no code path that executes scripts.
- M4: Monaco 0.52.2 (ESM, bundled), core editor plus Python/TypeScript tokenizers and a small AutoLISP Monarch grammar.
  No language workers except the base editor worker; links, hovers and suggestions are off. Script Studio is lazy-loaded
  (startup bundle about 0.5 MB, editor chunk about 3 MB). Renderer build is minified.
- M5: Visual Studio. Templates live in resources/workflows/<id>.json (ComfyUI API format) + <id>.meta.json (name, mode,
  bindings: which node/input takes prompt, seed, checkpoint, image, …), bundled via import.meta.glob. Model file names
  are never hard-coded: pickers come from /object_info, and the last choice is stored in settings.images.
  Imported workflows go through parseApiWorkflow (rejects the editor format and explains Export (API)), then
  detectBindings, then the user confirms, then they're stored in the `workflows` table.
- M5: Job flow: upload input (/upload/image), then gpu.beforeImages() (unloads the Ollama model), then POST /prompt,
  then progress over /ws (falls back to polling /history), then /view, then PNG saved with iTXt chunks (parameters,
  archai:*), keeping ComfyUI's own prompt/workflow chunks. Files: <gallery>/<project-slug>-<id>/<date>/<date>_<time>_<seed>.png.
- M5: The screen shows images only via archai-img://gallery/<id> or archai-img://input/<token> (known files only, never a
  path from the screen). "Remove" moves the file to the Recycle Bin (shell.trashItem), never a permanent delete.
- M5: Fake ComfyUI (tests/fakes/fake-comfy.ts) uses the `ws` dev dependency for the progress websocket. The app itself
  uses Node's built-in WebSocket through guardedWebSocket.
- Flux: templates flux-text (all-in-one checkpoint), flux-split-text, flux-variation (UNETLoader + DualCLIPLoader type
  flux + VAELoader + FluxGuidance, cfg 1) and flux-sketch-canny (official Flux.1 Canny dev: Canny, then
  InstructPixToPixConditioning, guidance 30). Model bindings: checkpoint, controlnet, unet, clip1, clip2, vae; lists from
  /object_info (UNETLoader, DualCLIPLoader, VAELoader). Choices are stored per workflow in settings.images.byWorkflow, and
  `pickModel` falls back from your last choice to the template file, then the meta `prefer` regex, then the first listed.
  The prompt helper writes natural sentences for Flux (family from describeWorkflow).
