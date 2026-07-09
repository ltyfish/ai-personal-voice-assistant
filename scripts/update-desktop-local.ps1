param(
  [string]$InstallDir = "$env:USERPROFILE\Downloads\JARVIS Desktop",
  [switch]$SkipWebBuild
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$desktopRelease = Join-Path $repoRoot "desktop\release"
$unpackedDir = Join-Path $desktopRelease "win-unpacked"
$exePath = Join-Path $InstallDir "JARVIS Desktop.exe"
$installedPetEnv = Join-Path $InstallDir "jarvis-pet.env"
$petEnvExample = Join-Path $repoRoot "jarvis-pet.env.example"
$startMenuShortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\JARVIS Desktop.lnk"

Set-Location $repoRoot

Write-Host "Stopping existing JARVIS Desktop processes..."
Get-Process -Name "JARVIS Desktop" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

if (-not $SkipWebBuild) {
  Write-Host "Building JARVIS web runtime..."
  npm run build
}

Write-Host "Building JARVIS Desktop installer..."
npm --prefix desktop run build

$installer = Get-ChildItem -Path $desktopRelease -Filter "JARVIS Desktop Setup *.exe" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (-not $installer) {
  throw "No JARVIS Desktop installer found in $desktopRelease."
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

if (-not (Test-Path $unpackedDir)) {
  throw "Unpacked desktop build was not found at $unpackedDir."
}

Write-Host "Copying unpacked build to $InstallDir..."
Copy-Item -Path (Join-Path $unpackedDir "*") -Destination $InstallDir -Recurse -Force

if (-not (Test-Path $installedPetEnv)) {
  Write-Host "Creating editable pet image configuration..."
  Copy-Item -LiteralPath $petEnvExample -Destination $installedPetEnv
}

if (-not (Test-Path $exePath)) {
  throw "Updated executable was not found at $exePath."
}

Write-Host "Refreshing Start Menu shortcut..."
$shortcutDir = Split-Path -Parent $startMenuShortcut
New-Item -ItemType Directory -Force -Path $shortcutDir | Out-Null
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($startMenuShortcut)
$shortcut.TargetPath = $exePath
$shortcut.WorkingDirectory = $InstallDir
$shortcut.Save()

Write-Host "Launching updated JARVIS Desktop..."
Start-Process -FilePath $exePath
Write-Host "JARVIS Desktop updated."
