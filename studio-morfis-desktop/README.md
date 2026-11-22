# Studio Morfis for Windows

This is the Studio Morfis practice dashboard as an installable Windows program. Everything the web dashboard does works here too:

- projects and their seven stages
- the task board and Gantt chart
- the all-projects timeline and the week ahead
- milestones, invoices, receipts and retainage
- reminders, the team list, project codes and invoice details

On top of that, the desktop app adds:

- **Files:** real project folders on this computer, with status on every folder.
- **Invoices & quotes:** a document editor for quotations and invoices.
- **Automations:** rules and a private AI assistant that runs on this computer.

All data stays on the computer.

## Design

**Two styles**, chosen in Settings > Desktop app > Look > Style. Both have a dark and a light theme.

- **Mono** (the default): light grey paper, ink-black type and buttons, grey for everything secondary.
  - **Type:** heavy, tightly set headings with the second half in grey ("Studio **overview**").
  - **Shapes:** pill-shaped buttons, filters and tags. The main action is an ink pill with its icon in a paper circle.
  - **Colour:** the only colour is a small yellow dot, on the app name and on projects in progress; red and amber are kept for warnings.
  - **Folders:** flat, coloured by status (yellow in progress, ink when completed, white in the dark theme, mid grey on hold, light grey upcoming, cancelled and the numbered standard folders), with one bold label along the bottom-left: `.ongoing`, `.completed`, `.on hold`, `.upcoming`, `.cancelled`, or the folder's number. The same drawing appears in Files, on the project cards and in File Explorer, where it follows Windows' light or dark mode.
- **Graphite:** the dark graphite look described below, with an accent colour of your choice.


- **Colours and type:** a graphite dark theme (and a matching light theme), Inter type bundled with the app, and one accent colour you choose with the built-in colour picker. Accent buttons are flat, with a slim accent border. Borders are 1 px and corners use four radii: 6, 8, 12 and 14 px.
- **Background:** a fine dot grid, and a soft accent light that follows the pointer and lights up the dots under it. Both can be turned off in Settings > Desktop app.
- **Sidebar:** Workspace and Studio groups, and the active projects. Each project has a coloured square showing its status and current stage. The button at the top, or Ctrl+B, narrows the sidebar to icons. Ctrl+K jumps to the search box.
- **Window bar:** the app icon, its name and where you are. Minimize, maximize/restore and close sit on the right in the Windows style; *Soft pill* and *Round* (three coloured dots, also on the right) are other styles in Settings. Dialogs and side panels open below the window bar.
- **Motion:** short fades of about 0.2 s, with no bounce, spin or wobble. *Reduce motion* turns it all off.

## Project status

Every project has one work status:

| Status | Meaning |
|---|---|
| **Not started** | Signed or planned, work has not begun |
| **In progress** | Work is under way |
| **On hold** | Paused: waiting on the client, approvals or funds |
| **Completed** | Handed over and closed |
| **Cancelled** | Stopped and will not continue |

You change it from a project's tag in Files, on the project page, or from a folder card's menu. The status shows as a tag beside the stage, as a badge on the folder artwork, and on the sidebar square. If the folder-icon automation is on, it also shows on the project folder's own icon in File Explorer, with the status as the folder's tooltip.

## Files

- **Left:** the folder structure. Projects (all of them by default, or filtered by status) open into their standard folders. Imported folders come in as Completed unless you pick another status; when a filter is empty, Files and Projects say so and offer to show everything.
- **Right:** large folder cards. Each project card shows its status badge, the kinds of files inside (PDF, DWG, JPG…), and status and stage tags. Below them is a table of recent files with coloured file-type icons.
- **Inside a folder:** subfolders as cards, then the files.
- **Working with files:** open, show in Explorer, copy the path, or move to the Recycle Bin. Drop files from Explorer onto any folder to copy them in.

## Project folders: setup, rename, delete

**Files → Folder setup** decides which folders every project root gets:

- **On or off:** turn any of the six standard folders (01 to 06, the ones automatic sorting knows) on or off.
- **Names:** change a folder's name in the app and its name on disk.
- **Order:** reorder the folders.
- **Your own folders:** add folders of your own; they are numbered 07, 08 and so on.
- **Existing projects:** saving can create the new folders in existing projects and rename changed folders on disk to match.

Turning a folder off stops it being created; folders already on disk are left alone, and sorting never moves files into a folder that is off. The setup is part of the studio settings, so it is included in backups.

Every folder card has a three-dot menu:

