# install-drill.ps1 — zero-residue install→run→exit→uninstall drill (R13/R14 era).
# Usage (from repo root):  powershell -NoProfile -File scripts\install-drill.ps1 [-Installer "release\EnTransfer Setup 0.1.0.exe"]
param(
  [string]$Installer = "release\EnTransfer Setup 0.1.0.exe"
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$installerPath = Join-Path $root $Installer
if (-not (Test-Path $installerPath)) { throw "installer not found: $installerPath (run npm run dist first)" }
$drillDir = Join-Path $root ".scratch\drill-install"
$appName = "entransfer"          # lower-case app name used by NSIS cache dirs
$updaterDir = Join-Path $env:LOCALAPPDATA "$appName-updater"

Write-Host "[drill] installing $installerPath -> $drillDir"
Start-Process -FilePath $installerPath -ArgumentList '/S', "/D=$drillDir" -Wait

Write-Host "[drill] launching app (8s)"
Start-Process -FilePath (Join-Path $drillDir "EnTransfer.exe")
Start-Sleep 8
Get-Process -Name EnTransfer -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 3   # let file locks die

Write-Host "[drill] uninstalling"
Start-Process -FilePath (Join-Path $drillDir "Uninstall EnTransfer.exe") -ArgumentList '/S' -Wait
Start-Sleep 2

$fails = @()
if (Test-Path $drillDir) {
  $left = Get-ChildItem $drillDir -Recurse -File
  if ($left.Count -gt 0) { $fails += "install dir not empty: $($left.Count) files" }
  else { Remove-Item $drillDir; Write-Host "[drill] (install root was empty, removed)" }
}
if (Test-Path $updaterDir) { $fails += "R13 residue: $updaterDir still exists" }
if (Get-ChildItem $env:APPDATA -Directory | Where-Object Name -like "$appName*") { $fails += "R14 residue in roaming AppData" }
if (Test-Path "$env:USERPROFILE\Desktop\$appName.lnk") { $fails += "desktop shortcut residue" }

if ($fails.Count) { $fails | ForEach-Object { Write-Host "FAIL: $_" }; exit 1 }
Write-Host "[drill] PASS — zero residue"
