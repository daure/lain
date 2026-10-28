param(
    [string]$Binary = (Join-Path $PSScriptRoot '../target/release/lain.exe'),
    [string]$BinDir = (Join-Path $HOME '.local/bin')
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'installer-windows.ps1')
Assert-LainDestination $BinDir
$null = New-Item -ItemType Directory -Force -Path $BinDir
$BinDir = (Resolve-Path -LiteralPath $BinDir).Path
$Binary = (Resolve-Path -LiteralPath $Binary).Path
try {
    Start-LainUpgrade $BinDir @{ bin_paths = @($Binary) }
    $destination = Join-Path $BinDir 'lain.exe'
    Install-LainExecutable $Binary $destination
    Complete-LainUpgrade
    Write-Host "Installed $destination"
    Write-Host "Setup command: & '$($destination.Replace("'", "''"))' setup"
    Write-Host "Add $BinDir to PATH if needed. Preview setup with --dry-run."
} finally {
    Exit-LainUpgrade
}