- **Project folder:** open, change status, File Explorer, rename on disk, copy path, read again, redraw icons, sort loose files, folder setup, delete the project folder. Deleting moves it to the Recycle Bin and the project itself stays.
- **Standard folder:** open, File Explorer, add files, new folder inside, copy path, redraw icon, rename (in every project), delete this project's copy (optionally stop creating it).
- **Subfolder:** open, File Explorer, rename with undo, copy path, delete to the Recycle Bin.

## Folder icons in File Explorer

The folders you see in Files are the icons the real folders get in File Explorer, drawn by the same code:

- **Project folders:** the status badge.
- **The six standard folders:** their number tab (01 to 06).
- **Folders with files:** paper sheets marked with the main file type (PDF, DWG…).

The tooltip shows the status, project code and stage, or the folder name and file count. Icons follow every change within a few seconds. Explorer is told straight away, so open windows refresh without pressing F5. Turning the automation off removes the icons again. Folders that already had their own `desktop.ini` (the old blue icons, for example) get the new icon too; their old `desktop.ini` is kept as a hidden `desktop.ini.morfis.bak` and put back when the automation is turned off.

Completed folders are moss green. Explorer icons follow Windows' light or dark mode.

## Built-in preview

Click a file in Files (or press Space) to look at it without leaving the app. Arrow keys move through the files on screen, Enter opens the file in its own program, and Esc closes the preview.

| Kind | Preview |
|---|---|
| Images (JPG, PNG, GIF, WebP, BMP, SVG, AVIF, ICO) | Zoom with the wheel, drag to pan, double-click for 100 %, R to rotate |
| PDF | Chromium's viewer: pages, zoom, rotate, search, print |
| Video (MP4, MOV, WebM, M4V) and audio (MP3, WAV, M4A, OGG, FLAC) | Plays in place, with seeking |
| Word (DOCX) | Rendered as a page (mammoth, BSD licence) |
| CSV, TSV | A table |
| Text and code (TXT, MD, JSON, XML, LOG, INI, LSP, SCR, …) | With line numbers; JSON is tidied |
| Everything else (DWG, SKP, RVT, PSD, HEIC, TIF, XLSX, PPTX, …) | The large thumbnail Windows itself makes for the file, plus an Open button |

The grid layout of a folder shows the same thumbnails File Explorer does. Files opened from the dashboard's own project folder lists use the preview too.

## Invoices & quotes

- **List:** every quotation and invoice. Milestone invoices issued from Payments appear automatically.
- **Editor:** the document is the A4 page it prints as. You type directly on the page: client, project, lines (description, details, quantity, unit, rate), notes and terms. The side panel sets status, project, currency, discount, tax (none, included or added) and retention, and whether bank details show.
- **Numbering:** follows the project code (`MRF I 26 I 014 I QT 01`, `… I INV 03`). Without a project it is `QT-2026-001` or `INV-2026-001`.
- **Quotations:** *Mark as sent*, then *Accepted*, then *Make the invoice* copies the lines into a new invoice. A sent quotation shows as Expired once its valid-until date passes.
- **Invoices:** *Issue invoice* on a milestone invoice adds it to Payments, so receipts and overdue tracking keep working. The Payments preview has an *Edit invoice* button that opens the same invoice here.
- **Output:** *Export PDF* (A4, Inter embedded) and *Print*. Both use the same page you edit.

## Morfis, the voice assistant

Press the microphone at the top (or **Ctrl+Space**) and speak naturally. Morfis listens, answers and speaks back. It runs on this computer: no internet, no account, no cost.

- **Listening:** Whisper (base, 8-bit), run by transformers.js in a background worker. It stops by itself when you stop talking.
- **Speaking:** Kokoro-82M (8-bit), a natural neural voice, run by ONNX Runtime. Pick the voice and speed in *Settings > Desktop app > Voice assistant*. Windows' own voice is the fallback.
- **Understanding:** requests are read from the studio's own records:
  - *Open Files*, *show me the Timeline*, *open Galle Fort*, *open the folder of Kitchen renders*
  - *What's due this week / today / tomorrow?*, *any overdue invoices?*, *how much have I received?*, *how many freelance jobs are open?*
  - *Mark Wijesinghe Residence as on hold*, *Kitchen renders is done*
  - *New freelance job for Anna called kitchen renders*, *new project*
  - *Remind me to call the client tomorrow at 10 am*, *what are my reminders?*
  - *Search for site plan*, *dark mode*, *what time is it?*

  It forgives small mishearings of names, and asks "which one?" when two match. Anything else goes to the local AI model (Ollama) when one is installed.
