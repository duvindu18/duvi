-- D5 Bridge toolbar button.
-- Install: drag this file into a 3ds Max viewport (or run it once), then
-- Customize > Customize User Interface > Toolbars > Category "D5 Bridge".
macroScript D5Bridge_Panel
    category:"D5 Bridge"
    buttonText:"D5 Bridge"
    toolTip:"Export trees / Megascans to D5 Render (FBX + textures)"
(
    on execute do
    (
        local dir = (getDir #userScripts) + "\\D5Bridge\\"
        local py = dir + "d5bridge_max_panel.py"
        if doesFileExist py then (python.ExecuteFile py) else (messageBox ("D5 Bridge is not installed in:\n" + dir + "\nRun install_max_plugin.bat from the D5 Bridge folder.") title:"D5 Bridge")
    )
)
