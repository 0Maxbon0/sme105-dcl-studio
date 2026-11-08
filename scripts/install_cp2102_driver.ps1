# Download the official Silicon Labs CP210x Universal Windows Driver and install it.
# Requests elevation when needed for the driver installation.

$ErrorActionPreference = "Stop"

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
    Write-Host "Requesting Administrator permission for the CP2102 driver..."
    $self = $MyInvocation.MyCommand.Path
    Start-Process -FilePath "powershell.exe" -Verb RunAs -Wait -ArgumentList @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $self
    )
    exit $LASTEXITCODE
}

$Url = "https://www.silabs.com/software-and-tools/usb-to-uart-bridge-vcp-drivers"
$ZipUrl = "https://www.silabs.com/documents/public/software/CP210x_Universal_Windows_Driver.zip"
$Work = Join-Path $env:TEMP "SME105-CP210x-Driver"
$Zip = Join-Path $Work "CP210x_Universal_Windows_Driver.zip"
$Extract = Join-Path $Work "extracted"

Write-Host "Official driver page: $Url"
Write-Host "Downloading Silicon Labs CP210x Universal Windows Driver..."
New-Item -ItemType Directory -Force -Path $Work | Out-Null
Invoke-WebRequest -Uri $ZipUrl -OutFile $Zip -UseBasicParsing
if (Test-Path $Extract) { Remove-Item -Recurse -Force $Extract }
Expand-Archive -LiteralPath $Zip -DestinationPath $Extract -Force

$Inf = Get-ChildItem -LiteralPath $Extract -Recurse -Filter "silabser.inf" | Select-Object -First 1
if ($null -eq $Inf) {
    throw "silabser.inf was not in the Silicon Labs package."
}

Write-Host "Installing $($Inf.FullName)"
pnputil /add-driver $Inf.FullName /install
if ($LASTEXITCODE -ne 0) {
    throw "pnputil failed with exit code $LASTEXITCODE"
}

$instance = "USB\VID_10C4&PID_EA60\0001"
Write-Host "Restarting CP2102 device if present..."
pnputil /restart-device $instance 2>$null
Start-Sleep -Seconds 2

$device = Get-PnpDevice -ErrorAction SilentlyContinue | Where-Object {
    $_.InstanceId -like "*VID_10C4&PID_EA60*"
} | Select-Object -First 1
if ($null -eq $device) {
    Write-Host "Driver staged. Plug in the ESP32 USB cable, then check its COM port in Device Manager."
} else {
    Write-Host ("Device: {0}  status={1}  problem={2}" -f $device.FriendlyName, $device.Status, $device.Problem)
    Get-PnpDevice -Class Ports -ErrorAction SilentlyContinue |
        Where-Object { $_.FriendlyName -match "CP210|Silicon Labs|COM" } |
        ForEach-Object { Write-Host ("Port: {0} [{1}]" -f $_.FriendlyName, $_.Status) }
}

Write-Host "Done. Check the ESP32 COM port in Windows Device Manager."
pause
