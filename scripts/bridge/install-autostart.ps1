# install-autostart.ps1 — make the JARVIS local bridge start automatically at login.
# Drops a shortcut in the current user's Startup folder that runs bridge-autostart.vbs
# (hidden console, interactive session). Re-run any time; it overwrites cleanly.
$ErrorActionPreference = 'Stop'

$projectDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # $PSScriptRoot = ...\scripts\bridge
$vbs        = Join-Path $PSScriptRoot 'bridge-autostart.vbs'
if (-not (Test-Path $vbs)) { throw "Launcher not found: $vbs" }

$startup = [Environment]::GetFolderPath('Startup')
$lnk     = Join-Path $startup 'JARVIS Bridge.lnk'

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath       = Join-Path $env:WINDIR 'System32\wscript.exe'
$sc.Arguments        = '"' + $vbs + '"'
$sc.WorkingDirectory = $projectDir
$sc.WindowStyle      = 7   # minimized (wscript itself shows nothing anyway)
$sc.Description       = 'Start JARVIS local bridge at login'
$sc.Save()

Write-Host "Auto-start installed:"
Write-Host "  $lnk"
Write-Host "  -> wscript $vbs"
Write-Host ""
Write-Host "The bridge will now start hidden whenever you log in."
Write-Host "Starting it once now so you don't have to log out/in..."
& (Join-Path $env:WINDIR 'System32\wscript.exe') $vbs
Write-Host "Done. Use 'Check computer' in the web app's Bridge settings to confirm it's online."
