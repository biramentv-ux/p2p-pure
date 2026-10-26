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

# From 2026.7.3 "service install <token>" keeps the token in %ProgramData%\cloudflared\token
# (Administrators and SYSTEM only) and starts the service with --token-file. Older versions
# put the token in the service command line, which any local user can read.
$cfVersion = (& $cf --version 2>&1 | Out-String)
if ($cfVersion -match '(\d{4})\.(\d+)\.(\d+)' -and [version]"$($Matches[1]).$($Matches[2]).$($Matches[3])" -lt [version]"2026.7.3") {
    Write-Warning "cloudflared $($Matches[0]) записва токена в командния ред на услугата. Обновете до 2026.7.3 или по-нова (winget upgrade Cloudflare.cloudflared) и пуснете скрипта отново."
}

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
if ($LASTEXITCODE -ne 0) {
    throw "cloudflared не прие токена. Копирай само токена от таблото (без команда и интервали) и пусни скрипта отново."
}
$token = $null

Start-Sleep -Seconds 6
Get-Service Cloudflared | Format-Table Name, Status -AutoSize

# The static server must also be running; it is started by the p2p-preview task.
& "$PSScriptRoot\register-preview-task.ps1"
Start-ScheduledTask -TaskName "p2p-preview"
Start-Sleep -Seconds 8

$localOk = $false
for ($i = 0; $i -lt 30 -and -not $localOk; $i++) {
    Start-Sleep -Seconds 1
    try {
        "Локално:  " + (Invoke-WebRequest "http://127.0.0.1:4173" -UseBasicParsing -TimeoutSec 5).StatusCode
        $localOk = $true
    } catch { }
}
if (-not $localOk) {
    "Локално: сървърът не отговаря на 127.0.0.1:4173. Пусни scripts\windows\deploy.ps1 или виж задачата p2p-preview."
}
try {
    "Публично: " + (Invoke-WebRequest "https://dyrakarmy.online" -UseBasicParsing -TimeoutSec 15).StatusCode
} catch {
    "Публично: още не отговаря. Провери услугата Cloudflared и обновете след минута."
}
