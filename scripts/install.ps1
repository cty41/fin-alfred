[CmdletBinding()]
param(
    [string]$Ref = "main",
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Programs\fin-alfred"),
    [switch]$NoStart,
    [switch]$DryRun,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0

$script:Repository = "cty41/fin-alfred"
$script:RequiredNode = [version]"24.19.0"
$script:RequiredRust = "1.97.1"
$script:InstallRoot = [IO.Path]::GetFullPath($InstallDir)
$script:BinRoot = if ($env:FIN_ALFRED_INSTALL_BIN_DIR) {
    [IO.Path]::GetFullPath($env:FIN_ALFRED_INSTALL_BIN_DIR)
} else {
    Join-Path $env:USERPROFILE ".local\bin"
}
$script:Launcher = Join-Path $script:BinRoot "fin-alfred.cmd"
$script:ManagedMarker = "fin-alfred managed launcher"

function Write-Step([string]$Message) {
    Write-Host "[fin-alfred] $Message" -ForegroundColor Cyan
}

function Assert-SafeInstallPath {
    $localAppData = [IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\')
    if ($script:InstallRoot.Length -lt ($localAppData.Length + 8) -or
        -not $script:InstallRoot.StartsWith($localAppData, [StringComparison]::OrdinalIgnoreCase)) {
        throw "安装目录必须位于 LOCALAPPDATA 下的独立子目录：$script:InstallRoot"
    }
}

function Refresh-ProcessPath {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $extra = @(
        $env:FIN_ALFRED_INSTALL_PERL_DIR,
        (Join-Path $env:USERPROFILE ".cargo\bin"),
        "C:\Strawberry\perl\bin",
        "C:\Program Files\nodejs"
    ) | Where-Object { $_ } | Select-Object -Unique
    $extra = $extra -join ";"
    $env:Path = "$machine;$user;$extra"
}

function Test-PerlRequirement {
    $perl = Get-Command "perl.exe" -ErrorAction SilentlyContinue
    if (-not $perl) { return $false }
    & $perl.Source -MLocale::Maketext::Simple -e "exit 0" 2>$null
    return $LASTEXITCODE -eq 0
}

function Get-CommandVersion([string]$Command, [string[]]$Arguments) {
    $resolved = Get-Command $Command -ErrorAction SilentlyContinue
    if (-not $resolved) { return $null }
    try { return (& $resolved.Source @Arguments 2>$null | Select-Object -First 1) } catch { return $null }
}

function Test-NodeRequirement {
    $text = Get-CommandVersion "node" @("--version")
    if (-not $text) { return $false }
    try {
        $version = [version]($text.Trim().TrimStart('v'))
        return $version.Major -eq 24 -and $version -ge $script:RequiredNode
    } catch { return $false }
}

function Test-RustRequirement {
    $text = Get-CommandVersion "rustc" @("--version")
    return $text -and $text -match "rustc\s+1\.97\.1(?:\s|$)"
}

function Test-VcTools {
    if (Get-Command "cl.exe" -ErrorAction SilentlyContinue) { return $true }
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path -LiteralPath $vswhere)) { return $false }
    $installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    return [bool]$installation
}

function Install-WingetPackage([string]$Id, [string[]]$ExtraArguments = @()) {
    if (-not (Get-Command "winget.exe" -ErrorAction SilentlyContinue)) {
        throw "缺少 winget。请从 Microsoft Store 安装 App Installer 后重新执行。"
    }
    Write-Step "安装依赖 $Id"
    if ($DryRun) { return }
    $arguments = @("install", "--id", $Id, "--exact", "--accept-package-agreements", "--accept-source-agreements", "--silent") + $ExtraArguments
    & winget.exe @arguments
    if ($LASTEXITCODE -ne 0) { throw "winget 安装 $Id 失败，退出码 $LASTEXITCODE" }
    Refresh-ProcessPath
}

