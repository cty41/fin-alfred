[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath
)

$ErrorActionPreference = 'Stop'
$resolvedInstaller = (Resolve-Path -LiteralPath $InstallerPath).Path
$testId = [Guid]::NewGuid().ToString('N')
$testRoot = Join-Path $env:TEMP "margin-safety-package-$testId"
$installDirectory = Join-Path $testRoot 'app'
$dataDirectory = Join-Path $testRoot 'data'
$previousTestDataDirectory = $env:MARGIN_SAFETY_TEST_DATA_DIR
$sentinel = Join-Path $dataDirectory "package-test-$testId.sentinel"
$appProcess = $null

try {
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    $env:MARGIN_SAFETY_TEST_DATA_DIR = $dataDirectory
    $install = Start-Process -FilePath $resolvedInstaller -ArgumentList @('/S', "/D=$installDirectory") -Wait -PassThru -WindowStyle Hidden
    if ($install.ExitCode -ne 0) {
        throw "NSIS installer exited with code $($install.ExitCode)"
    }

    $application = Get-ChildItem -LiteralPath $installDirectory -Filter 'margin-safety-desktop.exe' -Recurse | Select-Object -First 1
    if (-not $application) {
        throw 'Installed application executable was not found'
    }

    $appProcess = Start-Process -FilePath $application.FullName -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 5
    if ($appProcess.HasExited) {
        throw "Installed application exited during startup with code $($appProcess.ExitCode)"
    }
    Stop-Process -Id $appProcess.Id
    $appProcess.WaitForExit()
    $appProcess = $null

    $profileDatabase = Join-Path $dataDirectory 'profiles\profile-xiaomi-real.db'
    if (-not (Test-Path -LiteralPath $profileDatabase)) {
        throw 'Application did not create the encrypted profile database'
    }
    $header = [System.IO.File]::ReadAllBytes($profileDatabase)
    $plainSqliteHeader = [System.Text.Encoding]::ASCII.GetBytes('SQLite format 3')
    if ($header.Length -ge $plainSqliteHeader.Length) {
        $visibleHeader = [System.Text.Encoding]::ASCII.GetString($header, 0, $plainSqliteHeader.Length)
        if ($visibleHeader -eq 'SQLite format 3') {
            throw 'Profile database has a plaintext SQLite header'
        }
    }

    $appProcess = Start-Process -FilePath $application.FullName -PassThru -WindowStyle Hidden
    Start-Sleep -Seconds 3
    if ($appProcess.HasExited) {
        throw "Installed application failed to restart with its existing profile: $($appProcess.ExitCode)"
    }
    Stop-Process -Id $appProcess.Id
    $appProcess.WaitForExit()
    $appProcess = $null

    New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
    Set-Content -LiteralPath $sentinel -Value 'must survive uninstall' -NoNewline

    $uninstaller = Get-ChildItem -LiteralPath $installDirectory -Filter 'uninstall.exe' -Recurse | Select-Object -First 1
    if (-not $uninstaller) {
        throw 'NSIS uninstaller was not found'
    }
    $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden
    if ($uninstall.ExitCode -ne 0) {
        throw "NSIS uninstaller exited with code $($uninstall.ExitCode)"
    }
    if (-not (Test-Path -LiteralPath $sentinel)) {
        throw 'Uninstall removed application data'
    }

    [pscustomobject]@{
        Installer = $resolvedInstaller
        InstalledExecutable = $application.FullName
        Startup = 'passed'
        Restart = 'passed'
        EncryptedDatabase = 'passed'
        Uninstall = 'passed'
        DataRetention = 'passed'
    }
}
finally {
    if ($appProcess -and -not $appProcess.HasExited) {
        Stop-Process -Id $appProcess.Id -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $sentinel -Force -ErrorAction SilentlyContinue
    $env:MARGIN_SAFETY_TEST_DATA_DIR = $previousTestDataDirectory
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
