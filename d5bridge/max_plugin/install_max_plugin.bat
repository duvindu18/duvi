@echo off
rem Copies the D5 Bridge 3ds Max scripts into every installed 3ds Max user folder.
setlocal enabledelayedexpansion
set SRC=%~dp0
set FOUND=0
for /d %%V in ("%LOCALAPPDATA%\Autodesk\3dsMax\*") do (
    for /d %%L in ("%%V\*") do (
        if exist "%%L\scripts" (
            set DST=%%L\scripts\D5Bridge
            if not exist "!DST!" mkdir "!DST!"
            copy /y "%SRC%d5bridge_max_export.py" "!DST!\" >nul
            copy /y "%SRC%d5bridge_max_panel.py" "!DST!\" >nul
            copy /y "%SRC%d5bridge_batch.ms" "!DST!\" >nul
            if not exist "%%L\usermacros" mkdir "%%L\usermacros"
            copy /y "%SRC%D5Bridge.mcr" "%%L\usermacros\" >nul
            echo Installed into %%L
            set FOUND=1
        )
    )
)
if "%FOUND%"=="0" echo No 3ds Max user folder found. Start 3ds Max once, then run this again.
pause
