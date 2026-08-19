$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

Write-Host 'FORGE - syncing latest code...'
try {
    git pull --ff-only
} catch {
    Write-Warning 'Git pull was skipped or failed. Launching the current local build.'
}

$envExample = Join-Path $Root '.env.example'
$envFile = Join-Path $Root '.env'
if (-not (Test-Path $envFile) -and (Test-Path $envExample)) {
    Copy-Item $envExample $envFile
    Write-Warning 'Created .env from .env.example. Add only the provider keys you want to use. FORGE reloads .env automatically.'
}

# Load local .env into this process without printing secrets.
if (Test-Path $envFile) {
    foreach ($raw in Get-Content $envFile) {
        $line = $raw.Trim()
        if (-not $line -or $line.StartsWith('#')) { continue }
        $idx = $line.IndexOf('=')
        if ($idx -lt 1) { continue }
        $name = $line.Substring(0, $idx).Trim()
        $value = $line.Substring($idx + 1).Trim()
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}

$gatewayHost = if ($env:FORGE_GATEWAY_HOST) { $env:FORGE_GATEWAY_HOST } else { '127.0.0.1' }
$gatewayPort = if ($env:FORGE_GATEWAY_PORT) { [int]$env:FORGE_GATEWAY_PORT } else { 43175 }
$gatewayHealth = "http://${gatewayHost}:$gatewayPort/health"
$expectedGatewayVersion = '2.0.0'
$gatewayReady = $false

try {
    $health = Invoke-RestMethod -Uri $gatewayHealth -Method Get -TimeoutSec 1
    if ($health.ok -and $health.product -eq 'FORGE' -and $health.version -eq $expectedGatewayVersion) {
        $gatewayReady = $true
    } elseif ($health.product -eq 'FORGE') {
        Write-Host 'FORGE - replacing stale gateway process...'
        $oldPid = (Get-NetTCPConnection -LocalPort $gatewayPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
        if ($oldPid) {
            Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 300
        }
    }
} catch { }

if (-not $gatewayReady) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        throw 'Node.js is required to run the FORGE MalikLLM75B gateway.'
    }

    $gatewayScript = Join-Path $Root 'resources\app\out\forge\forge-gateway-v2.mjs'
    if (-not (Test-Path $gatewayScript)) {
        throw "FORGE gateway v2 script was not found at $gatewayScript"
    }

    $logDir = Join-Path $Root 'logs'
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $stdout = Join-Path $logDir 'forge-gateway.log'
    $stderr = Join-Path $logDir 'forge-gateway-error.log'

    Write-Host 'FORGE - starting MalikLLM75B gateway v2...'
    Start-Process -FilePath $node.Source `
        -ArgumentList @($gatewayScript) `
        -WorkingDirectory $Root `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr | Out-Null

    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 150
        try {
            $health = Invoke-RestMethod -Uri $gatewayHealth -Method Get -TimeoutSec 1
            if ($health.ok -and $health.version -eq $expectedGatewayVersion) {
                $gatewayReady = $true
                break
            }
        } catch { }
    }
}

if ($gatewayReady) {
    Write-Host "FORGE - MalikLLM75B gateway v$expectedGatewayVersion ready."
} else {
    Write-Warning 'FORGE gateway did not become ready. Check logs\forge-gateway-error.log.'
}

$exe = Join-Path $Root 'CortexIDE.exe'
if (-not (Test-Path $exe)) {
    throw "FORGE runtime executable was not found at $exe"
}

# Create FORGE shortcuts using the FORGE icon without modifying the compatibility-critical exe.
$icon = Join-Path $Root 'resources\app\resources\win32\forge.ico'
if (Test-Path $icon) {
    try {
        $shell = New-Object -ComObject WScript.Shell
        $desktop = [Environment]::GetFolderPath('Desktop')
        $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
        foreach ($folder in @($desktop, $startMenu)) {
            if (-not $folder) { continue }
            $shortcutPath = Join-Path $folder 'FORGE.lnk'
            $shortcut = $shell.CreateShortcut($shortcutPath)
            $shortcut.TargetPath = $exe
            $shortcut.WorkingDirectory = $Root
            $shortcut.IconLocation = "$icon,0"
            $shortcut.Description = 'FORGE - AI Coding Platform'
            $shortcut.Save()
        }
    } catch {
        Write-Warning 'Could not refresh FORGE shortcuts; the app will still launch normally.'
    }
}

Write-Host 'Launching FORGE...'
Start-Process $exe
