# OpenGate VPN helper installer for Windows.
#   powershell -ExecutionPolicy Bypass -File install_windows.ps1
#   powershell -ExecutionPolicy Bypass -File install_windows.ps1 -Uninstall
#   powershell -ExecutionPolicy Bypass -File install_windows.ps1 -Id <extension-id>
param(
  [switch]$Uninstall,
  [string]$Id = "aekgcagkmfabhjpmnhaaepiljnnhmcbp"
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$HostName = "com.opengate.vpn"
$HomeDir = Join-Path $env:USERPROFILE ".opengate-vpn"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$RegRoots = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts",
  "HKCU:\Software\Chromium\NativeMessagingHosts",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts",
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
  "HKCU:\Software\Vivaldi\NativeMessagingHosts",
  "HKCU:\Software\Yandex\YandexBrowser\NativeMessagingHosts"
)

function Stop-Xray {
  $pidFile = Join-Path $HomeDir "xray.pid"
  if (Test-Path $pidFile) {
    $p = Get-Content $pidFile
    Get-Process -Id $p -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like "xray*" } | Stop-Process -Force
  }
}

if ($Uninstall) {
  Stop-Xray
  foreach ($r in $RegRoots) { Remove-Item -Path "$r\$HostName" -Force -ErrorAction SilentlyContinue }
  Remove-Item -Recurse -Force $HomeDir -ErrorAction SilentlyContinue
  Write-Host "OpenGate helper removed."
  exit 0
}

# Find Python 3
$Python = $null
$Probe = "import sys; print(sys.executable) if sys.version_info[0] == 3 else None"
foreach ($cand in @("py -3", "python", "python3")) {
  try {
    $parts = @($cand -split " ")
    $cmdArgs = @($parts | Select-Object -Skip 1) + @("-c", $Probe)
    $exe = & $parts[0] @cmdArgs 2>$null
    if ($LASTEXITCODE -eq 0 -and $exe -and (Test-Path $exe.Trim())) { $Python = $exe.Trim(); break }
  } catch {}
}
if (-not $Python) {
  Write-Host "Python 3 is required. Install it with:  winget install Python.Python.3.12"
  Write-Host "or from https://www.python.org/downloads/ (tick 'Add python.exe to PATH'), then run this again."
  exit 1
}

$Asset = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "Xray-windows-arm64-v8a.zip" } else { "Xray-windows-64.zip" }
New-Item -ItemType Directory -Force -Path (Join-Path $HomeDir "xray") | Out-Null
$Tmp = Join-Path $env:TEMP ("opengate-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
Write-Host "Downloading Xray-core ($Asset)..."
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/XTLS/Xray-core/releases/latest/download/$Asset" -OutFile "$Tmp\xray.zip"
Expand-Archive -Force -Path "$Tmp\xray.zip" -DestinationPath "$Tmp\xray"
Stop-Xray
Copy-Item -Force "$Tmp\xray\*" (Join-Path $HomeDir "xray")
Remove-Item -Recurse -Force $Tmp

Copy-Item -Force (Join-Path $Here "opengate_host.py") (Join-Path $HomeDir "opengate_host.py")
$Bat = Join-Path $HomeDir "opengate_host.bat"
Set-Content -Encoding ASCII -Path $Bat -Value "@echo off`r`n`"$Python`" -u `"%~dp0opengate_host.py`" %*"

$ManifestPath = Join-Path $HomeDir "$HostName.json"
$Manifest = @{
  name = $HostName
  description = "OpenGate VPN helper"
  path = $Bat
  type = "stdio"
  allowed_origins = @("chrome-extension://$Id/")
} | ConvertTo-Json
Set-Content -Encoding UTF8 -Path $ManifestPath -Value $Manifest

foreach ($r in $RegRoots) {
  New-Item -Path "$r\$HostName" -Force | Out-Null
  Set-ItemProperty -Path "$r\$HostName" -Name "(default)" -Value $ManifestPath
}

& (Join-Path $HomeDir "xray\xray.exe") version | Select-Object -First 1
Write-Host "Done! Open the OpenGate extension -> Settings -> Recheck."
