# SME-105 DCL Diagnostic Studio — Windows launcher.
# Bootstraps a local venv when needed, reports USB/ESP status, then starts the GUI.

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $Root

function Write-Section([string]$Title) {
    Write-Host ""
    Write-Host $Title -ForegroundColor Cyan
}

function Get-Cp2102Devices {
    Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object {
        $_.InstanceId -like "*VID_10C4&PID_EA60*" -or
        $_.FriendlyName -match "CP210|Silicon Labs"
    }
}

function Show-UsbStatus {
    Write-Section "USB / ESP32"
    $devices = @(Get-Cp2102Devices)
    if ($devices.Count -eq 0) {
        Write-Host "  CP2102 not detected. Plug the ESP32 USB cable in, then run this launcher again."
        return
    }
    foreach ($device in $devices) {
        $problem = $device.Problem
        if (-not $problem) { $problem = "none" }
        Write-Host ("  {0}" -f $device.FriendlyName)
        Write-Host ("    status={0}  problem={1}" -f $device.Status, $problem)
        Write-Host ("    id={0}" -f $device.InstanceId)
        if ($device.Problem -eq "CM_PROB_FAILED_INSTALL" -or $device.Status -eq "Error") {
            $driverBat = Join-Path $Root "Install CP2102 Driver.bat"
            Write-Host "    Windows has no CP2102 COM-port driver (Code 28)." -ForegroundColor Yellow
            Write-Host "    Close this window, right-click this file, Run as administrator:"
            Write-Host "    $driverBat"
            Write-Host "    Then unplug/replug the ESP32 USB cable and launch again."
            Write-Host "    Official source: https://www.silabs.com/software-and-tools/usb-to-uart-bridge-vcp-drivers"
        }
    }
}

function Show-ComPorts([string]$Python) {
    Write-Section "COM ports"
    & $Python -c @"
from serial.tools import list_ports
ports = list(list_ports.comports())
if not ports:
    print('  none')
else:
    for port in ports:
        print(f'  {port.device}  {port.description}  {port.hwid}')
"@
}

function Probe-EspFirmware([string]$Python) {
    Write-Section "ESP firmware probe"
    & $Python -c @"
import sys
import time

try:
    import serial
    from serial.tools import list_ports
except Exception as exc:
    print(f'  probe skipped: {exc}')
    sys.exit(0)

candidates = [
    port for port in list_ports.comports()
    if 'VID:PID=10C4:EA60' in (port.hwid or '').upper()
    or 'CP210' in (port.description or '').upper()
]
if not candidates:
    print('  skipped: no CP2102 COM port (driver missing or cable unplugged)')
    sys.exit(0)

port_name = candidates[0].device
print(f'  port {port_name}')

def sample(baud: int, seconds: float) -> bytes:
    with serial.Serial(port_name, baudrate=baud, timeout=0.2) as link:
        time.sleep(0.4)
        link.reset_input_buffer()
        deadline = time.time() + seconds
        chunks = []
        while time.time() < deadline:
            waiting = link.in_waiting
            chunks.append(link.read(waiting or 1))
        return b''.join(chunks)

binary = sample(460800, 1.4)
ascii_data = sample(115200, 1.2)
if b'\xc0' in binary:
    print('  observed: SLIP 0xC0 at 460800 — matches passive_binary')
elif ascii_data.count(b'.') >= 2 and all(byte in b'.\r\n' for byte in ascii_data):
    print('  observed: periodic dots at 115200 — leftover unrelated firmware, not this project')
elif b'RX T=' in ascii_data or ascii_data.startswith(b'STATUS') or b'HELP' in ascii_data:
    print('  observed: ASCII master/status text — matches dcl_master shell')
elif any(token in ascii_data.upper() for token in (b' AB', b'FF ', b'00 ')):
    print('  observed: hex tokens at 115200 — matches passive_ascii')
elif not binary and not ascii_data:
    print('  observed: USB present, no banner. passive_binary stays silent until UART RX activity.')
    print('  Flash memory keeps the last Linux upload; this does not prove DCL bytes.')
else:
    print(f'  observed unidentified USB bytes: binary={binary[:24]!r} ascii={ascii_data[:24]!r}')
"@
}

Write-Host "SME-105 DCL Diagnostic Studio"
Write-Host "Made by Eng. Maxim Salib"
Write-Host ("Folder: {0}" -f $Root)

$Dist = Join-Path $Root "dist\SME105-DCL-Studio\SME105-DCL-Studio.exe"
if (Test-Path -LiteralPath $Dist) {
    Show-UsbStatus
    Write-Section "Launch"
    Write-Host "  Using packaged app. Leave this window open."
    & $Dist @args
    exit $LASTEXITCODE
}

$VenvPython = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path -LiteralPath $VenvPython)) {
    Write-Section "Python environment"
    $launcher = Get-Command py -ErrorAction SilentlyContinue
    if ($null -eq $launcher) {
        Write-Host "Python 3 is required. Install from https://www.python.org/downloads/" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Creating .venv ..."
    & py -3 -m venv .venv
}

$Gui = Join-Path $Root ".venv\Scripts\ford-dcl-gui.exe"
$NeedInstall = -not (Test-Path -LiteralPath $Gui)
if (-not $NeedInstall) {
    & $VenvPython -c "import websockets" 2>$null
    if ($LASTEXITCODE -ne 0) { $NeedInstall = $true }
}
$NeedPio = $false
& $VenvPython -c "import platformio" 2>$null
if ($LASTEXITCODE -ne 0) { $NeedPio = $true }
if ($NeedInstall) {
    Write-Section "Install"
    Write-Host "  Installing package into .venv ..."
    & $VenvPython -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & $VenvPython -m pip install -e $Root
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
if ($NeedPio) {
    Write-Section "PlatformIO"
    Write-Host "  Installing PlatformIO Core into .venv (needed to build/upload ESP32 firmware) ..."
    & $VenvPython -m pip install platformio
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Show-UsbStatus
Show-ComPorts -Python $VenvPython
Probe-EspFirmware -Python $VenvPython

Write-Section "Launch"
Write-Host "  Local web app on 127.0.0.1. Browser opens with a one-time token."
Write-Host "  Leave this window open while using the studio."
& $Gui @args
exit $LASTEXITCODE
