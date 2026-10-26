<#
  Finishes the public setup in one run, on the owner's Windows computer:

    1. Checks the tools (git, Node.js, GitHub CLI, cloudflared) and installs missing ones with winget.
    2. Publishes the latest main to dyrakarmy.online (scripts\windows\deploy.ps1).
    3. Rotates the Cloudflare Tunnel token (the old one was exposed on 20 October 2026)
       and reinstalls the tunnel service with the new token.
    4. Stores CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID as GitHub secrets and
       publishes the signalling Worker with the demo rooms (Actions -> Signalling Worker).
    5. Checks every public address.

  Every token is typed into a hidden prompt. Nothing is printed, written to a file or kept
  in the PowerShell history. Each step can be skipped, and the script can be run again.

  Run in PowerShell as administrator, from the project folder:
    powershell -ExecutionPolicy Bypass -File scripts\windows\finish-setup.ps1
#>
[CmdletBinding()]
param(
    [string]$Repo = "biramentv-ux/p2p-pure",
    [string]$Site = "https://dyrakarmy.online/",
    [string]$Worker = "https://tg.dyrakarmy.online",
    [string]$Pages = "https://biramentv-ux.github.io/p2p-pure/"
)

$ErrorActionPreference = "Stop"
$summary = New-Object System.Collections.Generic.List[string]

function Step($n, $text) { Write-Host "`n=== $n. $text ===" -ForegroundColor Cyan }
function Note($text) { Write-Host "    $text" }
function Done($text) { Write-Host "    OK: $text" -ForegroundColor Green; $summary.Add("OK      $text") }
function Skip($text) { Write-Host "    Пропуснато: $text" -ForegroundColor Yellow; $summary.Add("ПРОПУСК $text") }
function Bad($text) { Write-Host "    ГРЕШКА: $text" -ForegroundColor Red; $summary.Add("ГРЕШКА  $text") }
function Ask($text) { (Read-Host "    $text [Y/n]") -notmatch '^(n|no|н|не)$' }
function ReadSecret($prompt) {
    $s = Read-Host "    $prompt (скрито)" -AsSecureString
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
function RefreshPath {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}
function Status($url, $method = "GET") {
    try { return (Invoke-WebRequest -Uri $url -Method $method -UseBasicParsing -TimeoutSec 20).StatusCode }
    catch { if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode } return 0 }
}

# ---------------------------------------------------------------------------------------------
Step 0 "Проверки"
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Стартирайте PowerShell като администратор (десен бутон -> Run as administrator)."
}
$root = Resolve-Path "$PSScriptRoot\..\.."
Set-Location $root
if (-not (Test-Path ".git")) { throw "Не намирам папката на проекта ($root)." }
Note "Проект: $root"

$tools = @(
    @{ Cmd = "git";         Id = "Git.Git" },
    @{ Cmd = "node";        Id = "OpenJS.NodeJS.LTS" },
    @{ Cmd = "gh";          Id = "GitHub.cli" },
    @{ Cmd = "cloudflared"; Id = "Cloudflare.cloudflared" }
)
foreach ($t in $tools) {
    if (-not (Get-Command $t.Cmd -ErrorAction SilentlyContinue)) {
        Note "Липсва $($t.Cmd). Инсталирам $($t.Id) с winget…"
        winget install --id $t.Id --exact --silent --accept-package-agreements --accept-source-agreements | Out-Null
        RefreshPath
        if (-not (Get-Command $t.Cmd -ErrorAction SilentlyContinue)) { throw "$($t.Cmd) не се инсталира. Инсталирайте го ръчно и пуснете скрипта отново." }
    }
}
$cfv = (& cloudflared --version 2>&1 | Out-String)
if ($cfv -match '(\d{4})\.(\d+)\.(\d+)' -and [version]"$($Matches[1]).$($Matches[2]).$($Matches[3])" -lt [version]"2026.7.3") {
    Note "cloudflared $($Matches[0]) е стар. Обновявам (новата версия пази токена в защитен файл)…"
    winget upgrade --id Cloudflare.cloudflared --exact --silent --accept-package-agreements --accept-source-agreements | Out-Null
    RefreshPath
}
$nodeV = (& node --version).TrimStart("v")
if ([version]$nodeV -lt [version]"20.19.0") { throw "Node.js $nodeV е стар. Нужен е 22.12+ (winget upgrade OpenJS.NodeJS.LTS)." }
Done "инструменти: git, node $nodeV, gh, cloudflared"