function Ensure-Prerequisites {
    Refresh-ProcessPath
    if ($env:FIN_ALFRED_INSTALL_SKIP_PREREQUISITES -eq "1") {
        Write-Step "测试模式：跳过系统依赖安装"
        return
    }
    if (-not (Test-NodeRequirement)) { Install-WingetPackage "OpenJS.NodeJS.LTS" }
    if (-not $DryRun -and -not (Get-Command "npm.cmd" -ErrorAction SilentlyContinue)) { throw "Node 已安装但 npm 不可用；请重新打开 PowerShell 后重试。" }
    if (-not (Get-Command "rustup.exe" -ErrorAction SilentlyContinue)) { Install-WingetPackage "Rustlang.Rustup" }
    if (-not (Test-PerlRequirement)) { Install-WingetPackage "StrawberryPerl.StrawberryPerl" }
    if (-not (Test-VcTools)) {
        Install-WingetPackage "Microsoft.VisualStudio.2022.BuildTools" @(
            "--override", "--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
        )
    }
    if ($DryRun) { return }
    Refresh-ProcessPath
    if (-not (Test-NodeRequirement)) { throw "需要 Node 24.19.x。依赖安装后请重新打开 PowerShell并再次运行安装命令。" }
    & rustup.exe toolchain install $script:RequiredRust --profile minimal
    if ($LASTEXITCODE -ne 0) { throw "Rust $($script:RequiredRust) 安装失败" }
    if (-not (Test-RustRequirement)) {
        $rustc = Join-Path $env:USERPROFILE ".cargo\bin\rustc.exe"
        $text = & $rustc "+$($script:RequiredRust)" --version
        if ($text -notmatch "1\.97\.1") { throw "Rust $($script:RequiredRust) 不可用" }
    }
    if (-not (Test-PerlRequirement) -or -not (Test-VcTools)) {
        throw "C++ Build Tools 或 Strawberry Perl 尚未生效；请重启 Windows 后重新执行同一命令。"
    }
}