- **Typing:** you can also type to it in the same panel.
- **Privacy:** the microphone is used only while the orb is listening, and only by the app's own window. The models are part of the app (about 190 MB).

### What Morfis can do, and what it asks first

Morfis works the app for you. It never deletes or changes anything important without your OK, and every action is logged in Automations > Activity with Undo ("undo that").

| Does it straight away (with Undo) | Asks you first ("Shall I go ahead?": say yes, or press Yes) |
|---|---|
| Create a project: "create a project called Lake House for the Perera family with a budget of 2 million starting next Monday" (stages, 40 tasks, milestone invoices and folders) | Delete a project, job or task |
| Add a task: "add a task site survey to Lake House due Friday" | Move a whole timeline: "push Lake House back by 2 weeks", "reschedule Lake House to start on 5 January" |
| Tick a task off, change one task's date | Go back a stage |
| Move a project on: "move Lake House to the next stage" | Close a project: completed or cancelled |
| Status: in progress, on hold, upcoming | Money: issue an invoice, record a payment, change a fee or what was paid |
| Freelance: start a job, "add 4 renders to Kitchen renders", tick deliverables, change the due date | Change a project's name, client or location |
| Reminders, folders, run an automation, create a custom automation, draft a quotation | Move a project between Direct and Freelance (its folder moves) |

Requests the built-in rules don't cover go to the local AI model (Ollama), which plans them with the same tools and the same rules.

### Downloaded AI models

*Automations > AI assistant > Downloaded models* lists the Ollama models on this computer and their sizes. Each has **Delete**, which frees the disk space; it can be downloaded again any time. The voice models (Whisper and Kokoro, about 190 MB) are part of the app and are removed when it is uninstalled.

`npm run voice-test` checks the engine end to end: Kokoro says a sentence, Whisper must hear it back, and no request may leave the computer.

## Direct and freelance, everywhere

- **New project** asks first: a *Direct project* (stages, tasks, milestone invoices, six folders) or a *Freelance job* (brief, deliverables, fee, revisions).
- **Studio > Direct projects** lists the studio's own projects the way Freelance lists jobs, and each has a page with its progress, money and folder.
- **Folders in place:** a freelance job's folder and a direct project's folder are browsed on their own page. You can open folders, preview files, add files, make, rename and delete folders, without going to Files.
- **Moving between them:** *Move to Direct projects* on a job, *Move to Freelance* on a project. The folder moves to the right main folder, and every move is in the Change log.
- **Home, Projects and Timeline** show freelance jobs under way, and the sidebar's Active projects lists them with a briefcase.
- **Main folders** are named `! Direct Projects` and `! Freelance Projects`, so File Explorer lists them first when sorting by name. *Files > More > Main folder names* changes them.

## Direct Projects and Freelance Projects

**Files > Reorganise…** splits the main projects folder once:

- **Direct Projects:** every project that is not completed moves here, renamed to the project naming. New projects are made here.
- **Freelance Projects:** every completed project becomes a freelance job (its project record is kept inside the job). Its folder moves here as `FL I 26 I 046 I Title` (or keeps its code), and what is inside is sorted into 01_Brief_and_References, 02_3D_Models, 03_Drawings, 04_Renders and 05_Delivered. Freelance jobs made before move here too.
- **Left alone:** folders not named like a project (LIBRARY, Documentation…) are never moved or sorted.
- **Undo the reorganisation** in Files puts the folders, projects, jobs and settings back.

Files shows both groups in its tree and grid, and freelance job folders are browsed the same way as project folders.

## Change log, and folders that are not projects

Every change the app makes to real folders is logged first: folders made, files copied, sorted, moved or renamed, and items recycled. **Files > Change log** lists the last 90 days, newest first, each with Undo. A folder's card menu has *Change log for this folder*.

**Folders that are not projects** (from the note in Files, the Change log, or *This is not a project…* on a card) takes back what the app did to a folder brought in by Import that is not a project:

- Its folder icons come off, and its own icon returns.
- Every logged change inside it is undone, newest first: sorted files go back and a rename is reversed.
- The empty standard folders are removed.
- It leaves Projects. Nothing of yours is deleted, and Import and Reorganise leave it alone afterwards.

A project with no folder (a draft) can be removed with *Delete the project…* on its card.

## Freelance jobs

Online jobs (Fiverr, Upwork, a direct client) run differently from studio projects: a client's brief comes in and 3D models, drawings and renderings go out, with no stages, task timeline or six-folder structure. **Studio > Freelance** keeps them apart:

