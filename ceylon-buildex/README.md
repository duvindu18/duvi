# Ceylon Buildex

A search-first web portal that answers questions about **Sri Lankan building regulations, planning gazettes and public-procurement
Standard Bidding Documents (SBDs)** from a single searchable dataset - with citations, a **Floor Area Ratio (FAR) calculator**
driven by zone functions and the Colombo Municipal Council (CMC) / UDA rules, fast OCR, and a one-click updater.

```
CeylonBuildex.exe   # Windows: double-click. One file, one window, no console (see "The desktop program")
./run.sh            # Linux / macOS / WSL -> http://127.0.0.1:8080
./run.sh update     # download / refresh every registered source
```

## What it does

| Page | What you get |
|---|---|
| **Ask** | Searches the dataset first, runs the FAR rules engine if the question is about floor area, then an LLM writes the reply *only from the retrieved passages* with `[S1]`-style citations. No LLM key? It falls back to quoting the best-matching passages (extractive mode). Nothing relevant? It says so - no guessing. |
| **Floor area** | Two regimes: **CMC area** (City of Colombo Development Plan 2008: zones, Form C1 FAR by land extent and street width, Form C2 coverage/spaces, Concentrated Development table) and **UDA 2021** (Gazette 2235/54 Schedule 6: Forms A-E by zone factor / density, land extent and road width). Shows the table row used, max floor area, coverage, spaces, checks against a proposed design, warnings and the legal-status caveat. |
| **Library** | Every source as a round node in a labelled box for its kind of document, joined by a **mesh of triangles** (or a plain list). Node size follows page count; lines across the map are real relations. Status, origin (full text vs seed extract) and a page-level reader. |
| **Scan** | Drop a scan or photo: text-layer pages are used as they are; image-only pages go to Tesseract in parallel (170 dpi fast / 300 dpi accurate), cached by content hash, rotation retry for low-confidence pages, garbled legacy-font text layers detected and re-OCR'd. Option to add the result to the dataset. |
| **Update** | Downloads every source in `config/sources.json` with conditional GET (ETag / Last-Modified / SHA-256, PDF validation), scans listing pages (UDA, documents.gov.lk, Treasury, CIDA) for new documents, OCRs what needs it, rebuilds the dataset and exports `data/dataset.jsonl`. |

## The interface

**The query page is one line of type and nothing else.** Bold capitals in the accent colour read **FIND THE RULE...** (the dots blink) in the middle of the page until
you type. The line is a fixed size - at most 88 px (56 px on a phone), set in Anton - and is centred across and down; what you type takes the room it needs and shrinks only
as you keep typing, so a long question still fits. Enter asks (Shift+Enter adds a line), Esc clears the line or stops a running question. No example questions, no toggles, no footer.

**One small, fixed type system.** Titles, the start line, the brand and the big numbers are Anton, uppercase, in the accent colour. Everything you read or click is Inter in
three weights only (regular, medium, semibold) and six fixed sizes from 12 to 22 px; phone fields are 16 px so the page does not zoom when you tap one. Nothing scales with the
window, so a 2000 px monitor shows the same type as a laptop and the page simply stops widening at 1560 px.

**The page is a fixed frame.** The browser window never scrolls: the top bar stays where it is, and each page scrolls inside its own area with a slim bar that sits just
outside the content edge, so content lines up with the header whether or not a bar is showing. The Floor area, Scan and Update pages are two panels of **exactly the same top,
height and bottom** (one column on a phone); each scrolls on its own if its content is taller. Spacing comes from one scale (4-48 px) and rows of chips or buttons wrap with
a 12 px gap, so nothing touches. On an answer the sources stay beside the text.

