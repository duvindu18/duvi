# Ceylon Buildex

A search-first web portal that answers questions about **Sri Lankan building regulations, planning gazettes and public-procurement
Standard Bidding Documents (SBDs)** from a single searchable dataset - with citations, a **Floor Area Ratio (FAR) calculator**
driven by zone functions and the Colombo Municipal Council (CMC) / UDA rules, fast OCR, and a one-click updater.

```
CeylonBuildex-Setup-1.2.0.exe   # Windows: install, then start Ceylon Buildex from the Start menu (see "The desktop program")
./run.sh            # Linux / macOS / WSL -> http://127.0.0.1:8080
./run.sh update     # download / refresh every registered source
```

## What it does

| Page | What you get |
|---|---|
| **Ask** | Searches the dataset first, runs the FAR rules engine if the question is about floor area, then an LLM writes the reply *only from the retrieved passages* with `[S1]`-style citations. No LLM key? It falls back to quoting the best-matching passages (extractive mode). Nothing relevant? It says so - no guessing. |
| **Floor area** | Two regimes: **CMC area** (City of Colombo Development Plan 2008: zones, Form C1 FAR by land extent and street width, Form C2 coverage/spaces, Concentrated Development table) and **UDA 2021** (Gazette 2235/54 Schedule 6: Forms A-E by zone factor / density, land extent and road width). Shows the table row used, max floor area, coverage, spaces, checks against a proposed design, warnings and the legal-status caveat. |
| **Library** | Every source in a **matrix of kind x year** (or a plain list), with its real relations drawn on demand and an inspector beside it. Status, origin (full text vs seed extract) and a page-level reader. |
| **Scan** | Drop a scan or photo: text-layer pages are used as they are; image-only pages go to Tesseract in parallel (170 dpi fast / 300 dpi accurate), cached by content hash, rotation retry for low-confidence pages, garbled legacy-font text layers detected and re-OCR'd. Option to add the result to the dataset. |
| **Update** | Downloads every source in `config/sources.json` with conditional GET (ETag / Last-Modified / SHA-256, PDF validation), scans listing pages (UDA, documents.gov.lk, Treasury, CIDA) for new documents, OCRs what needs it, rebuilds the dataset and exports `data/dataset.jsonl`. |

## The interface

A quiet dark workspace (a light theme is one click away), one typeface (Inter, bundled) and one accent colour used sparingly: the live state, a key fact, the page you are on.

