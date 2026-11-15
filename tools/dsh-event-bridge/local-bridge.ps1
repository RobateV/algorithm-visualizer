param([ValidateSet('start','stop','status','pause','resume')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'
$bridgeRoot = $PSScriptRoot
$bridgeState = Join-Path $bridgeRoot '.local-state'
$nodePath = (Get-Command node -ErrorAction Stop).Source
$serviceScript = Join-Path $bridgeRoot 'local-service.mjs'
if ($Action -eq 'start') {
    New-Item -ItemType Directory -Path $bridgeState -Force | Out-Null
    if (-not (Test-Path -LiteralPath (Join-Path $bridgeState 'policy.json'))) {
        Copy-Item -LiteralPath (Join-Path $bridgeRoot 'local-policy.example.json') -Destination (Join-Path $bridgeState 'policy.json')
    }
    if (Test-Path -LiteralPath (Join-Path $bridgeState 'service.lock')) {
        & $nodePath $serviceScript --status
        throw 'Service lock exists. Check status; do not delete a live lock.'
    }
    # 仅将凭据放入子进程环境，绝不写入脚本、命令行或日志。
    if (-not $env:DSH_BRIDGE_TOKEN) {
        $ghCommand = Get-Command gh -ErrorAction SilentlyContinue
        $ghPath = if ($ghCommand) { $ghCommand.Source } else { Join-Path $env:ProgramFiles 'GitHub CLI\gh.exe' }
        if (Test-Path -LiteralPath $ghPath) {
            $env:DSH_BRIDGE_TOKEN = (& $ghPath auth token 2>$null | Out-String).Trim()
        }
    }
    $startArgs = '"' + $serviceScript + '"'
    $proc = Start-Process -FilePath $nodePath -ArgumentList $startArgs -WorkingDirectory $bridgeRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $bridgeState 'service.stdout.log') -RedirectStandardError (Join-Path $bridgeState 'service.stderr.log')
    Start-Sleep -Milliseconds 800
    if ($proc.HasExited) { throw 'Bridge exited. Check .local-state/service.stderr.log.' }
    Write-Host "Bridge started, pid=$($proc.Id). Automatic execution and push follow local policy."
} else {
    & $nodePath $serviceScript "--$Action"
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
