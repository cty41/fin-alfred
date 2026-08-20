param(
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' })
)

$ErrorActionPreference = 'Stop'
$source = Resolve-Path (Join-Path $PSScriptRoot '..\presets\alfred')
$presetRoot = Join-Path $DshHome '.agent-presets'
$target = Join-Path $presetRoot 'alfred'
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -LiteralPath (Join-Path $source 'agent.cordis.yml') -Destination (Join-Path $target 'agent.cordis.yml') -Force
Write-Host "Installed Alfred agent preset at $target"
