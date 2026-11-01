@echo off
title SME-105 DCL Diagnostic Studio
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch_windows.ps1" %*
if errorlevel 1 (
  echo.
  echo Launch failed. This window can be closed after you read the error.
  pause
)
