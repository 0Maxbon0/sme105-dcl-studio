@echo off
setlocal
cd /d "%~dp0\.."

if exist "dist\SME105-DCL-Studio\SME105-DCL-Studio.exe" (
  "dist\SME105-DCL-Studio\SME105-DCL-Studio.exe" %*
) else (
  ".venv\Scripts\ford-dcl-gui.exe" %*
)
endlocal