# ---------------------------------------------------------------------------------------------
Step 1 "Публикуване на последния main на $Site"
if (Ask "Да обновя ли сайта (git pull, тестове, билд, рестарт на сървъра)?") {
    try {
        & "$PSScriptRoot\deploy.ps1" -PublicUrl $Site
        Done "сайтът е обновен до последния main"
    } catch { Bad "публикуването спря: $($_.Exception.Message)" }
} else { Skip "обновяване на сайта" }

# ---------------------------------------------------------------------------------------------
Step 2 "Нов токен за тунела (старият е изтекъл)"
Note "Вариант А: от таблото на Cloudflare (препоръчва се, не трябва API токен)."
Note "Вариант Б: автоматично през API (трябва API токен с право Cloudflare Tunnel: Edit)."
$mode = Read-Host "    Изберете A, B или S (пропусни)"
$tunnelToken = $null
if ($mode -match '^[aAаА]$') {
    Note "Отварям таблото. Там: Networks -> Tunnels -> вашия тунел -> Refresh token,"
    Note "после 'Add a replica' и копирайте САМО дългия низ, който започва с eyJ."
    Start-Process "https://one.dash.cloudflare.com/"
    $tunnelToken = ReadSecret "Поставете новия токен на тунела"
} elseif ($mode -match '^[bBбБ]$') {
    $acc = Read-Host "    Account ID (Cloudflare -> Workers & Pages -> Overview, вдясно)"
    $tid = Read-Host "    Tunnel ID (Networks -> Tunnels -> тунелът -> Overview)"
    $api = ReadSecret "Cloudflare API токен с право Cloudflare Tunnel: Edit"
    $h = @{ Authorization = "Bearer $api" }
    $base = "https://api.cloudflare.com/client/v4/accounts/$acc/cfd_tunnel/$tid"
    try {
        $bytes = New-Object byte[] 32
        [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
        $body = @{ tunnel_secret = [Convert]::ToBase64String($bytes) } | ConvertTo-Json
        Invoke-RestMethod -Method Patch -Uri $base -Headers $h -ContentType "application/json" -Body $body | Out-Null
        $tunnelToken = (Invoke-RestMethod -Uri "$base/token" -Headers $h).result
        # The token was exposed: drop every open connection, including any made with the old token.
        Invoke-RestMethod -Method Delete -Uri "$base/connections" -Headers $h | Out-Null
        Note "Тайната е сменена и всички стари връзки са прекъснати."
    } catch { Bad "API заявката не мина: $($_.Exception.Message)" }
    $api = $null; $h = $null; $bytes = $null; $body = $null
} else { Skip "ротация на токена на тунела" }

if ($tunnelToken) {
    if (-not (Test-Path "dist\index.html")) { npm ci; npm run build }
    try {
        if (Get-Service Cloudflared -ErrorAction SilentlyContinue) {
            Stop-Service Cloudflared -Force -ErrorAction SilentlyContinue
            & cloudflared service uninstall 2>&1 | Out-Null
        }
        & cloudflared service install $tunnelToken 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "cloudflared не прие токена (поставете само низа eyJ…)" }
        Start-Sleep -Seconds 8
        if ((Get-Service Cloudflared).Status -eq "Running") { Done "тунелът работи с новия токен" }
        else { Bad "услугата Cloudflared не тръгна" }
    } catch { Bad "инсталиране на тунела: $($_.Exception.Message)" }
    $tunnelToken = $null
    Set-Clipboard -Value " "
    Note "Клипбордът е изчистен. В таблото проверете: тунелът е Healthy и има само един конектор (този компютър)."
}

