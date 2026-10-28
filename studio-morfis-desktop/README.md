# Studio Morfis for Windows

This is the Studio Morfis practice dashboard as an installable Windows program. Everything the web dashboard does works here too:

- projects and their seven stages
- the task board and Gantt chart
- the all-projects timeline and the week ahead
- milestones, invoices (with PDF export), receipts and retainage
- reminders, the team list, project codes and invoice details
- the Folder Hub

The desktop version also works on real folders on your computer:

- It creates the six standard folders for each project.
- It reads what's inside them and imports folders you already have.
- It sorts loose files into the right folder (and can undo the sort).
- It can rename, move and recycle files from inside the app.
- It can pin a project's site on a map.

All data stays on the computer.

## What the desktop shell adds

| | |
|---|---|
| **App name and icon** | Change them under Settings → *App name and icon*. The window title, title bar, taskbar button and tray icon change immediately. The Start menu entry, desktop shortcut, pinned taskbar shortcut and the entry in *Settings → Apps* are renamed and re-iconed too. A `.ico` is generated from your picture. |
| **Window buttons** | Custom minimize, maximize/restore and close buttons on the right that follow the theme and accent colour. There are three styles: *Studio* (a soft pill; hover tints with the accent, close turns red), *Windows* (flat, flush with the corner) and *Round, left* (coloured dots). Double-click the title bar to maximize. |
| **Loading animation** | While the dashboard opens, a short splash card shows your icon inside a drawn ring, your app name, and the seven stage marks filling in. It uses your theme and accent and can be turned off. |
| **Settings → Desktop app** | Window: button style, title bar, always on top, remember size and position. Starting and closing: loading animation, open when Windows starts, start minimised, close to the notification area, ask before quitting. Look: four font choices, drawing-grid background, accent glow, rounded or tight corners, reduce motion. System: spell check, a show/hide hotkey (Ctrl+Alt+M), graphics acceleration, developer tools. Backups: how many daily backups to keep, back up now, open the backups folder. Program: refresh shortcuts, restart, reset. |
| **Keys** | F11 full screen, Ctrl + / Ctrl − / Ctrl 0 to zoom. The dashboard's own shortcuts work too (press `/` to search). |

## Run and build

You need Node.js 22.

```bat
cd studio-morfis-desktop
npm install
npm start            :: run it
npm run dist         :: build dist\Studio-Morfis-Setup-1.0.0.exe (run this on Windows)
npm run dist:portable
```

The installer is per-user, needs no admin rights, lets you choose the install folder, and creates Start menu and desktop shortcuts.

The GitHub Actions workflow *Build Studio Morfis for Windows* (`.github/workflows/studio-morfis-desktop.yml`) builds the same installer on a Windows runner. It runs when you push a `morfis-v*` tag, on pull requests that touch this folder, or when you start it from the Actions tab. It first runs the checks and the smoke test, then uploads screenshots and the installer as artifacts.

## Where things are kept

Everything is under `%APPDATA%\Studio Morfis\`:

- `data\settings.json`: the studio settings.
- `data\projects\<id>.json`: one file per project.
- `backups\`: a dated copy of everything, once a day.
- `journals\`: records of sorts, renames and moves, so they can be undone (kept for 90 days).
- `branding\`: your custom icon as `.png` and `.ico`.
- `desktop.json`: the Desktop app settings.

To bring in data from the web dashboard, use **Settings → Data → Restore a backup** and pick a backup JSON file. A file with `settings` and `projects` keys works.

## How it is put together

```
src/dashboard/dashboard.html   the web dashboard, unchanged
src/shell/main.js              window, splash, tray, settings, and the API the page calls
src/shell/patch.js             turns the web page into the desktop page when it is served (title bar, wording)
src/shell/fsops.js             folder reading, sorting, moves, undo journals, Recycle Bin
src/shell/branding.js          app name and icon: window, shortcuts, Apps list, .ico generation
src/shell/store.js             data files and daily backups
src/shell/prefs.js             Desktop app settings
src/shell/preload.js           the only bridge between the page and Node
src/shell/renderer/            bridge.js, desktop.js and desktop.css (in-page extras), splash.html
build/icon.svg                 the default icon; `npm run icons` redraws icon.png and icon.ico
scripts/check.js               confirms the dashboard still matches the desktop patch
scripts/smoke.js               starts the app, clicks through, tests folder operations and branding
```

The dashboard is served from `morfis://app/`. It finds `window.morfisDesktop` and switches to its desktop mode, which is built into the dashboard. To update the dashboard, replace `src/dashboard/dashboard.html` with the new version and run `npm run check`. That confirms the title bar patch still applies and that every desktop call the page makes is still provided.