function Add-UserPath([string]$Path) {
    $current = [Environment]::GetEnvironmentVariable("Path", "User")
    $entries = @($current -split ';' | Where-Object { $_ })
    if ($entries | Where-Object { $_.TrimEnd('\') -ieq $Path.TrimEnd('\') }) { return }
    [Environment]::SetEnvironmentVariable("Path", (($entries + $Path) -join ';'), "User")
    $env:Path = "$env:Path;$Path"
}

function Assert-LauncherOwnership {
    if (-not (Test-Path -LiteralPath $script:Launcher)) { return }
    $content = Get-Content -LiteralPath $script:Launcher -Raw
    if ($content -notmatch [regex]::Escape($script:ManagedMarker)) {
        throw "拒绝覆盖非 fin-alfred 管理的启动器：$script:Launcher"
    }
}

function Remove-UserPathIfEmpty([string]$Path) {
    if ((Test-Path -LiteralPath $Path) -and (Get-ChildItem -LiteralPath $Path -Force | Select-Object -First 1)) { return }
    $current = [Environment]::GetEnvironmentVariable("Path", "User")
    $entries = @($current -split ';' | Where-Object { $_ -and $_.TrimEnd('\') -ine $Path.TrimEnd('\') })
    [Environment]::SetEnvironmentVariable("Path", ($entries -join ';'), "User")
}

function Remove-Installation {
    Assert-SafeInstallPath
    Write-Step "卸载程序；保留 $env:LOCALAPPDATA\fin-alfred 中的档案"
    if ($DryRun) { return }
    if (Test-Path -LiteralPath $script:Launcher) {
        $content = Get-Content -LiteralPath $script:Launcher -Raw
        if ($content -notmatch [regex]::Escape($script:ManagedMarker)) {
            throw "拒绝删除非 fin-alfred 管理的启动器：$script:Launcher"
        }
        Remove-Item -LiteralPath $script:Launcher -Force
    }
    if (Test-Path -LiteralPath $script:InstallRoot) {
        Remove-Item -LiteralPath $script:InstallRoot -Recurse -Force
    }
    Remove-UserPathIfEmpty $script:BinRoot
    Write-Step "卸载完成；投资档案和系统凭据未删除"
}

function Resolve-Source([string]$WorkRoot) {
    if ($env:FIN_ALFRED_INSTALL_SOURCE) {
        $source = [IO.Path]::GetFullPath($env:FIN_ALFRED_INSTALL_SOURCE)
        if (-not (Test-Path -LiteralPath (Join-Path $source "Cargo.toml"))) { throw "测试源码目录无效：$source" }
        return @{ Path = $source; Sha = "local-source" }
    }
    Write-Step "解析 GitHub 源码引用 $Ref"
    $headers = @{ "User-Agent" = "fin-alfred-installer"; "Accept" = "application/vnd.github+json" }
    $escapedRef = [Uri]::EscapeDataString($Ref)
    $commit = Invoke-RestMethod -Uri "https://api.github.com/repos/$($script:Repository)/commits/$escapedRef" -Headers $headers
    $sha = [string]$commit.sha
    if ($sha -notmatch '^[0-9a-f]{40}$') { throw "GitHub 返回了无效提交 SHA" }
    $archive = Join-Path $WorkRoot "source.zip"
    Invoke-WebRequest -Uri "https://codeload.github.com/$($script:Repository)/zip/$sha" -OutFile $archive -UseBasicParsing
    $expanded = Join-Path $WorkRoot "source"
    Expand-Archive -LiteralPath $archive -DestinationPath $expanded
    $source = Get-ChildItem -LiteralPath $expanded -Directory | Select-Object -First 1
    if (-not $source) { throw "源码归档为空" }
    return @{ Path = $source.FullName; Sha = $sha }
}

function Build-And-Install {
    Assert-SafeInstallPath
    Assert-LauncherOwnership
    Ensure-Prerequisites
    if ($DryRun) {
        Write-Step "将从 $Ref 构建并安装到 $script:InstallRoot"
        return
    }
    $workRoot = Join-Path ([IO.Path]::GetTempPath()) ("fin-alfred-install-" + [Guid]::NewGuid().ToString("N"))
    $staging = "$($script:InstallRoot).staging-$([Guid]::NewGuid().ToString('N'))"
    $previous = "$($script:InstallRoot).previous-$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $workRoot -Force | Out-Null
    try {
        $resolved = Resolve-Source $workRoot
        $source = $resolved.Path
        $existingManifestPath = Join-Path $script:InstallRoot "install-manifest.json"
        if ((Test-Path -LiteralPath $existingManifestPath) -and
            (Test-Path -LiteralPath (Join-Path $script:InstallRoot "fin-alfred-gateway.exe")) -and
            (Test-Path -LiteralPath (Join-Path $script:InstallRoot "dist\index.html")) -and
            (Test-Path -LiteralPath $script:Launcher)) {
            $existingManifest = Get-Content -LiteralPath $existingManifestPath -Raw | ConvertFrom-Json
            if ($existingManifest.sourceCommit -eq $resolved.Sha -and $existingManifest.sourceRef -eq $Ref) {
                Write-Step "提交 $($resolved.Sha) 已安装，无需重复构建"
                if (-not $NoStart) { & $script:Launcher }
                return
            }
        }
        Write-Step "安装锁定的 npm 依赖"
        Push-Location $source
        try {
            & npm.cmd ci
            if ($LASTEXITCODE -ne 0) { throw "npm ci 失败" }
            & npm.cmd run build
            if ($LASTEXITCODE -ne 0) { throw "前端构建失败" }
            & cargo.exe "+$($script:RequiredRust)" build --release -p fin-alfred-gateway
            if ($LASTEXITCODE -ne 0) { throw "Rust Gateway 构建失败" }
        } finally { Pop-Location }

        New-Item -ItemType Directory -Path $staging -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $source "target\release\fin-alfred-gateway.exe") -Destination $staging
        Copy-Item -LiteralPath (Join-Path $source "dist") -Destination $staging -Recurse
        $gateway = Join-Path $staging "fin-alfred-gateway.exe"
        $package = Get-Content -LiteralPath (Join-Path $source "package.json") -Raw | ConvertFrom-Json
        $manifest = [ordered]@{
            applicationVersion = [string]$package.version
            sourceRef = $Ref
            sourceCommit = [string]$resolved.Sha
            installedAt = [DateTime]::UtcNow.ToString("o")
            nodeVersion = (Get-CommandVersion "node" @("--version"))
            rustVersion = (Get-CommandVersion "rustc" @("+$($script:RequiredRust)", "--version"))
            gatewaySha256 = (Get-FileHash -LiteralPath $gateway -Algorithm SHA256).Hash.ToLowerInvariant()
        }
        $manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $staging "install-manifest.json") -Encoding UTF8

        if (Test-Path -LiteralPath $script:InstallRoot) { Move-Item -LiteralPath $script:InstallRoot -Destination $previous }
        try {
            Move-Item -LiteralPath $staging -Destination $script:InstallRoot
        } catch {
            if (Test-Path -LiteralPath $previous) { Move-Item -LiteralPath $previous -Destination $script:InstallRoot }
            throw
        }
        if (Test-Path -LiteralPath $previous) { Remove-Item -LiteralPath $previous -Recurse -Force }

        New-Item -ItemType Directory -Path $script:BinRoot -Force | Out-Null
        $exe = Join-Path $script:InstallRoot "fin-alfred-gateway.exe"
        $dist = Join-Path $script:InstallRoot "dist"
        @(
            "@echo off",
            "rem $($script:ManagedMarker)",
            ('"{0}" --static-dir "{1}" %*' -f $exe, $dist)
        ) | Set-Content -LiteralPath $script:Launcher -Encoding ASCII
        Add-UserPath $script:BinRoot
        Write-Step "安装完成：$script:Launcher"
    } finally {
        if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
        if (Test-Path -LiteralPath $workRoot) { Remove-Item -LiteralPath $workRoot -Recurse -Force }
    }
    if (-not $NoStart) {
        Write-Step "启动 fin-alfred；按 Ctrl+C 停止"
        & $script:Launcher
    }
}

if ($Uninstall) { Remove-Installation } else { Build-And-Install }