**The frame.** A **sidebar** on the left holds *New question*, the five places (Ask, Floor area, Library, Scan, Update), your **recent questions** and Settings; it collapses to icons
(remembered) and becomes a drawer on a phone. The workspace is a rounded panel whose **top bar** names the page you are on (and, in the desktop program, is the window's title bar).
A slim **status bar** along the bottom says what the program knows right now, each item with its icon and each a shortcut: the dataset (documents and passages), OCR and its languages,
who writes the answers (or "Quoting passages"), the last update (a spinning icon while one runs), the keyboard shortcuts, a light/dark switch and the version.
The browser window never scrolls: each page scrolls inside its own pane.

**Ask is a conversation.** The empty page greets you with a short line, four example questions and the question box in the middle; the first question moves the box to the bottom.
The box grows with what you type; beside it sit *attach a scan* (opens Scan), *search within* (one kind of document, or all) and *Answer / Passages* (with *Hide superseded* in
Passages mode). Enter asks, Shift+Enter adds a line, Esc stops, `/` jumps to the box from anywhere.

Your question appears as a bubble on the right. The assistant's reply starts with **thinking out loud**: a glowing orb, a shimmering *Thinking* with a live timer, and a timeline of
steps, each the moment the server really reports it (`parse`, `far`, `search`, `found`, `write` on `POST /api/ask/stream`):

| Step shown | When the server has really... |
|---|---|
| Reading your question | started to parse it |
| Calculating the floor area ratio | found complete FAR inputs and started the rules engine (only then) |
| Searching the library · *340 passages in 16 documents* | started the search, over exactly that many passages |
| Found 7 passages · *in 3 documents*, with the documents named as chips | finished the search (the names are the documents the answer then cites) |
| Writing the answer · *with model* (an elapsed counter after 4 s) / Composing the answer | started the language model / composed the answer without one |

Each step stays on screen for a short beat (about half a second) so the sequence reads smoothly instead of flashing past; a "Working" row with typing dots marks that more is coming.
Nothing is invented: no step appears that the server did not report, and when the answer lands the panel folds into **Thought for 1.4 s**, the real time the work took (click to open it again).
With `prefers-reduced-motion` the steps appear without the pause and nothing moves.

The **answer** follows, paragraph by paragraph, with the facts a reader must not miss under a soft highlighter, `[S1]`-style citation chips, a FAR card when the question was about floor area,
and the **sources as cards** below (number, title, page, gazette, status; a chevron shows the excerpt; a click opens the reader at that page). A row of small icons copies the answer
(plain text with the sources), asks again or edits the question, and says how it was made ("Written by ..." or "Compiled from the passages", the number of sources, the time).
A failed or stopped question says so in the thinking header and offers Retry. *New question* starts over.

**The library matrix.** Above it, the library in numbers (documents with a bar of their status, pages, how many are full text, the last update). The matrix itself has **one row per kind of
document and one column per year** (plus *Undated*), so where a document sits *is* its data. Each document is a chip with a status mark (current, to verify, superseded, reference; its size
follows the page count) and a short name (its gazette number, else the first words of its title); a dashed chip is a summary, not the full text. Point at, focus or tap a chip and its row and
column light up, its **real relations** are drawn as curves (same gazette or supersedes in the accent colour, same authority or website in grey; nothing is inferred from titles),
everything else dims, and the **inspector** shows what it is, where it comes from and what it relates to. The inspector floats beside the chip and stays while you move onto it; a click
keeps it, a second click (or double-click, or Enter) opens the document; on a screen 1560 px or wider it is docked beside the matrix. Category chips and the filter box dim what does not
match; arrow keys move between documents. A plain **list** is one click away.

**Floor area, Scan, Update** keep every earlier feature in the same panels, restyled. **Settings** (a dialog; a bottom sheet on a phone) holds *Appearance* (Dark, Light or System, and
an accent colour: seven presets or any colour) and *Written answers* (Claude, any OpenAI-compatible server or local model, Automatic, or Off). Choices are remembered in this browser;
keys are sent to the server, kept in `data/settings.json` (private file) and never sent back to the page.

## The desktop program (Windows, with an installer)

**Install:** run `CeylonBuildex-Setup-1.2.0.exe`. It asks where to install (per user by default, no administrator rights needed; it can install for all users),
adds Start menu and desktop shortcuts and an uninstaller (Settings > Apps), and starts the program when it is done. **Everything the program needs is inside it:**
Python and the portal, Tesseract OCR with English, Sinhala and Tamil, and Poppler for PDFs - nothing else is downloaded or installed. Only the optional local
model (Ollama, see below) is separate. Reinstalling or upgrading keeps your data; the uninstaller asks whether to delete it too.

**The window.** Ceylon Buildex opens in its own window with no system title bar: the portal's top bar *is* the title bar. The wordmark and the links sit where they
always do, and **minimize, maximize/restore and close** sit at the right edge as round 36 px buttons in the page's own style - ink on the page, a soft accent tint on
hover, and the accent colour behind close - 4 px apart, 12 px from the edge, behind a hairline divider, centred on the links. They follow the theme (light, dark, system)
and the accent colour you pick in Settings, and dim when the window is not active. Drag the bar to move the window, double-click it to maximize, and Windows snap,
resizing from every edge and the Windows 11 rounded corners all work as usual. F11 is full screen; Ctrl + / Ctrl - / Ctrl 0 zoom.

**Start-up.** The window appears at once, in the theme and accent colour you used last, with a short *Opening...* screen while the back end starts
(usually under a second; the very first start prepares the dataset). If it cannot start, the same screen says why, with *Try again* and *Open the log folder*.
Opening the program again while it runs brings its window to the front. Closing the window stops everything it started (the back end, and an Ollama it started);
if the window process is killed, the back end notices and stops by itself. Window size, position and the maximized state are remembered.

Data lives in `%LOCALAPPDATA%\CeylonBuildex` (documents, the dataset, settings, `logs\launcher.log`; set `LRP_HOME` to move it). Links to other sites open in your browser.

How it is built: `desktop/` is a small [Electron](https://www.electronjs.org/) window (`main.js`, `preload.js`, the start-up screen `loading.html`) with
`titleBarStyle: "hidden"`; the page draws the buttons (`web/js/window.js`) and asks the window to act through a sandboxed, minimal bridge (`window.cbDesktop`).
The back end is `launcher.py --desktop`, frozen with PyInstaller as a folder (`dist/CeylonBuildexServer/`) - a folder starts much faster than a one-file program,
which unpacks itself to a temporary folder on every start. The window starts it on a fixed local port (47319, so the page's saved choices persist), and stops it with
a request that carries a secret token only the window knows; the back end also watches the window's process id. electron-builder (NSIS) makes the installer.

**Building it** (Windows only - PyInstaller and the installer are made on the system they are for):

* **GitHub Actions:** `.github/workflows/ceylon-buildex-installer.yml` runs on every push that touches `ceylon-buildex/`: unit tests and the browser test on Linux,
  then on `windows-latest` it builds the back end and the installer, smoke-tests the back end, **installs the Setup program silently, starts the installed program,
  presses its title-bar buttons (maximize, restore, minimize, a second start brings it back, close), checks closing it stops the back end, and uninstalls it**.
  The Setup program is attached to the run as the artifact *CeylonBuildex-Setup*.
* **On your own Windows PC:** install Python 3.12, Node.js 22 and the OCR tools once (`winget install UB-Mannheim.TesseractOCR oschwartz10612.Poppler`), then
  `pip install -r requirements.txt pyinstaller` and `python scripts/build_installer.py` -> `dist/installer/CeylonBuildex-Setup-1.2.0.exe`.
* **Developing the window:** `cd desktop && npm ci && npm start` runs it against the Python sources (`CB_PYTHON` picks the interpreter).
* **No build at all:** double-click `CeylonBuildex.pyw` (needs Python); it opens the portal in an Edge/Chrome app window as before (system title bar).

The installer and the program are **not code-signed**, so Windows SmartScreen may show "Windows protected your PC" the first time; choose *More info*, then *Run anyway*.

> **Tested vs not tested.** Here (Linux): the back end's desktop mode (serves on its port, refuses a quit without the token, quits with it, quits when the window's
> process ends, will not drift to another port), the title bar in headless Chromium (sizes, spacing, alignment, drag regions, hover colour, maximize/restore icon,
> inactive state, dialogs, light/dark/minimum size), and the real Electron window under a virtual display (start-up screen, portal, theme remembered across starts,
> external links opened outside, the error screen, close and kill both stopping the back end). Maximize itself needs a window manager, so it is checked on the
> Windows runner. The Windows parts (the frozen back end, the installer, the installed program and its buttons) are exercised by the workflow above.

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
| **Windows** | `CeylonBuildex-Setup-1.2.0.exe` | Everything is inside the installer - see above |
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
python3 -m unittest discover -s tests -t .        # 121 tests: FAR engine, OCR, ingest, downloader/update (local server), API, settings, LLM (mock endpoints), highlight markers, Ollama start-up (fake `ollama`), launcher (fake browser) and its desktop back-end mode
python3 tests/ui_smoke.py "" shots/      # headless-browser test (276 checks: frame, conversation and thinking steps fed event by event, library matrix, phone drawer, themes, desktop title bar); starts its own server
```

What the tests do and do not prove: OCR is tested on PDFs rendered from the real regulation wording (a *synthetic* scan, 100 % word recall),
not on real scanned gazettes; the LLM path is tested against mock Anthropic / OpenAI-compatible endpoints (request shape, grounding prompt, fallback),
not a live model - the first real Claude call happens when you press Save & test. The Ollama start-up is tested against a stand-in `ollama` script, never the real
program or model. The browser test is headless Chromium only (not Edge, Firefox or Safari), and the Windows parts are untested (see above).

## Layout

```
launcher.py CeylonBuildex.spec CeylonBuildex.pyw VERSION   the back end of the desktop program and its PyInstaller recipe
desktop/    the window (Electron: main.js, preload.js, loading.html) and the installer recipe (package.json "build", build/installer.nsh)
app/        config, db (SQLite + FTS5), ocr, extract, downloader, ingest (CLI), retrieval, far, llm, ollama_boot, winquiet, highlight (key-fact markers), server (Flask)
web/        index.html (frame + icon sprite), css/app.css (tokens, frame, controls, conversation), css/matrix.css (library), js/*.js (plain ES modules, no build step: ask, far, library, matrix, ocr, update, settings, reader, window ...; accent.js loads first so the saved colour is there at first paint), fonts/ (Inter, SIL OFL 1.1, bundled: no page asks another site for anything)
config/     sources.json  - 30 registered documents + 7 listing pages to scan
data/       dataset.sqlite, dataset.jsonl, documents.json, rules/far_rules.json, seed/, raw/ (downloads, inbox/)
scripts/    build_rules.py, make_seed.py, build_exe.py (back end), build_installer.py (Setup program), smoke_exe.py
assets/     icon;   the build workflow is ../.github/workflows/ceylon-buildex-installer.yml
tests/      unittest suite + ui_smoke.py
```

API (all JSON): `POST /api/ask` (one reply) and `POST /api/ask/stream` (NDJSON progress events, used by the page), `GET /api/search`, `/api/docs`, `/api/doc/<id>`, `POST /api/far/calc`, `/api/far/parse`, `GET /api/far/options`,
`POST /api/ocr` + `GET /api/task/<id>`, `POST /api/update` + `GET /api/update/status`, `POST /api/sources/add-url`, `GET /api/sources`, `GET /api/export/dataset.jsonl`.

Information only - not legal, planning or procurement advice. Confirm any figure with the UDA, the local authority or the procuring entity.
