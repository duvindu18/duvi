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

- **Colours and type:** a graphite dark theme (and a matching light theme), Inter type bundled with the app, and one accent colour you choose. Borders are 1 px and corners use four radii: 6, 8, 12 and 14 px.
- **Sidebar:** a workspace header, search (Ctrl+K), Workspace and Studio groups, and the active projects. Each project has a coloured square showing its status and current stage. Ctrl+B narrows the sidebar to icons.
- **Window bar:** the app icon, its name and where you are. Minimize, maximize/restore and close sit on the right in the Windows style; *Soft pill* and *Round, left* are other styles in Settings.
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

- **Left:** the folder structure. Projects (filtered by status) open into their six standard folders.
- **Right:** large folder cards. Each project card shows its status badge, the kinds of files inside (PDF, DWG, JPG…), and status and stage tags. Below them is a table of recent files with coloured file-type icons.
- **Inside a folder:** subfolders as cards, then the files.
- **Working with files:** open, show in Explorer, copy the path, or move to the Recycle Bin. Drop files from Explorer onto any folder to copy them in.

## Invoices & quotes

- **List:** every quotation and invoice. Milestone invoices issued from Payments appear automatically.
- **Editor:** the document is the A4 page it prints as. You type directly on the page: client, project, lines (description, details, quantity, unit, rate), notes and terms. The side panel sets status, project, currency, discount, tax (none, included or added) and retention, and whether bank details show.
- **Numbering:** follows the project code (`MRF I 26 I 014 I QT 01`, `… I INV 03`). Without a project it is `QT-2026-001` or `INV-2026-001`.
- **Quotations:** *Mark as sent*, then *Accepted*, then *Make the invoice* copies the lines into a new invoice. A sent quotation shows as Expired once its valid-until date passes.
- **Invoices:** *Issue invoice* on a milestone invoice adds it to Payments, so receipts and overdue tracking keep working. The Payments preview has an *Edit invoice* button that opens the same invoice here.
- **Output:** *Export PDF* (A4, Inter embedded) and *Print*. Both use the same page you edit.

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

Everything an automation makes waits for your review under *Waiting for you*. When the assistant is not available, the follow-ups and the summary use plain templates instead.

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

## How it is put together

```
src/dashboard/dashboard.html   the web dashboard, unchanged
src/shell/main.js              window, splash, tray, and the API the page calls
src/shell/patch.js             turns the web page into the desktop page (window bar, sidebar slot, hook, assets)
src/shell/ai.js                the local AI engine (Ollama on this computer)
src/shell/folder-icons.js      status icons on project folders (desktop.ini)
src/shell/fsops.js             folder reading, sorting, moves, undo journals, Recycle Bin
src/shell/branding.js          app name and icon in Windows
src/shell/store.js             projects, documents, automation state, daily backups
src/shell/renderer/theme.css   the design system over the dashboard's tokens
src/shell/renderer/desktop.*   sidebar, router, window bar, Settings > Desktop app
src/shell/renderer/files.js    Files
src/shell/renderer/docs.js     Invoices & quotes and the A4 editor
src/shell/renderer/automations.js  Automations
src/shell/renderer/folder-art.js   status, folder artwork, file-type and Explorer icons
scripts/smoke.js               starts the app and tests views, folders, editor, AI paths, PDF and branding
```

The page reaches the dashboard's own data and functions through a small hook that `patch.js` adds. That's why Files, the editor and the automations always show the same projects and invoices as the rest of the app. To update the dashboard, replace `dashboard.html` and run `npm run check`.