**Library map.** Each kind of document gets a labelled box; box area follows how many documents it holds. Inside a box every source is a round node (size = pages) and
the nodes are joined by a **Delaunay triangulation** - a mesh of triangles whose lines never cross. *The mesh only means "same kind of document"*; where a node sits inside its
box is layout (date order along a snake path, with small fixed offsets), not data. A solid node is current, an orange centre means *to verify*, a strike means *superseded*,
hollow is reference, and a dashed ring marks a summary only (not the full text). The lines drawn **across** the map are the real relations, and only when the data says so:
*same gazette number* or *supersedes* (orange, the strongest, always shown), *same issuing authority* and *same publishing site* (faint, shown between boxes and inside a box when you
point at a node). Nothing is inferred from titles. Boxes rise, nodes pop in, lines draw themselves, then small signals travel along the gazette and authority lines (all switched
off by `prefers-reduced-motion`). Point at, focus or tap a node to light its relations, outline its box and see its card; arrow keys move between nodes, Enter opens the document.
The category chips and the filter box dim the nodes (and any box left empty) that do not match. On a phone the boxes stack in one column.

The other pages - **Floor area, Library, Scan, Update** - and **Settings** are plain text links in the top-right corner (a second row on a phone).

**Settings** (a dialog; a bottom sheet on a phone) holds everything that used to sit on the page:

* *Search* - Answer or Passages, search within one kind of document, hide superseded documents (Passages mode).
* *Appearance* - System, Light or Dark, and an **accent colour**: seven presets (each has a deeper variant for light pages and a brighter one for dark pages) or any colour you pick. The text on top of the accent switches between dark and white for contrast. Saved in this browser and applied before the first paint.
* *Written answers* - Claude, any OpenAI-compatible server or local model (Ollama), Automatic, or Off. A dot beside the link shows while no model writes the answers.

Choices are remembered in this browser. Keys are sent to the server, kept in `data/settings.json` (private file) and never sent back to the page.

**Answers** keep your question as a compact line, open with the answer in large bold type, and put a **highlighter** over the facts a reader must not miss - a limit, a
value, a date, a condition - with the sources in a column beside it. The model is asked to wrap such facts in `==...==`; if it does not (or no model is used), the server finds
values with units, percentages, money, ratios, dates and FAR values by pattern (at most 6 per answer, 3 per paragraph; never in the caution, regime or note paragraphs; never touching a
`[S1]` tag). Only words already in the answer are marked - the highlight is emphasis, not verification - and the markers are removed when you copy the answer.
With reduced motion the strokes are drawn at once instead of sweeping across.

While a question runs, one status line says what is happening *now*:

| The page shows | When the server has really... |
|---|---|
| Sending your question | received nothing yet (the request is in flight) |
| Reading your question | started to parse the question |
| Calculating floor area ratio | found complete FAR inputs and started the rules engine (only then) |
| Searching 340 passages in 16 documents | started the search, over exactly that many passages |
| Found 7 passages in 3 documents | finished the search |
| Writing the answer with *model* (and an elapsed-seconds counter after 6 s) / Composing the answer from the passages | started the language model / composed the answer without one |

Nothing is timed or faked: the status comes from the NDJSON events of `POST /api/ask/stream` (`parse`, `far`, `search`, `found`, `write`, `done`, `error`),
the loaders disappear the moment `done` arrives, and a skeleton holds the answer's place so nothing jumps. Enter is ignored while a question is running;
a **Stop** button appears at the right of the line. A failed or stopped question keeps your text and offers **Retry**. Older answers fold up. `/` jumps to the line from anywhere.

The Floor area page recalculates as you type (no button); on a phone a floating bar keeps the FAR in view while you edit. Library, Scan and Update carry every earlier feature.
The Floor area page recalculates as you type (no button); on a phone a floating bar keeps the FAR in view while you edit. Library, Scan and Update carry every earlier feature.
`prefers-reduced-motion` cuts animation to nothing without changing content. The front end is plain ES modules - no build step, no dependencies. Both typefaces are bundled
and served from this server, so no page ever asks another site for a font: **Anton** and **Inter** (SIL Open Font License 1.1; licences in `web/fonts/OFL-Anton.txt` and `OFL-Inter.txt`).

## The desktop program (Windows, one file)

`CeylonBuildex.exe` is one file. Double-click it and a window opens - there is no console, no `.bat` file and no browser tab or address bar to find.
It keeps its own data in `%LOCALAPPDATA%\CeylonBuildex` (first start copies the shipped reference data in; later versions never overwrite what you added or downloaded;
set `LRP_HOME` to move it). A second double-click opens another window on the copy that is already running. Close the window and everything it started stops. Problems are written to
`logs\launcher.log` in that folder and shown in a message box - never to a console.

