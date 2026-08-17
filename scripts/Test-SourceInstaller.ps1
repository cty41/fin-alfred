[CmdletBinding()]
param([switch]$KeepArtifacts)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$testRoot = Join-Path $root "target\installer-test"
$installDir = Join-Path $testRoot "localappdata\Programs\fin-alfred"
$binDir = Join-Path $testRoot "bin"
$dataSentinel = Join-Path $testRoot "localappdata\fin-alfred\profiles\keep.txt"
$oldLocalAppData = $env:LOCALAPPDATA
$oldSource = $env:FIN_ALFRED_INSTALL_SOURCE
$oldSkip = $env:FIN_ALFRED_INSTALL_SKIP_PREREQUISITES
$oldBin = $env:FIN_ALFRED_INSTALL_BIN_DIR
$oldPerlDir = $env:FIN_ALFRED_INSTALL_PERL_DIR
$oldPath = $env:Path
$oldUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$gatewayProcess = $null

try {
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
    New-Item -ItemType Directory -Path (Split-Path $dataSentinel) -Force | Out-Null
    Set-Content -LiteralPath $dataSentinel -Value "preserve"
    $env:LOCALAPPDATA = Join-Path $testRoot "localappdata"
    $env:FIN_ALFRED_INSTALL_SOURCE = $root
    $env:FIN_ALFRED_INSTALL_SKIP_PREREQUISITES = "1"
    $env:FIN_ALFRED_INSTALL_BIN_DIR = $binDir
    if (-not $env:FIN_ALFRED_INSTALL_PERL_DIR) {
        $localPerl = Join-Path $root "target\strawberry-perl\Strawberry\perl\bin"
        if (Test-Path -LiteralPath (Join-Path $localPerl "perl.exe")) { $env:FIN_ALFRED_INSTALL_PERL_DIR = $localPerl }
    }
    if ($env:FIN_ALFRED_INSTALL_PERL_DIR) { $env:Path = "$($env:FIN_ALFRED_INSTALL_PERL_DIR);$env:Path" }
    $perl = Get-Command perl.exe -ErrorAction SilentlyContinue
    if (-not $perl) { throw "安装器测试需要 Strawberry Perl" }
    & $perl.Source -MLocale::Maketext::Simple -e "exit 0"
    if ($LASTEXITCODE -ne 0) { throw "当前 Perl 缺少 OpenSSL 构建所需模块，请安装 Strawberry Perl" }

    & (Join-Path $PSScriptRoot "install.ps1") -InstallDir $installDir -NoStart
    if (-not (Test-Path -LiteralPath (Join-Path $installDir "fin-alfred-gateway.exe"))) { throw "Gateway 产物缺失" }
    if (-not (Test-Path -LiteralPath (Join-Path $installDir "dist\index.html"))) { throw "前端产物缺失" }
    if (-not (Test-Path -LiteralPath (Join-Path $installDir "install-manifest.json"))) { throw "安装清单缺失" }
    if (-not (Test-Path -LiteralPath (Join-Path $binDir "fin-alfred.cmd"))) { throw "启动器缺失" }

    $env:FIN_ALFRED_TEST_DATA_DIR = Join-Path $testRoot "gateway-data"
    $env:FIN_ALFRED_BOOTSTRAP_TOKEN = "installer-health-test"
    $gatewayProcess = Start-Process `
        -FilePath (Join-Path $installDir "fin-alfred-gateway.exe") `
        -ArgumentList @("--static-dir", (Join-Path $installDir "dist"), "--no-open") `
        -PassThru -WindowStyle Hidden
    $healthy = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 250
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:43117/health" -Headers @{ Host = "127.0.0.1:43117" }
            if ($health.service -eq "fin-alfred" -and $health.status -eq "ok") { $healthy = $true; break }
        } catch {}
    }
    if (-not $healthy) { throw "安装后的 Gateway 未通过健康检查" }
    Stop-Process -Id $gatewayProcess.Id -Force
    $gatewayProcess.WaitForExit()
    $gatewayProcess = $null

    & (Join-Path $PSScriptRoot "install.ps1") -InstallDir $installDir -NoStart
    & (Join-Path $PSScriptRoot "install.ps1") -InstallDir $installDir -Uninstall
    if (Test-Path -LiteralPath $installDir) { throw "卸载后程序目录仍存在" }
    if (-not (Test-Path -LiteralPath $dataSentinel)) { throw "卸载错误删除了用户数据" }
    Write-Host "source installer test passed"
} finally {
    if ($gatewayProcess -and -not $gatewayProcess.HasExited) { Stop-Process -Id $gatewayProcess.Id -Force }
    [Environment]::SetEnvironmentVariable("Path", $oldUserPath, "User")
    $env:LOCALAPPDATA = $oldLocalAppData
    $env:FIN_ALFRED_INSTALL_SOURCE = $oldSource
    $env:FIN_ALFRED_INSTALL_SKIP_PREREQUISITES = $oldSkip
    $env:FIN_ALFRED_INSTALL_BIN_DIR = $oldBin
    $env:FIN_ALFRED_INSTALL_PERL_DIR = $oldPerlDir
    Remove-Item Env:FIN_ALFRED_TEST_DATA_DIR -ErrorAction SilentlyContinue
    Remove-Item Env:FIN_ALFRED_BOOTSTRAP_TOKEN -ErrorAction SilentlyContinue
    $env:Path = $oldPath
    if (-not $KeepArtifacts -and (Test-Path -LiteralPath $testRoot)) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
