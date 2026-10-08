# Stops the private Ollama server started by start-private-ollama.ps1 and proves cleanup.
param([int]$Port = 21434)
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$pidFile = Join-Path $repoRoot "eval\.cache\private-ollama.pid"

$targets = @()
if (Test-Path $pidFile) {
  $targets += (Get-Content $pidFile -ErrorAction SilentlyContinue | Where-Object { $_ })
}
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($conn) { $targets += ($conn.OwningProcess | Select-Object -Unique) }
$targets = $targets | Select-Object -Unique

foreach ($p in $targets) {
  if ($p -and (Get-Process -Id $p -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $p -Force
    "stopped private ollama pid $p"
  }
}
Remove-Item $pidFile -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800

$after = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
"port_$($Port)_listeners_after: $($after.Count)"
$userPort = Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue
"user 11434 listener after stop: $(if ($userPort) { "pid $($userPort.OwningProcess) (alive)" } else { "(not running)" })"
if ($after.Count -gt 0) { throw "port $Port still in use after stop" }
"cleanup verified: no residual listener on $Port"