How: `launcher.py` starts the portal on a free local port, opens it in Microsoft Edge (or Google Chrome) in its own `--app` window with a private profile, and quits when that
window closes (the page also pings the program every 15 s, which covers a browser that hands its window to another process). Everything it launches (Ollama, Tesseract, Poppler)
is started without a console window. The exe carries Tesseract and Poppler, so OCR needs nothing else installed. Without Edge or Chrome it falls back to the default browser.

**Building it.** PyInstaller makes programs for the system it runs on, so the exe has to be built on Windows:

* **GitHub Actions:** the workflow `.github/workflows/build-exe.yml` runs the unit tests on Linux, then builds on `windows-latest` (installs Tesseract and Poppler, builds, starts the exe and checks that it serves) and keeps `CeylonBuildex.exe` as a downloadable artifact. Run it from the Actions tab or push a tag such as `v1.1.0`.
* **On your own Windows PC:** `pip install -r requirements.txt` then `python scripts/build_exe.py` -> `dist/CeylonBuildex.exe` (needs Tesseract and Poppler installed once: `winget install UB-Mannheim.TesseractOCR oschwartz10612.Poppler`).
* **No build at all:** double-click `CeylonBuildex.pyw` (needs Python); it runs the same launcher with no console.

The exe is **not code-signed**, so Windows SmartScreen may show "Windows protected your PC" the first time; choose *More info*, then *Run anyway*. `run.bat` and `run.ps1` were removed.

> **Tested vs not tested.** The launcher's logic (one-copy lock, data-folder seeding, window hand-off, quitting when the window closes, errors to the log) is covered by tests that run
> on Linux with a stand-in browser. **The Windows exe itself was never built or run here** - the sandbox has no Windows and could not install PyInstaller - and neither were the
> workflow, the Windows-only code paths (hidden console windows, message box, `%LOCALAPPDATA%`), Edge/Chrome `--app` mode on a real PC, or the bundled Tesseract/Poppler.
> If the first build or run fails, send me `launcher.log` or the Actions log.

## Ollama at start-up

If the saved answer-writing choice could use Ollama (Automatic, Ollama, or an OpenAI-compatible address that points at it), the program checks it in the background as soon as it starts,
so the page opens at once and **Settings > Written answers** shows where it is:

1. find `ollama` (`OLLAMA_BIN`, the PATH, or the installer folders);
2. if the Ollama server is not running, start it (hidden), and stop it again on exit only if this program started it;
3. if the model is not installed, download it with progress - **`qwen3.5:4b` is several gigabytes, so the first start takes a while** and needs a connection (`OLLAMA_AUTOPULL=0` turns the download off);
4. run the check itself: `ollama run qwen3.5:4b "Say ready"`, and report whether the reply contains "ready".

States shown: checking, starting, downloading n %, loading the model, ready, Ollama not installed (with where to get it), error (with the reason). Nothing here is required: without
Ollama the portal still works and quotes passages. It is skipped when the saved choice is Claude, Off or another server. Variables: `LRP_OLLAMA_BOOT` (`auto` / `0` never / `1` always),
`OLLAMA_MODEL`, `OLLAMA_CHECK_PROMPT`, `OLLAMA_BIN`, `OLLAMA_URL`. A **Check again** button in Settings repeats it.

## Setup - Linux, macOS, WSL, Docker

| System | Command | What it installs for you |
|---|---|---|
| **Linux, macOS, WSL** | `./run.sh` | Python 3.9+, `poppler`, `tesseract` (via apt, dnf, yum, pacman, zypper, apk or Homebrew - uses `sudo` when needed), a private `.venv`, the Python packages, then loads the dataset and starts the portal at http://127.0.0.1:8080 |
| **Windows** | `CeylonBuildex.exe` | Nothing - see above |
| **Any (Docker)** | `docker compose up --build` | Everything inside a container, including Sinhala and Tamil OCR; `./data` is kept on your disk *- not built here; see the note below* |

On the **very first start** the portal also downloads all registered documents in the background (progress on the *Update* tab). Later starts
are fast: packages are only reinstalled if `requirements.txt` changes.

