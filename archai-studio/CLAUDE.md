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