# ---------------------------------------------------------------------------------------------
Step 3 "Сигнален Worker с демо стаите (публикува се от GitHub)"
if (Ask "Да настроя ли секретите в GitHub и да публикувам Worker-а?") {
    & gh auth status 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Note "Влизане в GitHub (отваря браузър)…"
        & gh auth login --hostname github.com --git-protocol https --web
    }
    Note "Нужен е Cloudflare API токен по шаблона 'Edit Cloudflare Workers'."
    Note "Отварям страницата: Create Token -> Edit Cloudflare Workers -> Use template ->"
    Note "Account Resources: вашия акаунт; Zone Resources: dyrakarmy.online -> Continue -> Create Token."
    Start-Process "https://dash.cloudflare.com/profile/api-tokens"
    $accId = Read-Host "    Account ID (Cloudflare -> Workers & Pages -> Overview, вдясно)"
    $wToken = ReadSecret "Поставете API токена"
    try {
        # Passed from variables: the PowerShell history keeps only the script call, never the values.
        # (Piping through stdin could add a trailing newline to the token.)
        & gh secret set CLOUDFLARE_API_TOKEN --repo $Repo --body $wToken.Trim()
        if ($LASTEXITCODE -ne 0) { throw "gh secret set CLOUDFLARE_API_TOKEN" }
        & gh secret set CLOUDFLARE_ACCOUNT_ID --repo $Repo --body $accId.Trim()
        if ($LASTEXITCODE -ne 0) { throw "gh secret set CLOUDFLARE_ACCOUNT_ID" }
        Done "секретите са записани в GitHub"
    } catch { Bad "секретите не се записаха: $($_.Exception.Message)" }
    $wToken = $null; Set-Clipboard -Value " "

    Note "Пускам Actions -> Signalling Worker…"
    & gh workflow run worker-deploy.yml --repo $Repo --ref main
    Start-Sleep -Seconds 8
    $runId = (& gh run list --repo $Repo --workflow worker-deploy.yml --limit 1 --json databaseId --jq ".[0].databaseId")
    & gh run watch $runId --repo $Repo --exit-status --interval 10 | Out-Null
    if ($LASTEXITCODE -eq 0) { Done "Worker-ът е публикуван (run $runId)" }
    else { Bad "публикуването на Worker-а не мина. Вижте: gh run view $runId --repo $Repo --log-failed" }
} else { Skip "Worker и секрети" }

# ---------------------------------------------------------------------------------------------
Step 4 "Проверка на адресите"
$s = Status $Site;                 if ($s -eq 200) { Done "сайт $Site" } else { Bad "сайт $Site отговаря с $s" }
$s = Status $Pages;                if ($s -eq 200) { Done "онлайн версия $Pages" } else { Bad "онлайн версия $Pages отговаря с $s" }
$s = Status "$Worker/";            if ($s -eq 200) { Done "Worker $Worker" } else { Bad "Worker $Worker отговаря с $s" }
try {
    $room = Invoke-RestMethod -Method Post -Uri "$Worker/ws/rooms" -ContentType "application/json" -Body "{}" -TimeoutSec 20
    if ($room.code) { Done "демо стаите работят (тестов код $($room.code), изтича след 10 минути)" } else { Bad "демо стаите не върнаха код" }
} catch { Bad "демо стаите: $($_.Exception.Message)" }

Write-Host "`n=== Обобщение ===" -ForegroundColor Cyan
$summary | ForEach-Object { Write-Host "  $_" }
Write-Host "`nСкриптът може да се пусне отново; вече направените стъпки могат да се пропуснат." -ForegroundColor Gray