```bash
./run.sh              # set up (first time) and start
./run.sh update       # download / refresh every source, then exit
./run.sh setup        # install only
./run.sh test         # install the test tools and run the test suite
WITH_SIN_TAM=1 ./run.sh      # also install Sinhala + Tamil OCR data
FIRST_RUN_UPDATE=0 ./run.sh  # do not download on the first start
OPEN_BROWSER=0 PORT=9000 ./run.sh
```

If a system package cannot be installed automatically (no `sudo`, unknown distribution), the script prints exactly what to install and carries on; the
portal still starts with the built-in extracts. Without `pdftotext` PDFs cannot be read, without `tesseract` scanned pages cannot be OCR'd.

> **Tested vs not tested.** `run.sh` was run on Ubuntu 24.04 (fresh venv, repeat run, first-start download, unknown command, the failure path when
> a package server is unreachable). The sandbox could not reach PyPI or the apt mirrors, so the actual download-and-install of packages was **not**
> exercised, and the `Dockerfile` could not be built (no Docker daemon available). If one of those fails for you, send me the error message.

Manual setup, if you prefer:

```bash
pip install -r requirements.txt
sudo apt install poppler-utils tesseract-ocr          # (brew install poppler tesseract on macOS)
python3 -m app.ingest init && python3 -m app.ingest update && python3 -m app.server
```

**Written answers (language model)** - without one, Ceylon Buildex can only compose an answer from quoted passages. Turn it on in the portal:
click the sliders icon (top right; it carries a dot while answers are off) or **Turn on written answers** under the search box, choose a provider, paste the key and press **Save and test**. Options:

| Choice | Needs | Notes |
|---|---|---|
| **Claude** (default model `claude-sonnet-5-5`, changeable) | API key from console.anthropic.com | Best quality. API use is billed separately from a claude.ai subscription. |
| **OpenAI or any OpenAI-compatible server** | Server address, model name, key | e.g. `https://api.openai.com/v1`, vLLM, LM Studio |
| **Ollama on this computer** | Ollama installed (the program starts it and downloads the model - see above) | Free, no key. A running Ollama is detected automatically; or press **Use Ollama** in the settings. Small local models write weaker answers than Claude. The portal talks to Ollama's own API with thinking switched off and a compact prompt, so small and reasoning models work. Models marked `:cloud` need an Ollama sign-in and are only picked automatically if no local model is installed. |
| Environment variables | `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY` / `LLM_BASE_URL` | Used when nothing is saved in Settings (choose **Automatic**). Settings win over the environment. |

The key is saved only in `data/settings.json` (owner-only permissions), is never sent back to the browser, and Settings can only be changed from
this computer's own page (other websites and other hosts are refused; set `LRP_ALLOWED_HOSTS` to allow another host name). If the model is
unreachable or rejects the request, Ceylon Buildex falls back to the composed answer and says why. Questions with no relevant passage in the dataset
are answered with "the dataset does not cover this" - the model is deliberately not allowed to fill gaps from memory.

Other settings: `OLLAMA_URL`, `LRP_ALLOWED_HOSTS`, `UPDATE_ON_START` (`0` / `first` / `always`), `OCR_LANGS` (`eng+sin+tam` once the language packs are installed), `OCR_WORKERS`, `AUTO_UPDATE_HOURS` (background refresh while the
server runs), `HOST`/`PORT`, `MAX_UPLOAD_MB`, `LRP_DATA` (data directory), `LRP_DELAY` (seconds between requests to one host).
Nightly refresh without the server: `0 2 * * * cd /path/to/ceylon-buildex && python3 -m app.ingest update`.

### If a site blocks the download
Put the PDF in `data/raw/inbox/` (or drop it on the Scan tab, or `python3 -m app.ingest add-file FILE`) - it is ingested like any other source and
survives later updates. `python3 -m app.ingest add-url URL` and `add-listing URL` register new documents / listing pages.

## Seed extracts vs full text - read this

The shipped dataset (16 documents, 46 pages) consists of **verified seed extracts**: summaries and tables prepared on 2026-10-19 from the
official documents (and the Kotte MC summary of the UDA 2021 schedules), marked `seed extract` everywhere in the UI. When `update` downloads the
real file for the same source id, the seed is replaced automatically by the full text. The build environment could not reach `.gov.lk` hosts, so
the full-text download path was tested against a local web server standing in for the official sites, not against the live sites.