- **Job:** code `FL I 26 I 001`, title, client, contact, platform, the client's brief, received and due dates, status, fee, currency and what has been paid.
- **Deliverables:** a checklist of 3D models, drawings, renderings or anything else, each with a quantity. The card shows how many are delivered.
- **Revisions:** how many are included and how many have been used.
- **Folder:** `Projects/Freelance/<code I title>` with 01_Brief_and_References, 02_3D_Models, 03_Drawings, 04_Renders and 05_Delivered. It gets the status folder icon like project folders.
- **Invoice:** *Make the invoice* opens a new invoice with the client and fee filled in.
- **Reminders:** the *Freelance deadlines* automation warns two days before a job is due, on the day, and when it is late.
- **Moving a project:** a project card's menu has *Move to Freelance…*, which turns a dashboard project into a job.

## Automations and the AI assistant

The assistant runs on this computer with **[Ollama](https://ollama.com)**, which is free and open source (MIT licence), and an open model. The default is **Qwen 2.5 3B** (Apache 2.0, about 1.9 GB). There is no account and no fee, and nothing is sent online. The app only talks to `127.0.0.1`.

Setup is done once:

1. Install Ollama from ollama.com.
2. In Automations, press **Download qwen2.5:3b**.

The automations:

| Automation | Kind | What it does |
|---|---|---|
| Draft the invoice when a stage is reached | Rule | When a project reaches a billed stage, it prepares a draft invoice and sends a Windows notification |
| Payment follow-ups | AI | Writes a reminder email for each overdue invoice, at most once a week each. You review it, then copy it or open it in your email program |
| Monday studio summary | AI | Overdue money, late and upcoming tasks, quotes waiting for an answer, and on-hold projects, as a notification and on the Automations page |
| Status on Windows folder icons | Rule | Keeps each project folder's Explorer icon and tooltip matched to its status |
| Sort files the rules cannot place | AI | In Files, *Sort with AI* suggests a standard folder for odd file names. You untick anything that should stay, and the move can be undone |
| Quotation assistant | AI | In a quotation, describe the job and get lines, quantities and rates based on your past fees |
| Quotations about to expire | Rule | Three days before a sent quotation runs out, and when it has expired: a notification and a to-do |
| Morning task check | Rule | Once a day, a notification with the tasks that are late or due today |
| Projects on hold for a month | Rule | A to-do to restart, keep waiting or close a project that has been On hold for 30 days |
| Keep folder counts up to date | Rule | Reads the active project folders again every 15 minutes |

### Your own automations

**New automation** builds a rule as *When … Then …*, or starts from an example (close-out checklist, firm reminder after 14 days overdue, heads-up before a task is due, chase a quotation, Friday wrap-up and more).

- **When:** a project's status changes; a project reaches a stage; a milestone is ready to invoice; an invoice is overdue by N days; a task is due within N days; a quotation expires within N days; every day; every week on a chosen day. It can be limited to projects with one status.
- **Then:** a Windows notification; a reminder under the bell; a to-do under *Waiting for you*; an email draft to the client (the assistant can polish it); set the project's status; or ask the AI assistant.
- **Messages:** can use `{project}`, `{code}`, `{client}`, `{stage}`, `{status}`, `{invoice}`, `{amount}`, `{due}`, `{days}`, `{task}`, `{quote}`, `{studio}` and `{date}`.

Each one fires once per project, invoice, task or day. Things that are already true when you create it count as seen, so it never fires for every old item at once.

Everything an automation makes waits for your review under *Waiting for you*. When the assistant is not available, the follow-ups and the summary use plain templates instead.

## Phone access and the Android app

The Android app shows this computer's Studio Morfis on a phone: projects, stages, tasks, payments, invoices and quotations, Files with the real folders on this computer, Automations and Settings. Changes made on the phone are saved on the computer and appear in the desktop window straight away, and the other way round.

**Turn it on:** Settings > Desktop app > Phone access > *Allow phones to connect*. The first time, Windows may ask whether the app may use the network: allow it on private networks.

**Connect a phone:**

1. Install `Studio-Morfis-<version>.apk` on the phone. Android asks once to allow installing apps from that source.
2. Open the app on the same Wi-Fi. The computer shows up in the list; if it does not, type the address shown in Phone access (for example `192.168.1.20:47820`).
3. Type the six-digit PIN shown on the computer, and give the phone a name.

The phone stays paired. Phone access lists the paired phones, shows which are connected, and can remove any of them. A phone browser also works: open the address and type the PIN.

**How it works on the phone:**

| Action | Where it happens |
|---|---|
| Choosing files to add to a folder | They are sent from the phone to the computer |
| Exports and PDFs | They download to the phone (Downloads/Studio Morfis) and open in its viewer |
| Opening a file | It downloads to the phone and opens there |
| Opening a folder | It opens in File Explorer on the computer |
| Choosing a folder (for example the projects root) | You browse the computer's folders from the phone |
| Automations | They run on the computer only, so nothing happens twice |

**Offline:** the Android app keeps working with no connection.

- **What the phone keeps:** a copy of the projects, documents and settings, and every project folder's names, sizes and dates. It never copies the files themselves.
- **Changes while offline:** rename, move and delete files and folders, make new folders, add files from the phone (kept on the phone until they can be sent), and edit projects, tasks, payments and invoices.
- **The notice:** a small notice at the top says the phone is offline and how many changes are waiting.
- **Coming back:** when the computer answers again, the changes are sent in the order they were made, and the copy is refreshed.
- **Changed on both:** a record changed on the phone and on the computer is merged item by item. Where the same item changed on both, the computer's version is kept and a short report says what.
- **Needs the computer:** opening or previewing a file (only names are kept), exports, and the AI assistant.
- **Several computers:** each one the phone pairs with has its own copy. The copy survives the computer's address changing.

**Safety:** it is off until you turn it on.

- **Pairing:** a phone needs the PIN once. Five wrong tries replace the PIN, and only a hash of each phone's key is kept on the computer.
- **Network:** traffic is plain HTTP on the local network, so use it on a network you trust (home or office Wi-Fi). To reach the computer from elsewhere, use a private VPN such as Tailscale or WireGuard and type the computer's VPN address. Do not forward the port on your router.

The Android app's source is in `studio-morfis-android/`; GitHub Actions builds the APK (*Build Studio Morfis for Android*).

## Run and build

You need Node.js 22.

```bat
cd studio-morfis-desktop
npm install
npm start            :: run it
npm run check        :: confirm the dashboard still matches the desktop patch
npm run dist         :: build dist\Studio-Morfis-Setup-<version>.exe (on Windows)
```

The GitHub Actions workflow *Build Studio Morfis for Windows* runs on every push to the `claude/studio-morfis-*` branches that touches this folder, and on pull requests. It runs the checks and the smoke test on Windows, then uploads the installer and screenshots.

## Where things are kept

Everything is under `%APPDATA%\Studio Morfis\`:

| Path | What |
|---|---|
| `data\settings.json` | Studio settings |
| `data\projects\` | One file per project |
| `data\documents\` | One file per quotation or invoice |
| `data\automations.json` | Automation state: drafts made, follow-ups, the latest summary |
| `backups\` | A dated copy of everything, once a day |
| `journals\` | Records of sorts, renames and moves, so they can be undone |
| `branding\` | Your custom app icon (`.png`, `.ico`) |
| `folder-icons\` | The status icons that project folders point to |
| `desktop.json` | Desktop settings |
| `phone-access.json` | Paired phones (names and key hashes) |
| `phone-transfer\` | Files on their way to or from a phone, cleared after a day |

## How it is put together

```
src/dashboard/dashboard.html   the web dashboard, unchanged
src/shell/main.js              window, splash, tray, and the API the page calls
src/shell/patch.js             turns the web page into the desktop page (window bar, sidebar slot, hook, assets)
src/shell/ai.js                the local AI engine (Ollama on this computer)
src/shell/folder-icons.js      status icons on project folders (desktop.ini)
src/shell/fsops.js             folder reading, sorting, moves, undo journals, Recycle Bin
src/shell/branding.js          app name and icon in Windows
src/shell/remote.js            phone access: pairing, the page and API for phones, live changes, finding the computer
src/shell/store.js             projects, documents, automation state, daily backups
src/shell/renderer/theme.css   the design system over the dashboard's tokens
src/shell/renderer/desktop.*   sidebar, router, window bar, Settings > Desktop app
src/shell/renderer/files.js    Files
src/shell/renderer/docs.js     Invoices & quotes and the A4 editor
src/shell/renderer/automations.js  Automations
src/shell/renderer/folder-art.js   status, folder artwork, file-type and Explorer icons
src/shell/renderer/remote-bridge.js  the phone page's connection to the computer (uploads, downloads, live changes)
src/shell/renderer/remote.*    the phone layout: menu drawer, Back button, this phone in Settings
scripts/smoke.js               starts the app and tests views, folders, editor, AI paths, PDF and branding
```

The page reaches the dashboard's own data and functions through a small hook that `patch.js` adds. That's why Files, the editor and the automations always show the same projects and invoices as the rest of the app. To update the dashboard, replace `dashboard.html` and run `npm run check`.
