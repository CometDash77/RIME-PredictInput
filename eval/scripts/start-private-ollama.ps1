# Starts a private Ollama server for eval runs (issue #13; pattern proven in wf27).
# Isolation contract: never touch the user's Ollama on 11434; never pull/delete models.
param(
  [string]$OllamaExe = "",
  [string]$ModelsDir = "",
  [int]$Port = 21434
)
$ErrorActionPreference = "Stop"

if ($OllamaExe -eq "") {
  $candidates = @(
    "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
    "C:\Program Files\Ollama\ollama.exe",
    "$env:LOCALAPPDATA\Ollama\ollama.exe"
  )
  $OllamaExe = ($candidates | Where-Object { Test-Path $_ } | Select-Object -First 1)
  if (-not $OllamaExe) {
    $cmd = Get-Command ollama.exe -ErrorAction SilentlyContinue
    if ($cmd) { $OllamaExe = $cmd.Source }
  }
  if (-not $OllamaExe) { throw "ollama.exe not found; pass -OllamaExe <path>" }
}
if ($ModelsDir -eq "") {
  $ModelsDir = "$env:USERPROFILE\.ollama\models"
  if (-not (Test-Path $ModelsDir)) { throw "models dir not found at $ModelsDir; pass -ModelsDir <path>" }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$cacheDir = Join-Path $repoRoot "eval\.cache"
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
$pidFile = Join-Path $cacheDir "private-ollama.pid"

if (Test-Path $pidFile) {
  $old = (Get-Content $pidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) {
    throw "private ollama already running (pid $old); run stop-private-ollama.ps1 first"
  }
}
$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) { throw "port $Port already in use (pid $($existing.OwningProcess))" }

$env:OLLAMA_HOST = "127.0.0.1:$Port"
$env:OLLAMA_MODELS = $ModelsDir
$env:OLLAMA_KEEP_ALIVE = "60s"
$proc = Start-Process -FilePath $OllamaExe -ArgumentList "serve" -PassThru -WindowStyle Hidden
Set-Content -Path $pidFile -Value $proc.Id

$ready = $false
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/tags" -TimeoutSec 2 | Out-Null
    $ready = $true
    break
  } catch {}
}
if (-not $ready) {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Remove-Item $pidFile -ErrorAction SilentlyContinue
  throw "private ollama did not become ready on port $Port"
}

"private ollama ready: pid=$($proc.Id) port=$Port models_dir=$ModelsDir"
"installed models (verify digests against eval/README.md before running):"
$tags = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/tags" -TimeoutSec 5
$tags.models | ForEach-Object { "  $($_.name) digest=$($_.digest)" }
$userPort = Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue
"user 11434 listener pid (must stay untouched): $(if ($userPort) { $userPort.OwningProcess } else { '(not running)' })"
