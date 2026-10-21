<#
  Registers (or replaces) the scheduled task "p2p-preview" that keeps the static server
  of the built app running on 127.0.0.1:4173. It starts at logon, has no time limit,
  restarts itself after a crash and writes its output to preview.log in the project folder.

  Needs no administrator rights and no token. Run from the project folder:
    powershell -ExecutionPolicy Bypass -File scripts\windows\register-preview-task.ps1
#>
[CmdletBinding()]
param(
    [int]$Port = 4173,
    [string]$TaskName = "p2p-preview",
    [string]$ProjectDir = (Get-Location).Path
)
$ErrorActionPreference = "Stop"

$npx = (Get-Command npx.cmd -ErrorAction SilentlyContinue).Source
if (-not $npx) { throw "npx.cmd не е в PATH. Инсталирайте Node.js LTS." }
if (-not (Test-Path (Join-Path $ProjectDir "dist\index.html"))) {
    throw "Няма dist\index.html. Първо пуснете: npm run build"
}

$log = Join-Path $ProjectDir "preview.log"
$line = "cd /d `"$ProjectDir`" && `"$npx`" vite preview --host 127.0.0.1 --port $Port --strictPort >> `"$log`" 2>&1"
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$line`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "Задачата '$TaskName' е регистрирана. Дневник на сървъра: $log"
