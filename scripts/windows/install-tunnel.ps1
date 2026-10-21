<#
  Installs the Cloudflare Tunnel as a Windows service that serves the built app
  on 127.0.0.1:4173. The token is requested with a hidden prompt, so it never
  appears in the console, the command history or the repository.

  Run from an elevated PowerShell (Run as administrator) in the project folder:
    powershell -ExecutionPolicy Bypass -File scripts\windows\install-tunnel.ps1
#>
$ErrorActionPreference = "Stop"

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Стартирайте PowerShell като администратор."
}

$cf = (Get-Command cloudflared.exe -ErrorAction SilentlyContinue).Source
if (-not $cf) { throw "cloudflared.exe не е в PATH. Инсталирайте го от Cloudflare." }

if (-not (Test-Path "dist\index.html")) {
    throw "Няма dist\index.html. Първо пуснете: npm ci; npm run build"
}

$secure = Read-Host "Tunnel token (въведете скрито)" -AsSecureString
$token = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
if ([string]::IsNullOrWhiteSpace($token)) { throw "Празен токен." }

# Replace an existing service so a rotated token takes effect.
if (Get-Service Cloudflared -ErrorAction SilentlyContinue) {
    Stop-Service Cloudflared -Force -ErrorAction SilentlyContinue
    & $cf service uninstall | Out-Null
}
& $cf service install $token | Out-Null
$token = $null

Start-Sleep -Seconds 6
Get-Service Cloudflared | Format-Table Name, Status -AutoSize

# The static server must also be running; it is started by the p2p-preview task.
$serve = "npx.cmd"
$task = Get-ScheduledTask -TaskName "p2p-preview" -ErrorAction SilentlyContinue
if (-not $task) {
    $action = New-ScheduledTaskAction -Execute $serve -Argument "vite preview --host 127.0.0.1 --port 4173 --strictPort" -WorkingDirectory (Get-Location).Path
    Register-ScheduledTask -TaskName "p2p-preview" -Action $action -Trigger (New-ScheduledTaskTrigger -AtLogOn) -RunLevel Highest -Force | Out-Null
}
Start-ScheduledTask -TaskName "p2p-preview"
Start-Sleep -Seconds 8

"Локално:  " + (Invoke-WebRequest "http://127.0.0.1:4173" -UseBasicParsing).StatusCode
try {
    "Публично: " + (Invoke-WebRequest "https://dyrakarmy.online" -UseBasicParsing -TimeoutSec 15).StatusCode
} catch {
    "Публично: още не отговаря. Провери услугата Cloudflared и обновете след минута."
}
