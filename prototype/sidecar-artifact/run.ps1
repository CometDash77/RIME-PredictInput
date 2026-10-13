# PROTOTYPE build + measure driver for issue #9 (throwaway). One command: pwsh ./run.ps1
$ErrorActionPreference = 'Continue'
$proto = $PSScriptRoot
$repo  = (Resolve-Path (Join-Path $proto '..\..')).Path
$art   = Join-Path $proto 'artifacts'
$build = Join-Path $proto 'build'
$tool  = Join-Path $proto 'toolchain'
$log   = Join-Path $proto 'build-log.txt'
New-Item -ItemType Directory -Force -Path $art, $build, $tool | Out-Null

function Log($m) { $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m; Write-Host $line; Add-Content -Path $log -Value $line }
function Step($name, [scriptblock]$body) {
  Log "START $name"
  try { & $body; Log "OK    $name" } catch { Log "FAIL  $name :: $($_.Exception.Message)" }
}

$free = (Get-PSDrive D).Free / 1GB
Log ("disk D: free = {0:N1} GB" -f $free)
if ($free -lt 2) { Log "ABORT: need >= 2GB free on D:"; exit 1 }

Step "dist-build" {
  Push-Location $repo; pnpm run build 2>&1 | ForEach-Object { "$_" } | Add-Content $log; Pop-Location
  if (-not (Test-Path (Join-Path $repo 'dist\cli\main.js'))) { throw "dist/cli/main.js missing after tsc" }
}

Step "proto-deps-koffi" {
  if (-not (Test-Path (Join-Path $proto 'node_modules\koffi'))) {
    Push-Location $proto; pnpm install --no-frozen-lockfile 2>&1 | Add-Content $log; Pop-Location
  }
}

Step "esbuild-bundles" {
  Push-Location $proto
  node strip-guard.mjs 2>&1 | Add-Content $log
  npx --yes esbuild sea-entry.mjs  --bundle --platform=node --format=cjs --outfile=build\sea-bundle.cjs   2>&1 | Add-Content $log
  npx --yes esbuild deno-entry.mjs --bundle --platform=node --format=esm --outfile=build\deno-bundle.mjs 2>&1 | Add-Content $log
  npx --yes esbuild probe-node.cjs --bundle --platform=node --format=cjs --external:koffi --outfile=build\probe-sea.cjs 2>&1 | Add-Content $log
  if (-not (Test-Path (Join-Path $build 'sea-bundle.cjs')))  { throw "sea-bundle.cjs missing" }
  if (-not (Test-Path (Join-Path $build 'deno-bundle.mjs'))) { throw "deno-bundle.mjs missing" }
  if (-not (Test-Path (Join-Path $build 'probe-sea.cjs')))   { throw "probe-sea.cjs missing" }
  Pop-Location
}

function Build-Sea([string]$mainJs, [string]$configJs, [string]$outExe) {
  Push-Location $proto
  $cfg = Get-Content (Join-Path $proto 'sea-config.json') -Raw | ConvertFrom-Json
  $cfg.main = $mainJs; $cfg.output = "build\" + ((Split-Path $configJs -Leaf) -replace '\.json$','.blob')
  $cfg | ConvertTo-Json | Set-Content (Join-Path $build $configJs)
  node --experimental-sea-config (Join-Path $build $configJs) 2>&1 | Add-Content $log
  $blob = Join-Path $build ((Split-Path $configJs -Leaf) -replace '.json$', '.blob')
  if (-not (Test-Path $blob)) { throw "SEA blob missing: $blob" }
  Copy-Item (Get-Command node).Source $outExe -Force
  npx --yes postject $outExe NODE_SEA_BLOB $blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 2>&1 | Add-Content $log
  # verify the exe actually boots; if injection broke it, strip cert dir and retry once
  $probe = & $outExe 'exit' 2>&1
  if ($LASTEXITCODE -ne 0) {
    Log "postject output suspect; stripping cert dir and retrying"
    node (Join-Path $proto 'pe.mjs') strip-cert $outExe 2>&1 | Add-Content $log
    npx --yes postject $outExe NODE_SEA_BLOB $blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite 2>&1 | Add-Content $log
  }
  Pop-Location
}

