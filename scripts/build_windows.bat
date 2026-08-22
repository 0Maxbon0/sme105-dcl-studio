@echo off
setlocal
cd /d "%~dp0\.."

if not exist ".venv\Scripts\python.exe" (
  py -3 -m venv .venv
  if errorlevel 1 exit /b 1
)

".venv\Scripts\python.exe" -m pip install --upgrade pip
if errorlevel 1 exit /b 1
".venv\Scripts\python.exe" -m pip install -e ".[build]"
if errorlevel 1 exit /b 1
".venv\Scripts\pyinstaller.exe" --clean --noconfirm "packaging\ford_dcl_gui.spec"
if errorlevel 1 exit /b 1

echo Bundle: %CD%\dist\SME105-DCL-Studio\
endlocal
