<#
.SYNOPSIS
  fin-alfred v2 one-command installer (Node.js stack only).
.DESCRIPTION
  Installs fin-alfred from source: Node deps, TypeScript build, and the
  uv-managed AKShare environment. Creates a 'fin-alfred' shim command.
  Data stays in %LOCALAPPDATA%\fin-alfred and is never touched on uninstall.
.EXAMPLE
  irm https://raw.githubusercontent.com/cty41/fin-alfred/main/scripts/install.ps1 | iex
#>
param([switch]$Uninstall)

$ErrorActionPreference = "Stop"
$installRoot = Join-Path $env:LOCALAPPDATA "Programs\fin-alfred"
$shimDir = Join-Path $env:LOCALAPPDATA "Programs\fin-alfred\bin"

if ($Uninstall) {
  if (Test-Path $installRoot) {
    Remove-Item -Recurse -Force $installRoot
    Write-Host "Removed $installRoot (local data in %LOCALAPPDATA%\fin-alfred preserved)."
  } else {
    Write-Host "fin-alfred is not installed."
  }
  return
}

# 1. Check prerequisites
Write-Host "==> Checking prerequisites..."
$nodeOk = $false
try { $nodeOk = ([version](node --version).TrimStart('v')).Major -ge 24 } catch {}
if (-not $nodeOk) {
  Write-Host "Node.js >= 24 required. Install with: winget install OpenJS.NodeJS" -ForegroundColor Red
  exit 1
}
$gitOk = $null -ne (Get-Command git -ErrorAction SilentlyContinue)
if (-not $gitOk) { Write-Host "git required. Install with: winget install Git.Git" -ForegroundColor Red; exit 1 }
$uvOk = $null -ne (Get-Command uv -ErrorAction SilentlyContinue)
if (-not $uvOk) {
  Write-Host "==> Installing uv..."
  irm https://astral.sh/uv/install.ps1 | iex
}

# 2. Clone or pull source
Write-Host "==> Fetching source..."
$srcDir = Join-Path $installRoot "src"
if (Test-Path (Join-Path $srcDir ".git")) {
  Push-Location $srcDir; git pull --ff-only; Pop-Location
} else {
  New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
  git clone --depth 1 https://github.com/cty41/fin-alfred.git $srcDir
}

# 3. Install and build
Write-Host "==> Installing dependencies (npm ci)..."
Push-Location $srcDir
npm ci
Write-Host "==> Building TypeScript..."
npm run build
Write-Host "==> Setting up AKShare environment (uv)..."
uv sync --frozen --project data-provider
Pop-Location

# 4. Create shim
Write-Host "==> Creating 'fin-alfred' command..."
New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
$shim = Join-Path $shimDir "fin-alfred.cmd"
@"
@echo off
node "%LOCALAPPDATA%\Programs\fin-alfred\src\packages\cli\dist\main.js" %*
"@ | Set-Content -Encoding ascii $shim

$gatewayShim = Join-Path $shimDir "fin-alfred-web.cmd"
@"
@echo off
call "%LOCALAPPDATA%\Programs\fin-alfred\bin\fin-alfred.cmd" gateway %*
"@ | Set-Content -Encoding ascii $gatewayShim

# 5. PATH
$currentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($currentUserPath -notlike "*$shimDir*") {
  [Environment]::SetEnvironmentVariable("Path", "$currentUserPath;$shimDir", "User")
  Write-Host "Added $shimDir to user PATH. Open a new terminal to use 'fin-alfred'."
} else {
  Write-Host "PATH already configured."
}

Write-Host ""
Write-Host "fin-alfred installed successfully!" -ForegroundColor Green
Write-Host "  CLI:   fin-alfred"
Write-Host "  Gateway:   fin-alfred gateway"
Write-Host "  Dashboard: fin-alfred dashboard"
Write-Host "  Legacy:    fin-alfred-web"
Write-Host "  Data:  %LOCALAPPDATA%\fin-alfred"
