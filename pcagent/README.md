# PC Agent: autosave

Saves every open document in **AutoCAD, D5 Render, Word, Excel, PowerPoint and
Visio** by pressing **Ctrl+S** in each window, then **checks the file on
disk**. A document only counts as saved when its *modified time* actually
got newer. Never-saved files, prompts and frozen apps are reported, never
guessed at.

This is the first building block of the remote PC agent. The same
`save` / `shutdown` commands will later be triggered from your phone.

## How it works

```
for each visible window of a configured app (acad.exe, d5*.exe, winword.exe, ...):
  1. find the document file:  window title -> files the app has open -> search_dirs
  2. skip if untitled (Drawing1, Document2, Book1) or a modal dialog is already open
  3. remember the file's modified time
  4. focus the window, send pre_keys (AutoCAD: Esc Esc), send Ctrl+S
  5. wait until the modified time is newer and the size stops changing
     - a new prompt window (Save As / read-only / compatibility) -> Esc, report DIALOG
     - no change within timeout -> UNCHANGED (nothing to save, or Ctrl+S ignored)
then put focus back where it was and re-minimize windows that were minimized
```

| Status | Meaning | Blocks auto-shutdown |
| --- | --- | --- |
| `SAVED` | file on disk is newer | no |
| `UNCHANGED` | file not rewritten: usually *no unsaved changes* | no |
| `SENT_UNVERIFIED` | Ctrl+S sent, but the file couldn't be found to check | no |
| `UNTITLED` | never saved: needs a name once (Save As) | **yes** |
| `DIALOG` | Ctrl+S opened a prompt; it was closed with Esc | **yes** |
| `BUSY` | app not responding, or a dialog was already open | **yes** |
| `FOCUS_FAILED` / `ERROR` | couldn't switch to the window / unexpected error | **yes** |

## Install (Windows, Python 3.11+)

```powershell
cd pcagent
powershell -ExecutionPolicy Bypass -File scripts\install_autosave.ps1   # -IntervalMinutes 5
```

This installs `psutil` and a **logon task** that runs `autosave watch` in the
background. It also adds two desktop shortcuts: **Save all now** and
**Save all + shut down**. Remove everything with `-Uninstall`.

## Commands (run inside `pcagent\`)

```powershell
python -m autosave list                 # what it detects + which file each window maps to (no keys sent)
python -m autosave list --all-windows   # also every window's exe name (to add new apps)
python -m autosave save                 # save everything once, print + write a report
python -m autosave watch                # every 10 min, only after 60 s without keyboard/mouse use
python -m autosave shutdown --dry-run   # full save + close run, without shutting down
python -m autosave shutdown             # save, close apps, shut down (only if nothing needs attention)
python -m autosave shutdown hibernate   # save, then hibernate (apps stay open)
```

`save` and `shutdown` exit with code `2` when something needs attention.
Every run writes `%LOCALAPPDATA%\PCAgent\autosave\last-report.json`, plus
a timestamped copy in `reports\`, and appends to `autosave.log`.

**Shutdown is safe by design.** After saving, each app is asked to close
normally. If an app answers with *"Do you want to save changes?"*, that
proves work is unsaved. The prompt is cancelled, the app stays open, and
**the shutdown is cancelled**. `--force` overrides this.

## First run checklist

1. Open one of each: a drawing, a D5 scene, a Word and an Excel file.
2. Run `python -m autosave list`. Every window should show a `file :` line.
   - **D5 Render:** D5 doesn't keep `.drs` files open, so the file is found by
     name in `search_dirs`. Add your project folders in `autosave.toml`,
     e.g. `search_dirs = ["~/Documents", "D:/Projects"]`.
   - If D5 doesn't appear at all, run `list --all-windows`, find its exe name,
     and fix `process = [...]` under D5 Render.
3. Make a small change in each, run `python -m autosave save`, and expect `SAVED` everywhere.

## Configuration: `autosave.toml`

Each `[[app]]` block has `process` (exe names, wildcards allowed),
`extensions`, `pre_keys`, `save_keys`, `timeout_seconds`, an `untitled`
pattern and `detect_dialogs`. SketchUp, Revit, Photoshop and 3ds Max are
included but turned off; set `enabled = true` to use them. Any app whose save
shortcut is Ctrl+S works the same way.

## Known limits

- **AutoCAD with several drawings open:** Ctrl+S saves only the *active*
  drawing tab, because AutoCAD shows all tabs in one window. Planned next:
  save every open drawing through AutoCAD's own automation interface.
- **Excel while editing a cell:** Ctrl+S does nothing until you leave the
  cell, so the result is `UNCHANGED`. Watch mode waits until you're idle,
  so this is rare.
- **Apps run as Administrator** can't receive keys from a normal-user agent,
  because Windows blocks it. Run both the same way.
- **Nobody logged in / screen locked:** Windows doesn't deliver keystrokes
  to a locked desktop, so saving needs an unlocked session. Hibernate needs
  no saving at all.
- **`UNCHANGED` is ambiguous.** Most apps skip writing when nothing changed,
  so it usually means "already saved". The close step in `shutdown` is the
  definitive check.

## Tests

```bash
python -m pytest pcagent/tests -q   # runs on any OS with a simulated desktop
```