Step "sea-real"    { Build-Sea 'build/sea-bundle.cjs'  'sea-real-config.json'  (Join-Path $art 'rime-sea.exe') }
Step "sea-probe"   { Build-Sea 'build/probe-sea.cjs'   'sea-probe-config.json' (Join-Path $art 'probe-sea.exe') }

Step "bun-builds" {
  Push-Location $proto
  bun build --compile bun-entry.mjs   --outfile (Join-Path $art 'rime-bun.exe')   2>&1 | Add-Content $log
  bun build --compile probe-bun.mjs   --outfile (Join-Path $art 'probe-bun.exe')  2>&1 | Add-Content $log
  if (-not (Test-Path (Join-Path $art 'probe-bun.exe'))) { throw "bun probe exe missing" }
  Pop-Location
}

$denoExe = Join-Path $tool 'deno.exe'
Step "deno-toolchain" {
  if (-not (Test-Path $denoExe)) {
    $zip = Join-Path $tool 'deno.zip'
    Invoke-WebRequest -Uri 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip' -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $tool -Force
  }
  $v = & $denoExe --version 2>&1 | Select-Object -First 1
  Log "deno: $v"
}

Step "deno-builds" {
  Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $art 'probe-deno.exe'), (Join-Path $art 'rime-deno.exe')
  Push-Location $proto
  & $denoExe compile --allow-all --target x86_64-pc-windows-msvc --output (Join-Path $art 'probe-deno.exe') probe-deno.mjs 2>&1 | Add-Content $log
  & $denoExe compile --allow-all --target x86_64-pc-windows-msvc --output (Join-Path $art 'rime-deno.exe')  (Join-Path $build 'deno-bundle.mjs') 2>&1 | Add-Content $log
  Pop-Location
  if (-not (Test-Path (Join-Path $art 'probe-deno.exe'))) { throw "probe-deno.exe missing" }
  if (-not (Test-Path (Join-Path $art 'rime-deno.exe')))  { throw "rime-deno.exe missing" }
}

Step "pkg-builds" {
  Push-Location $proto
  npx --yes @yao-pkg/pkg@latest probe-node.cjs  -t node22-win-x64 --output (Join-Path $art 'probe-pkg.exe') 2>&1 | Add-Content $log
  npx --yes @yao-pkg/pkg@latest build/sea-bundle.cjs -t node22-win-x64 --output (Join-Path $art 'rime-pkg.exe') 2>&1 | Add-Content $log
  Pop-Location
}

Step "helper-csc" {
  $csc = Get-ChildItem 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' -ErrorAction SilentlyContinue
  if (-not $csc) { $csc = Get-ChildItem 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe' }
  $helperExe = Join-Path $proto 'helper.exe'
  Remove-Item $helperExe -Force -ErrorAction SilentlyContinue
  & $csc.FullName /nologo /target:exe /r:System.dll "/out:$helperExe" (Join-Path $proto 'helper.cs') 2>&1 | Add-Content $log
  if (-not (Test-Path $helperExe)) { throw "helper.exe missing" }
}

Step "gui-variants" {
  node (Join-Path $proto 'pe.mjs') copy-gui (Join-Path $art 'probe-sea.exe')  (Join-Path $art 'probe-sea-gui.exe')
  node (Join-Path $proto 'pe.mjs') copy-gui (Join-Path $art 'probe-bun.exe')  (Join-Path $art 'probe-bun-gui.exe')
  node (Join-Path $proto 'pe.mjs') copy-gui (Join-Path $art 'probe-deno.exe') (Join-Path $art 'probe-deno-gui.exe')
  node (Join-Path $proto 'pe.mjs') copy-gui (Join-Path $art 'probe-pkg.exe')  (Join-Path $art 'probe-pkg-gui.exe')
  node (Join-Path $proto 'pe.mjs') copy-gui (Join-Path $art 'rime-sea.exe')   (Join-Path $art 'rime-sea-gui.exe')
}

Step "measurements" {
  Push-Location $proto
  node run-measurements.mjs
  Pop-Location
}
Log "run.ps1 complete"
