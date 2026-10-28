param([Parameter(Mandatory = $true)][string]$Binary)

$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ("lain-upgrade-" + [Guid]::NewGuid())
$null = New-Item -ItemType Directory -Path $root
. (Join-Path $PSScriptRoot '../scripts/installer-windows.ps1')

function Assert($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Get-LainTask { $script:Task }
function Get-LainInstallationProcesses([string]$Path) {
    if ($script:Running) {
        [pscustomobject]@{ ProcessId = 12345; CreationDate = $script:Started }
    }
}
function Read-Host { $script:Prompts++; $script:Answer }
function Get-Process {
    param($Id, $ErrorAction)
    $process = [pscustomobject]@{ Path = $script:LainBinary; StartTime = $script:Started }
    $process | Add-Member ScriptMethod WaitForExit { param($Timeout) $true }
    $process
}
function Stop-Process {
    param($InputObject, [switch]$Force, $ErrorAction)
    $script:Stops++
    $script:Running = $false
}

try {
    $directory = Join-Path $root 'bin with spaces'
    $replacementDirectory = Join-Path $root 'replacement'
    $null = New-Item -ItemType Directory -Path $directory, $replacementDirectory
    $replacement = Join-Path $replacementDirectory 'lain.exe'
    Copy-Item -LiteralPath $Binary -Destination $replacement
    $artifacts = @{ bin_paths = @($replacement) }
    $script:Task = $null
    $script:Running = $false
    $script:Started = [DateTime]::UtcNow
    $script:Stops = 0
    $script:Prompts = 0
    $script:Answer = 'no'

    try { Start-LainUpgrade $directory $artifacts }
    finally { Exit-LainUpgrade }
    Assert (-not (Test-Path (Join-Path $directory 'lain.exe'))) 'Preparation must leave the destination untouched'

    $installed = Join-Path $directory 'lain.exe'
    Copy-Item -LiteralPath $replacement -Destination $installed
    $script:Running = $true
    try { Start-LainUpgrade $directory $artifacts }
    finally { Exit-LainUpgrade }
    Assert ($script:Prompts -eq 0 -and $script:Stops -eq 0) 'Identical executables must keep running without a prompt'

    $stream = [IO.File]::OpenWrite($installed)
    try { $null = $stream.Seek(0, [IO.SeekOrigin]::End); $stream.WriteByte(0) }
    finally { $stream.Dispose() }
    $original = (Get-FileHash -LiteralPath $installed).Hash
    $cancelled = $false
    try { Start-LainUpgrade $directory $artifacts }
    catch { Assert ($_.Exception.Message -like '*Upgrade cancelled*') $_.Exception.Message; $cancelled = $true }
    finally { Exit-LainUpgrade }
    Assert $cancelled 'Declining must abort the upgrade'
    Assert ($script:Running -and $script:Stops -eq 0) 'Declining must preserve running processes'
    Assert ((Get-FileHash -LiteralPath $installed).Hash -eq $original) 'Declining must preserve the executable'
    Assert ($null -eq $script:LainInstallMutex) 'Failed upgrades must release their installation mutex'

    $script:Answer = 'yes'
    try { Start-LainUpgrade $directory $artifacts }
    finally { Exit-LainUpgrade }
    Assert ($script:Stops -eq 1 -and -not $script:Running) 'Approval must stop the selected outdated process'
    Assert ((Get-FileHash -LiteralPath $installed).Hash -eq $original) 'Preparation must leave executable replacement to the installer'
    Install-LainExecutable $replacement $installed
    Assert ((Get-FileHash -LiteralPath $installed).Hash -eq (Get-FileHash -LiteralPath $replacement).Hash) 'Approved installation must publish the complete replacement'

    $script:Task = [pscustomobject]@{ Description = 'User-owned task'; Actions = @{ Execute = $installed } }
    $rejected = $false
    try { Start-LainUpgrade $directory $artifacts }
    catch { Assert ($_.Exception.Message -like '*belongs to another installation*') $_.Exception.Message; $rejected = $true }
    finally { Exit-LainUpgrade }
    Assert $rejected 'An unrelated startup task must remain untouched'

    $script:Task = $null
    $env:LAIN_NO_SETUP = '1'
    Finish-LainInstall $directory
    Write-Output 'Windows installer checks passed: first install, identical build, decline, approval, ownership, and failure cleanup.'
} finally {
    Exit-LainUpgrade
    Remove-Item -LiteralPath $root -Recurse -Force
}
