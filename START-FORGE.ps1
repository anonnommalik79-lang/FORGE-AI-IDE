$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

Write-Host 'FORGE — syncing latest code...'
try {
    git pull --ff-only
} catch {
    Write-Warning 'Git pull was skipped or failed. Launching the current local build.'
}

$exe = Join-Path $Root 'CortexIDE.exe'
if (-not (Test-Path $exe)) {
    throw "FORGE runtime executable was not found at $exe"
}

Write-Host 'Launching FORGE...'
Start-Process $exe
