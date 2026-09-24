<#
.SYNOPSIS
  Signs the Windows installers Tauri does not sign itself (the .msi) with
  Azure Artifact Signing and verifies every released Windows deliverable is
  signed, failing the build if anything would ship unsigned.

.DESCRIPTION
  Tauri's bundler only signs .exe/.dll binaries via bundle.windows.signCommand
  (see src-tauri/tauri.windows.conf.json). The WiX .msi is not signed by it, so
  this script signs the .msi and double-checks the NSIS .exe with the same
  artifact-signing-cli identity, then verifies all deliverables.

  Signing identity comes from src-tauri/tauri.windows.conf.json (endpoint,
  account, certificate profile, description) plus the AZURE_CLIENT_ID,
  AZURE_CLIENT_SECRET and AZURE_TENANT_ID environment variables. Placeholders
  in the config mean "not approved yet" and will deliberately abort the run.

.EXAMPLE
  # Local dry-run once the Trusted Signing account is live (no repo change
  # needed beyond the config placeholders + secrets):
  $env:AZURE_CLIENT_ID = "..."; $env:AZURE_CLIENT_SECRET = "..."; $env:AZURE_TENANT_ID = "..."
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sign-installers.ps1 -Root (Get-Location)
#>
param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..'))
)
$ErrorActionPreference = 'Stop'

$conf = Get-Content (Join-Path $Root 'src-tauri/tauri.windows.conf.json') -Raw | ConvertFrom-Json
$sc = $conf.bundle.windows.signCommand
if (-not $sc) { throw "No bundle.windows.signCommand in src-tauri/tauri.windows.conf.json" }

if ($sc.cmd) {
  $cmd = $sc.cmd
  $args = @($sc.args)
} else {
  $parts = "$sc" -split '\s+'
  $cmd = $parts[0]
  $args = @($parts[1..($parts.Length - 1)])
}
if ($args -inotcontains '%1') { throw "signCommand must contain the %1 placeholder for the artifact path" }
if (($cmd -match '<YOUR_') -or ($args -join ' ' -match '<YOUR_')) {
  throw 'Azure Artifact Signing config is still placeholder. Fill in src-tauri/tauri.windows.conf.json after your account is approved.'
}

foreach ($v in @('AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET', 'AZURE_TENANT_ID')) {
  if (-not [Environment]::GetEnvironmentVariable($v)) { throw "Missing required secret environment variable: $v" }
}

$bundle = Join-Path $Root 'src-tauri/target/release/bundle'
$deliverables = @()
$deliverables += Get-ChildItem -Path (Join-Path $bundle 'nsis') -Filter *.exe -ErrorAction SilentlyContinue
$deliverables += Get-ChildItem -Path (Join-Path $bundle 'msi') -Filter *.msi -ErrorAction SilentlyContinue
if (-not $deliverables) { throw "No NSIS/MSI artifacts found under $bundle" }

foreach ($f in $deliverables) {
  $sig = Get-AuthenticodeSignature $f.FullName
  if ($sig.Status -in @('NotSigned', 'UnknownError')) {
    Write-Host "Signing $($f.Name) ..."
    $runArgs = @($args | ForEach-Object { if ($_ -eq '%1') { $f.FullName } else { $_ } })
    & $cmd @runArgs
    if ($LASTEXITCODE -ne 0) { throw "artifact-signing-cli failed for $($f.Name) (exit $LASTEXITCODE)" }
  } else {
    Write-Host "Already signed ($($sig.Status)): $($f.Name)"
  }
}

$unsigned = @()
foreach ($f in $deliverables) {
  $sig = Get-AuthenticodeSignature $f.FullName
  if ($sig.Status -eq 'NotSigned') { $unsigned += "$($f.FullName) (NotSigned)" }
  else { Write-Host "OK ($($sig.Status)): $($f.Name)" }
}
if ($unsigned) { throw "Unsigned deliverables would ship: $($unsigned -join ', ')" }
Write-Host 'All Windows deliverables are signed.'