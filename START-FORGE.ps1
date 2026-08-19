$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

# Always restart the installed runtime so a previously running Electron process cannot keep an
# older, unpatched Agent bundle in memory through the single-instance handoff.
$runningForge = Get-Process CortexIDE -ErrorAction SilentlyContinue
if ($runningForge) {
    Write-Host 'FORGE - closing previous runtime...'
    $runningForge | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
}

# The Agent patch intentionally modifies this generated bundle at runtime. Restore only this
# FORGE-owned generated file before pulling so future updates never conflict with the local patch.
$workbenchBundle = 'resources/app/out/vs/workbench/workbench.desktop.main.js'
try {
    git checkout -- $workbenchBundle 2>$null
} catch { }

Write-Host 'FORGE - syncing latest code...'
try {
    git pull --ff-only
} catch {
    Write-Warning 'Git pull was skipped or failed. Launching the current local build.'
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw 'Node.js is required to run FORGE.'
}

# The compiled Agent stores provider settings in encrypted persistent state. Older installs can
# therefore override the new FORGE gateway defaults with a stale/empty API key. Patch the exact
# settings merge site on every launch so the internal compatibility provider is always locked to
# the local MalikLLM75B gateway. Real upstream secrets never enter the renderer.
$agentPatcher = Join-Path $Root 'resources\app\out\forge\forge-agent-patch.mjs'
if (-not (Test-Path $agentPatcher)) {
    throw "FORGE Agent patcher was not found at $agentPatcher"
}

Write-Host 'FORGE - locking Agent to MalikLLM75B local gateway...'
& $node.Source $agentPatcher
if ($LASTEXITCODE -ne 0) {
    throw 'FORGE Agent compatibility patch failed. Refusing to launch with stale provider settings.'
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

# OmniRoute is the primary local router for MalikLLM75B. FORGE now owns its startup instead of
# requiring the user to keep a second PowerShell window open. The bootstrap first starts the
# already-installed global package directly through Node and, if that runtime is broken, falls
# back to npx omniroute@latest. Direct providers remain available as failover routes.
$omniBootstrap = Join-Path $Root 'resources\app\out\forge\forge-omniroute-bootstrap.mjs'
if (Test-Path $omniBootstrap) {
    Write-Host 'FORGE - ensuring OmniRoute local router is running...'
    & $node.Source $omniBootstrap
    if ($LASTEXITCODE -ne 0) {
        Write-Warning 'OmniRoute could not be auto-started. FORGE will still test any configured direct provider fallbacks.'
    }
}

$gatewayHost = if ($env:FORGE_GATEWAY_HOST) { $env:FORGE_GATEWAY_HOST } else { '127.0.0.1' }
$gatewayPort = if ($env:FORGE_GATEWAY_PORT) { [int]$env:FORGE_GATEWAY_PORT } else { 43175 }
$gatewayHealth = "http://${gatewayHost}:$gatewayPort/health"
$gatewayChat = "http://${gatewayHost}:$gatewayPort/v1/chat/completions"
$gatewayDiagnostics = "http://${gatewayHost}:$gatewayPort/v1/diagnostics"
$expectedGatewayVersion = '2.0.0'
$gatewayReady = $false

# Always restart our own gateway. This clears stale provider cooldowns from a previous failed run
# and guarantees the current .env values are inherited by the new process.
$existingForgeGateway = $false
try {
    $health = Invoke-RestMethod -Uri $gatewayHealth -Method Get -TimeoutSec 1
    if ($health.product -eq 'FORGE') {
        $existingForgeGateway = $true
    }
} catch { }

if ($existingForgeGateway) {
    Write-Host 'FORGE - refreshing MalikLLM75B gateway state...'
    $oldPid = (Get-NetTCPConnection -LocalPort $gatewayPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
    if ($oldPid) {
        Stop-Process -Id $oldPid -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
    }
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

for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 150
    try {
        $health = Invoke-RestMethod -Uri $gatewayHealth -Method Get -TimeoutSec 1
        if ($health.ok -and $health.product -eq 'FORGE' -and $health.version -eq $expectedGatewayVersion) {
            $gatewayReady = $true
            break
        }
    } catch { }
}

if (-not $gatewayReady) {
    throw 'FORGE gateway did not become ready. Check logs\forge-gateway-error.log.'
}

Write-Host "FORGE - MalikLLM75B gateway v$expectedGatewayVersion ready."

# A health endpoint only proves that the local process is listening. Before the IDE is allowed to
# open, make a real OpenAI-compatible chat request through exactly the same local endpoint/model
# the compiled Agent uses. The gateway itself performs provider retry/failover.
Write-Host 'FORGE - running end-to-end MalikLLM75B self-test...'
$selfTestBody = @{
    model = 'MalikLLM75B'
    messages = @(
        @{
            role = 'user'
            content = 'Reply only: OK'
        }
    )
    max_tokens = 8
    stream = $false
} | ConvertTo-Json -Depth 8

$selfTestHeaders = @{
    Authorization = 'Bearer forge-local-gateway'
    'Content-Type' = 'application/json'
}

$selfTestPassed = $false
$lastSelfTestError = $null
for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
        $probe = Invoke-RestMethod `
            -Uri $gatewayChat `
            -Method Post `
            -Headers $selfTestHeaders `
            -Body $selfTestBody `
            -TimeoutSec 120

        if ($probe.choices -and $probe.choices.Count -gt 0 -and $probe.choices[0].message) {
            $selfTestPassed = $true
            break
        }
        $lastSelfTestError = 'Gateway returned no chat choice.'
    } catch {
        $lastSelfTestError = $_.Exception.Message
    }

    if ($attempt -lt 3) {
        Start-Sleep -Seconds 1
    }
}

if (-not $selfTestPassed) {
    Write-Host 'FORGE - end-to-end self-test failed.' -ForegroundColor Red
    try {
        $diag = Invoke-RestMethod -Uri $gatewayDiagnostics -Method Get -TimeoutSec 2
        Write-Host ($diag | ConvertTo-Json -Depth 8)
    } catch { }
    Write-Host 'FORGE - OmniRoute logs: logs\omniroute.log and logs\omniroute-error.log' -ForegroundColor Yellow
    throw "MalikLLM75B is not ready for the Agent. Last self-test error: $lastSelfTestError"
}

Write-Host 'FORGE - MalikLLM75B end-to-end self-test passed.' -ForegroundColor Green

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
