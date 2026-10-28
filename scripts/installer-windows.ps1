$script:LainRestartTask = $null
$script:LainInstallMutex = $null

function Get-LainInstallationProcesses([string]$Binary) {
    @(Get-CimInstance Win32_Process -Filter "Name = 'lain.exe'" -ErrorAction Stop |
        Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $Binary })
}

function Get-LainTask {
    $name = 'Lain-' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq $name -and $_.TaskPath -eq '\' }
}

function Assert-LainDestination([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Refusing reparse-point destination: $Path"
    }
}

function Start-LainUpgrade([string]$Directory, $Artifacts) {
    $script:LainBinary = [IO.Path]::GetFullPath((Join-Path $Directory 'lain.exe'))
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($script:LainBinary.ToUpperInvariant()))).Replace('-', '') }
    finally { $hasher.Dispose() }
    $mutex = New-Object Threading.Mutex($false, "Local\LainInstall-$hash")
    try { $acquired = $mutex.WaitOne(30000) }
    catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { $mutex.Dispose(); throw 'Another Lain installation is in progress' }
    $script:LainInstallMutex = $mutex
    Assert-LainDestination $Directory
    Assert-LainDestination $script:LainBinary
    $replacement = @($Artifacts['bin_paths'] | Where-Object { (Split-Path $_ -Leaf) -eq 'lain.exe' })
    if ($replacement.Count -ne 1) { throw 'Installer must contain exactly one lain.exe' }
    $version = & $replacement[0] --version
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^lain \d+\.\d+\.\d+') { throw 'Replacement executable failed its version check' }
    $script:LainTask = Get-LainTask
    if ($script:LainTask -and ($script:LainTask.Description -ne 'Managed by lain setup.' -or
        $script:LainTask.Actions.Execute -ne $script:LainBinary)) {
        throw 'Lain scheduled task belongs to another installation; configure startup manually'
    }
    if (-not (Test-Path -LiteralPath $script:LainBinary)) { return }
    $installedVersion = & $script:LainBinary --version
    if ($LASTEXITCODE -ne 0 -or $installedVersion -notmatch '^lain \d+\.\d+\.\d+') { throw 'Destination is not Lain' }
    if ((Get-FileHash -LiteralPath $script:LainBinary).Hash -eq (Get-FileHash -LiteralPath $replacement[0]).Hash) { return }
    $processes = @(Get-LainInstallationProcesses $script:LainBinary)
    if (-not $processes.Count) { return }
    Write-Host "Outdated Lain processes from ${script:LainBinary}: $($processes.ProcessId -join ', ')"
    $reply = Read-Host 'Stop these processes for the upgrade? Active calls may be interrupted and processes will be terminated [y/N]'
    if ($reply -notmatch '^(?i:y|yes)$') { throw 'Upgrade cancelled; executable remains unchanged' }
    if ($script:LainTask -and $script:LainTask.State -eq 'Running') {
        $script:LainRestartTask = $script:LainTask
        Stop-ScheduledTask -InputObject $script:LainTask -ErrorAction Stop
    }
    foreach ($process in $processes) {
        $current = Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue
        if ($current -and $current.Path -eq $script:LainBinary -and
            [Math]::Abs(($current.StartTime.ToUniversalTime() - $process.CreationDate.ToUniversalTime()).TotalMilliseconds) -lt 1) {
            Stop-Process -InputObject $current -Force -ErrorAction Stop
            if (-not $current.WaitForExit(10000)) { throw 'Lain process did not stop; upgrade aborted' }
        }
    }
    if (@(Get-LainInstallationProcesses $script:LainBinary).Count) { throw 'Lain processes are still running; upgrade aborted' }
}

function Complete-LainUpgrade {
    if (-not $script:LainRestartTask) { return }
    Start-ScheduledTask -InputObject $script:LainRestartTask -ErrorAction Stop
    $arguments = $script:LainRestartTask.Actions.Arguments
    if ($arguments -notmatch '^--home "(.+)" --port (\d+) serve$') { throw 'Cannot verify the Lain scheduled task arguments' }
    $stateDirectory = $Matches[1]
    $port = $Matches[2]
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        $preference = $ErrorActionPreference
        try {
            $ErrorActionPreference = 'Continue'
            & $script:LainBinary --home $stateDirectory --port $port status 2>$null | Out-Null
            $ready = $LASTEXITCODE -eq 0
        } finally { $ErrorActionPreference = $preference }
        if ($ready) { $script:LainRestartTask = $null; return }
        Start-Sleep -Milliseconds 500
    }
    throw 'Lain scheduled task did not become ready; inspect Task Scheduler'
}

function Install-LainExecutable([string]$Source, [string]$Destination) {
    Assert-LainDestination $Destination
    if ((Test-Path -LiteralPath $Destination) -and
        (Get-FileHash -LiteralPath $Destination).Hash -eq (Get-FileHash -LiteralPath $Source).Hash) { return }
    $pending = Join-Path (Split-Path $Destination -Parent) ('.lain-update-' + [Guid]::NewGuid() + '.exe')
    try {
        Copy-Item -LiteralPath $Source -Destination $pending -ErrorAction Stop
        if (Test-Path -LiteralPath $Destination) {
            [IO.File]::Replace($pending, $Destination, [NullString]::Value)
        } else {
            [IO.File]::Move($pending, $Destination)
        }
    } finally {
        if (Test-Path -LiteralPath $pending) { Remove-Item -LiteralPath $pending -Force }
    }
}

function Finish-LainInstall([string]$Directory) {
    Complete-LainUpgrade
    if ($env:LAIN_NO_SETUP -eq '1') {
        Write-Information 'Startup setup skipped (LAIN_NO_SETUP=1)'
    } elseif (-not $script:LainTask) {
        & (Join-Path $Directory 'lain.exe') setup
        if ($LASTEXITCODE -ne 0) { throw 'Lain startup setup failed; run lain serve in a terminal or inspect Task Scheduler' }
    } else {
        Write-Information 'Preserving the existing Lain scheduled task configuration'
    }
}

function Exit-LainUpgrade {
    try { Complete-LainUpgrade }
    finally {
        if ($script:LainInstallMutex) {
            $script:LainInstallMutex.ReleaseMutex()
            $script:LainInstallMutex.Dispose()
            $script:LainInstallMutex = $null
        }
    }
}
