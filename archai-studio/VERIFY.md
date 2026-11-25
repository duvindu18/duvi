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

## M3: Chat
1. Open a project and ask: *What roof pitch should I use for clay tiles on a house in Kandy?*
   The answer should appear word by word. The first reply can take 10–30 seconds while
   gpt-oss loads into video memory. Later replies are faster.
2. The answer should use metric units, UK spelling, and end with a short "check this against the
   source documents" note.
3. Click **Reasoning** above the answer to see how the model thought it through.
4. Ask a long question, then click **Stop** part-way. The partial answer stays, marked "Stopped before the end".
5. The **Model** list should show the models from `ollama list` (embedding models hidden).
6. Close and reopen the app. The chat is in the list on the left, inside the same project.
7. Create a second project. Its chat list should be empty.
8. Quit Ollama and send a message. You should see "Ollama isn't running. Start it from the Start menu, then try again."
9. Optional: watch video memory in Task Manager → Performance → GPU. Chat should use about 13–14 GB.

## M4: Script Studio
1. Open **Script Studio**. The yellow banner should say scripts are never run by the app.
2. Pick **Dynamo Python** and ask: *List all doors with their level, width in mm and fire rating.*
   The script appears in the editor and the Notes below it.
3. Copy it into a Dynamo Python node in a **copy** of a Revit model and run it. If it fails, paste the
   red error text into **Fix this error** and click **Fix the script**.
4. Try **Explain this script** on a script of your own (paste it into the editor first).
5. Pick **AutoLISP**, generate a command, then **Save as .lsp**. Load it in AutoCAD with APPLOAD.
6. Repeat once for Grasshopper (Rhino 8 Script component, Python 3), pyRevit, Blender and Excel.
   Tell me which targets give poor results, so I can tune their prompts.

## M5: Visual Studio (needs ComfyUI with an SDXL checkpoint)
Before you start: put an SDXL checkpoint (for example `sd_xl_base_1.0.safetensors` or JuggernautXL) in
`ComfyUI\models\checkpoints`. For sketch to render, also add an SDXL Canny ControlNet
(for example `controlnet-canny-sdxl-1.0`) to `ComfyUI\models\controlnet`. Restart ComfyUI.
1. **From text:** type *Two-storey courtyard house on a sloping site in Kandy, clay tile roof, verandah facing
   the garden, late afternoon*, pick **Bawa-inspired courtyard**, then click **Generate image**. Progress shows
   "Rendering, step x of 30". The bottom strip shows GPU: Image models loaded.
2. Click **Improve with prompt helper** first, and compare the prompt it writes (open "Prompt sent to ComfyUI").
3. Open **Advanced** and check that the checkpoint list matches your ComfyUI models folder.
4. **From sketch:** choose a hand sketch photo or a SketchUp/Revit massing screenshot, describe materials and
   light, then generate. Try the "How closely to follow the sketch" slider.
5. Click a gallery image, then **Vary this image**, and generate again.
6. **Show in folder:** the PNG is in your gallery folder (on D: if you chose that). Drag it onto the ComfyUI
   window. ComfyUI should load the workflow from it, proving the metadata is inside.
7. GPU turn-taking: after rendering, ask something in Chat. The first reply takes a little longer (the model
   reloads), but nothing should run out of video memory. Watch Task Manager → Performance → GPU.
8. Quit ComfyUI and open Visual Studio. It should say "ComfyUI isn't running", and Chat still works.
9. Optional: in ComfyUI, export one of your own workflows with **Workflow → Export (API)**, then use
   **Advanced → Import a ComfyUI workflow…** to import it.
