@echo off
title Install CP2102 USB driver
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install_cp2102_driver.ps1"
if errorlevel 1 pause
