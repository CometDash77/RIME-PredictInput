# Runs every eval/arms/*.json arm against a private Ollama endpoint via the frozen rig.
# Arms whose model is absent from /api/tags are skipped (e.g. official 2B before the Q12 pull).
param(
  [string]$Endpoint = "http://127.0.0.1:21434",
  [int]$Runs = 3,
  [string]$ArmsDir = ""
)
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
if ($ArmsDir -eq "") { $ArmsDir = Join-Path $repoRoot "eval\arms" }
$mainJs = Join-Path $repoRoot "dist\eval\main.js"
if (-not (Test-Path $mainJs)) { throw "dist/eval/main.js missing; run 'pnpm build' first" }

$tags = Invoke-RestMethod -Uri "$Endpoint/api/tags" -TimeoutSec 5
$present = @($tags.models | ForEach-Object { $_.name })
"models present at $Endpoint :"
$present | ForEach-Object { "  $_" }

$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$reportsDir = Join-Path $repoRoot "eval\.cache\reports"
New-Item -ItemType Directory -Force -Path $reportsDir | Out-Null
$summaryPath = Join-Path $reportsDir "matrix-$stamp.txt"

$results = @()
foreach ($armFile in (Get-ChildItem -Path $ArmsDir -Filter "*.json" | Sort-Object Name)) {
  # PS 5.1 defaults to ANSI for BOM-less files: arm configs are UTF-8 with Chinese prompts
  $arm = Get-Content $armFile.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
  $name = $armFile.BaseName
  if ($present -notcontains $arm.model) {
    $line = "SKIP $name model-not-local: $($arm.model)"
    $line
    Add-Content -Path $summaryPath -Value $line
    $results += [pscustomobject]@{ arm = $name; verdict = "skipped"; exit = "" }
    continue
  }
  "RUN  $name ($($arm.model))"
  # PS 5.1 turns native stderr (e.g. node warnings) into ErrorRecords that throw under Stop:
  # relax locally, stringify every record, then restore.
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = & node $mainJs run --arm $armFile.FullName --runs $Runs 2>&1 | ForEach-Object { "$_" }
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prevEap
  $output | ForEach-Object { "  $_" } | Add-Content -Path $summaryPath
  $verdict = "unknown"
  foreach ($line in $output) {
    if ("$line" -match "final_verdict=(\w+)") { $verdict = $Matches[1]; break }
  }
  Add-Content -Path $summaryPath -Value "== $name exit=$code verdict=$verdict"
  "  -> exit=$code verdict=$verdict"
  $results += [pscustomobject]@{ arm = $name; verdict = $verdict; exit = $code }
}

Add-Content -Path $summaryPath -Value ""
Add-Content -Path $summaryPath -Value "arm`tverdict`texit"
foreach ($r in $results) { Add-Content -Path $summaryPath -Value ("{0}`t{1}`t{2}" -f $r.arm, $r.verdict, $r.exit) }
"matrix summary: $summaryPath"
$results | Format-Table -AutoSize | Out-String
