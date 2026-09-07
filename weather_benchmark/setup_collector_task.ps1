# Registers the benchmark collector as a supervised Windows Scheduled Task.
#
# Why: the collector previously died silently (~23 h outage on 2026-07-18/19,
# and again whenever the PC sleeps or the console closes). A scheduled task
# restarts it automatically and survives logoff/reboot.
#
# Run ONCE from an elevated (Administrator) PowerShell:
#   powershell -ExecutionPolicy Bypass -File setup_collector_task.ps1
#
# Afterwards: kill any manually-started collector.py console (this script does
# that for you). The task starts the collector at logon AND re-checks every 5
# minutes, so a collector that dies is back within 5 minutes.
#
# Why the 5-minute trigger and not just -RestartCount: Task Scheduler's restart
# setting did not fire for the 2026-08-31 death (console closed -> exit
# 0xC000013A, which it treats as a normal stop), leaving a ~15 h gap. A
# repeating trigger plus MultipleInstances=IgnoreNew is the reliable pattern:
# the tick is a no-op while the collector is alive, and relaunches it when not.
# Manage it in Task Scheduler under the name "WeatherHQ Collector".
#
# NOTE on sleep: the task keeps the *process* alive, but Windows sleep still
# pauses everything. For 24/7 collection, disable sleep while plugged in:
#   powercfg /change standby-timeout-ac 0

$name   = "WeatherHQ Collector"
$workDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Elevation check — Register-ScheduledTask silently confuses people otherwise
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "ERROR: this window is not elevated. Right-click PowerShell -> 'Run as administrator' and re-run." -ForegroundColor Red
    exit 1
}

# Launch via the .cmd wrapper: pins the working directory and appends output
# to collector.out.log so crashes leave evidence.
$action = New-ScheduledTaskAction -Execute (Join-Path $workDir "run_collector.cmd") `
    -WorkingDirectory $workDir

# Two triggers: start at logon, then re-check every 5 minutes forever. The
# 5-minute tick is harmless while the collector runs because MultipleInstances
# is IgnoreNew (below) -- Task Scheduler skips the start when an instance is
# already running. Omitting -RepetitionDuration means "repeat indefinitely".
$triggers = @(
    (New-ScheduledTaskTrigger -AtLogOn),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
        -RepetitionInterval (New-TimeSpan -Minutes 5))
)

$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 5) `
    -ExecutionTimeLimit (New-TimeSpan -Days 3650) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable -DontStopOnIdleEnd

Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers `
    -Settings $settings -Description "Weather HQ benchmark collector (auto-restart)" -Force

# Hand-started collectors are invisible to the task (IgnoreNew only guards the
# task's own instances), so two would write the same JSONL files. Clear them out
# before the task takes ownership.
$stray = Get-CimInstance Win32_Process -Filter "Name like '%python%'" |
    Where-Object { $_.CommandLine -like "*collector.py*" }
foreach ($p in $stray) {
    Write-Host "Stopping hand-started collector (PID $($p.ProcessId))..."
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}

Write-Host "Registered '$name'. Starting it now..."
Start-ScheduledTask -TaskName $name
Write-Host "Done. Check Task Scheduler or data\logs\ for fresh records."