## FAR: what to know

* Rules live in `data/rules/far_rules.json` (generated by `scripts/build_rules.py`); both the calculator and the seed text read the same tables.
* The **CMC 2008 plan** is shown as in effect 2008-2025 but appears on UDA's "expired" list, and the **Colombo Commercial City Development Plan
  2019-2030** keeps its regulations in a Volume III that is not in the dataset. FAR is therefore *not* calculated for the 2019 plan - confirm the
  governing plan with the UDA / CMC. Every result carries this caveat.
* **Printed anomalies:** four cells of the UDA Form A table break the table's own pattern (e.g. band 3.75-4.00, 375-500 m², 9 m road = 5.4 but
  12 m road = 5.2). They were re-checked against the source summary and are kept as printed; the calculator warns when a result lands on one.
  The source used is a summary of the gazette, not the gazette itself - check critical figures against Gazette 2235/54.
* Boundary values (e.g. exactly 500 m²) use the lower band and say so; 40 ft is accepted as the 12.2 m street width; parking floors are excluded from the FAR count as the regulation provides.
* The zone factor of a parcel comes from the zoning map / UDA clearance and cannot be derived from an address.

## Tests

```bash
pip install -r requirements-dev.txt
python3 -m unittest discover -s tests -t .        # 115 tests: FAR engine, OCR, ingest, downloader/update (local server), API, settings, LLM (mock endpoints), highlight markers, Ollama start-up (fake `ollama`), launcher (fake browser)
python3 tests/ui_smoke.py "" shots/      # headless-browser test (about 285 checks): starts its own server; desktop, phone, 2000 px wide, dark mode, reduced motion; fixed type, equal-height panels, spacing, centred start line, library map (nodes inside boxes, triangle mesh with no crossings, relations), accent colour, Settings, highlights, streamed progress
```

What the tests do and do not prove: OCR is tested on PDFs rendered from the real regulation wording (a *synthetic* scan, 100 % word recall),
not on real scanned gazettes; the LLM path is tested against mock Anthropic / OpenAI-compatible endpoints (request shape, grounding prompt, fallback),
not a live model - the first real Claude call happens when you press Save & test. The Ollama start-up is tested against a stand-in `ollama` script, never the real
program or model. The browser test is headless Chromium only (not Edge, Firefox or Safari), and the Windows parts are untested (see above).

## Layout

```
launcher.py CeylonBuildex.spec CeylonBuildex.pyw VERSION   the desktop program and its PyInstaller recipe
app/        config, db (SQLite + FTS5), ocr, extract, downloader, ingest (CLI), retrieval, far, llm, ollama_boot, winquiet, highlight (key-fact markers), server (Flask)
web/        index.html (shell + icon sprite), css/app.css (type system, panels, controls), css/matrix.css (library map), js/*.js (ES modules: ask, far, library, matrix, ocr, update, settings, reader ...; accent.js is a small classic script loaded first so the saved colour is there at first paint), fonts/ (Anton, Inter, OFL)
config/     sources.json  - 30 registered documents + 7 listing pages to scan
data/       dataset.sqlite, dataset.jsonl, documents.json, rules/far_rules.json, seed/, raw/ (downloads, inbox/)
scripts/    build_rules.py, make_seed.py, build_exe.py, smoke_exe.py
assets/     icon;   .github/workflows/build-exe.yml
tests/      unittest suite + ui_smoke.py
```

API (all JSON): `POST /api/ask` (one reply) and `POST /api/ask/stream` (NDJSON progress events, used by the page), `GET /api/search`, `/api/docs`, `/api/doc/<id>`, `POST /api/far/calc`, `/api/far/parse`, `GET /api/far/options`,
`POST /api/ocr` + `GET /api/task/<id>`, `POST /api/update` + `GET /api/update/status`, `POST /api/sources/add-url`, `GET /api/sources`, `GET /api/export/dataset.jsonl`.

Information only - not legal, planning or procurement advice. Confirm any figure with the UDA, the local authority or the procuring entity.
