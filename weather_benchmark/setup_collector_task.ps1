# Registers the benchmark collector and its health alert as Windows Scheduled
# Tasks that run whether or not anyone is logged on.
#
# Run from an elevated (Administrator) PowerShell:
#   powershell -ExecutionPolicy Bypass -File setup_collector_task.ps1
#   powershell -ExecutionPolicy Bypass -File setup_collector_task.ps1 -HealthOnly
#
# -HealthOnly registers/refreshes only the alert task and leaves the running
# collector alone. Without it, the running collector is stopped and restarted
# under the new task definition (a gap of a few seconds).
#
# Task 1, "WeatherHQ Collector" -> run_collector.cmd
#   Triggers: at startup, at logon, and every 5 minutes forever. With
#   MultipleInstances=IgnoreNew the 5-minute tick is a no-op while the
#   collector runs and relaunches it when it has died.
#   History: Task Scheduler's restart setting did not fire for the 2026-08-31
#   death (console closed -> exit 0xC000013A, treated as a normal stop), so
#   the repeating trigger is what actually revives it.
#   Principal: S4U ("Run whether user is logged on or not", no stored
#   password). The old LogonType Interactive only ran while John was logged
#   on, so the Windows Update reboot on 2026-10-14 stopped collection until
#   the next logon on 2026-10-24.
#
# Task 2, "WeatherHQ Health Alert" -> run_health_check.cmd (health_check.py --alert)
#   Every 15 minutes, also S4U. Notifies when the newest record of any city is
#   older than 15 min or a city has more polls than one collector produces
#   (duplicate collectors). Channels: msg.exe popup on John's desktop session
#   (S4U tasks have no desktop of their own, so no toast) and, if configured,
#   an ntfy.sh topic (collector_config.yaml alerts.ntfy_topic) for the phone.
#   The ntfy topic is the only channel that works while nobody is logged on.
#
# S4U needs the "Log on as a batch job" right, which Administrators have by
# default. S4U tasks cannot reach network shares; the collector only uses the
# internet, which is fine.
#
# Sleep still pauses everything. For 24/7 collection disable sleep on AC:
#   powercfg /change standby-timeout-ac 0

param(
    [switch]$HealthOnly,
    [string]$User = "$env:USERDOMAIN\$env:USERNAME"
)

$name       = "WeatherHQ Collector"
$healthName = "WeatherHQ Health Alert"
$workDir    = Split-Path -Parent $MyInvocation.MyCommand.Path

# Elevation check: Register-ScheduledTask silently confuses people otherwise
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "ERROR: this window is not elevated. Right-click PowerShell -> 'Run as administrator' and re-run." -ForegroundColor Red
    exit 1
}

$ErrorActionPreference = 'Stop'

# Run as John whether logged on or not, without storing a password
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Limited

# -- Task 2: health alert (independent of the collector task) ----------------

$healthAction = New-ScheduledTaskAction -Execute (Join-Path $workDir "run_health_check.cmd") `
    -WorkingDirectory $workDir
# First tick 15 min after registration, then every 15 min forever (survives
# reboots: the repetition is anchored to the start time, not to a logon).
$healthTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(15) `
    -RepetitionInterval (New-TimeSpan -Minutes 15)
$healthSettings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $healthName -Action $healthAction -Trigger $healthTrigger `
    -Settings $healthSettings -Principal $principal `
    -Description "Weather HQ collector health check: alerts when data goes stale or collectors duplicate" `
    -Force | Out-Null
Write-Host "Registered '$healthName' (every 15 min, S4U as $User)."

if ($HealthOnly) {
    Write-Host "-HealthOnly: collector task left untouched."
    exit 0
}

# -- Task 1: the collector ----------------------------------------------------

# Launch via the .cmd wrapper: pins the working directory, finds Python, and
# captures pre-logging crashes in collector.out.log.
$action = New-ScheduledTaskAction -Execute (Join-Path $workDir "run_collector.cmd") `
    -WorkingDirectory $workDir

# Omitting -RepetitionDuration means "repeat indefinitely".
$triggers = @(
    (New-ScheduledTaskTrigger -AtStartup),
    (New-ScheduledTaskTrigger -AtLogOn -User $User),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
        -RepetitionInterval (New-TimeSpan -Minutes 5))
)

$settings = New-ScheduledTaskSettingsSet `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 5) `
    -ExecutionTimeLimit (New-TimeSpan -Days 3650) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable -DontStopOnIdleEnd `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $name -Action $action -Trigger $triggers `
    -Settings $settings -Principal $principal `
    -Description "Weather HQ benchmark collector (auto-restart, runs without logon)" -Force | Out-Null

# The instance started under the old definition (Interactive) keeps running
# after re-registration; stop it so the S4U definition takes over.
Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue

# Hand-started collectors are invisible to the task (IgnoreNew only guards the
# task's own instances), so two would write the same JSONL files. Clear them
# (and the python left behind by the stopped task) before the task takes over.
$stray = Get-CimInstance Win32_Process -Filter "Name like '%python%'" |
    Where-Object { $_.CommandLine -like "*collector.py*" }
foreach ($p in $stray) {
    Write-Host "Stopping running collector (PID $($p.ProcessId))..."
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2

Write-Host "Registered '$name' (startup + logon + every 5 min, S4U as $User). Starting it now..."
Start-ScheduledTask -TaskName $name
Start-Sleep -Seconds 10
$running = Get-CimInstance Win32_Process -Filter "Name like '%python%'" |
    Where-Object { $_.CommandLine -like "*collector.py*" }
if ($running) {
    Write-Host "Collector running: PID $(($running | ForEach-Object ProcessId) -join ', ')" -ForegroundColor Green
} else {
    Write-Host "WARNING: no collector.py process after 10 s. See collector.out.log / collector.log." -ForegroundColor Yellow
}
Get-ScheduledTask -TaskName $name, $healthName |
    Select-Object TaskName, State, @{n='LogonType'; e={$_.Principal.LogonType}} | Format-Table -AutoSize
Write-Host "Check: python health_check.py   (newest record per city should be < 4 min old)"
