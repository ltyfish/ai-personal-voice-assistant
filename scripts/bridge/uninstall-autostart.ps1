# uninstall-autostart.ps1 — remove the JARVIS bridge Startup entry.
# (Does not stop an already-running bridge; just prevents future auto-starts.)
$ErrorActionPreference = 'Stop'
$startup = [Environment]::GetFolderPath('Startup')
$lnk     = Join-Path $startup 'JARVIS Bridge.lnk'
if (Test-Path $lnk) {
  Remove-Item $lnk -Force
  Write-Host "Removed auto-start: $lnk"
} else {
  Write-Host "No auto-start entry found ($lnk)."
}
