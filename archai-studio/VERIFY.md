# Checks for you on your PC

Each milestone adds a short section. Tick them off on your Windows 11 machine.

## M0: Scaffold (optional, no features yet)
1. On GitHub, open **Actions → ArchAI Studio CI** and open the latest run on branch
   `ccr-84c90378-nzfc96`. Both jobs should be green.
2. At the bottom of the run, download **ArchAI-Studio-unsigned-windows** and unzip it.
3. Run `ArchAI-Studio-Setup-0.1.0.exe`. Windows SmartScreen will warn, because it isn't signed yet:
   click *More info → Run anyway*. The installer should ask for a folder.
4. Start **ArchAI Studio** from the Start menu. You should see a dark window that
   says "ArchAI Studio" with a version line. That's all M0 does.
5. Uninstall it from *Settings → Apps*. (The "keep my data?" question comes in M7.)

## M1: Look and feel, projects, settings
Install the new Setup.exe from the latest CI run (same steps as M0).
1. On first start you see **Start a project**. Type `Kandy Residence` and click **Create project**.
   The bottom strip (the "title block") shows Project: Kandy Residence.
2. Try creating `kandy residence` again from the project menu (top left). You should get "already exists".
3. Open **Settings**, switch the theme to Light, then close and reopen the app. It should still be light.
4. Change the Ollama address to `http://192.168.1.10:11434` and press Enter. It should refuse
   (addresses on this computer only). Set it back to `http://127.0.0.1:11434`.
5. Type `32768` in Context length. You should see the 16 GB video memory warning. Set it back to `8192`.
6. Check that the folder `C:\Users\<you>\ArchAI Studio` now exists and contains `archai.db`.

## M2: First-run wizard
To see the wizard again on a PC that has already run it, delete
`%APPDATA%\ArchAI Studio\settings.json` first (or test on a fresh Windows user account).
1. **Quit Ollama** (right-click its tray icon → Quit). Start ArchAI Studio. In *Check your setup*,
   "Ollama isn't running" should be red, with a fix and an `ollama serve` command. Click **Copy**
   and paste into Notepad to check.
2. Start Ollama again and click **Check again**. Ollama and gpt-oss:20b should turn green.
3. With ComfyUI closed, it should say "ComfyUI isn't running" and note that chat still works.
   Start ComfyUI and check again.
4. Your RTX 5080 should be listed with 16 GB, plus the free space on C:.
5. In *Where to keep your work*, turn on "Keep image galleries on another drive" and pick a folder on D:.
6. Finish. The bottom strip should show Ollama and ComfyUI as Running. Quit Ollama, and within
   about 20 seconds it should change to Not running.
