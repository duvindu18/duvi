@echo off
rem Builds dist\D5Bridge\D5Bridge.exe (and D5BridgeSetup.exe when Inno Setup is installed).
cd /d %~dp0\..
python -m pip install -r requirements-dev.txt || exit /b 1
python -m pytest -q || exit /b 1
pyinstaller packaging\d5bridge.spec --noconfirm --distpath dist --workpath build || exit /b 1
where iscc >nul 2>nul && iscc packaging\d5bridge.iss
echo.
echo Built: dist\D5Bridge\D5Bridge.exe
