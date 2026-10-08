# Windows Task Scheduler Setup Script for Naukri Profile Refresh
# Usage:
#   .\setup-task.ps1           (Registers hourly scheduled task)
#   .\setup-task.ps1 -Remove   (Removes scheduled task)

param (
    [switch]$Remove,
    [int]$IntervalHours = 1
)

$TaskName = "NaukriProfileRefresh"
$RepoDir = $PSScriptRoot

if ($Remove) {
    Write-Host "Removing Scheduled Task: $TaskName..." -ForegroundColor Yellow
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Task successfully removed." -ForegroundColor Green
    exit 0
}

Write-Host "Registering Scheduled Task: $TaskName (Every $IntervalHours hour(s))..." -ForegroundColor Cyan

$NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $NodePath) {
    $NodePath = "node.exe"
}

$ScriptPath = Join-Path $RepoDir "naukri-profile-refresh.js"
$Action = New-ScheduledTaskAction -Execute $NodePath -Argument "`"$ScriptPath`"" -WorkingDirectory $RepoDir
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Hours $IntervalHours)
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Force | Out-Null

Write-Host "Scheduled Task '$TaskName' registered successfully!" -ForegroundColor Green
Write-Host "Working Directory: $RepoDir"
Write-Host "Execution: $NodePath `"$ScriptPath`""
