<#
  Points dyrakarmy.online at GitHub Pages, so the site stays online without your computer
  and without the Cloudflare Tunnel:

    1. Cloudflare DNS: removes the old records of the bare domain (the tunnel) and creates
       CNAME dyrakarmy.online -> <owner>.github.io, "DNS only". tg.dyrakarmy.online (the
       signalling Worker) is not touched.
    2. GitHub: sets the custom domain of the Pages site, turns on HTTPS, sets the Actions
       variable PAGES_BASE="/" and publishes the site again.

  The Cloudflare token (permission: Zone -> DNS -> Edit, for this zone only) is typed into a
  hidden prompt and is never printed or stored. Run in PowerShell, from the project folder:
    powershell -ExecutionPolicy Bypass -File scripts\windows\point-domain-to-pages.ps1
#>
[CmdletBinding()]
param(
    [string]$Repo = "biramentv-ux/p2p-pure",
    # Private source: the PUBLIC repository whose gh-pages branch serves the site (variable PAGES_PUBLISH_REPO).
    # Empty: Pages of $Repo itself.
    [string]$PagesRepo = "",
    [string]$Domain = "dyrakarmy.online"
)
$ErrorActionPreference = "Stop"
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw "Липсва GitHub CLI (winget install GitHub.cli), после gh auth login." }
if (-not $PagesRepo) { $PagesRepo = $Repo }
$owner = $PagesRepo.Split("/")[0].ToLower()

$s = Read-Host "Cloudflare API token (Zone - DNS - Edit) (скрито)" -AsSecureString
$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
$h = @{ Authorization = "Bearer $token"; "Content-Type" = "application/json" }
$api = "https://api.cloudflare.com/client/v4"

Write-Host "`n=== 1. Cloudflare DNS ===" -ForegroundColor Cyan
$zone = (Invoke-RestMethod -Headers $h -Uri "$api/zones?name=$Domain").result | Select-Object -First 1
if (-not $zone) { throw "Не намирам зона $Domain с този токен." }
$old = (Invoke-RestMethod -Headers $h -Uri "$api/zones/$($zone.id)/dns_records?name=$Domain&per_page=100").result |
    Where-Object { $_.type -in @("A", "AAAA", "CNAME") }
foreach ($r in $old) {
    Invoke-RestMethod -Method Delete -Headers $h -Uri "$api/zones/$($zone.id)/dns_records/$($r.id)" | Out-Null
    Write-Host "    махнат: $($r.type) $($r.name) -> $($r.content)"
}
$body = @{ type = "CNAME"; name = $Domain; content = "$owner.github.io"; proxied = $false; ttl = 1 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Headers $h -Uri "$api/zones/$($zone.id)/dns_records" -Body $body | Out-Null
Write-Host "    OK: CNAME $Domain -> $owner.github.io (DNS only)" -ForegroundColor Green
$token = $null

Write-Host "`n=== 2. GitHub Pages ===" -ForegroundColor Cyan
gh variable set PAGES_BASE --repo $Repo --body "/"
if ($PagesRepo -ne $Repo) { gh variable set PAGES_DOMAIN --repo $Repo --body $Domain }
gh api -X PUT "repos/$PagesRepo/pages" -f "cname=$Domain" 2>&1 | Out-Null
Write-Host "    Домейнът е зададен. GitHub проверява DNS и издава HTTPS сертификат (до 15 минути)."
gh workflow run pages.yml --repo $Repo
Write-Host "    Публикувам сайта наново (Actions -> GitHub Pages)."

Write-Host "`nСлед няколко минути: Settings -> Pages -> Enforce HTTPS трябва да е включено." -ForegroundColor Yellow
Write-Host "Проверка: https://$Domain/" -ForegroundColor Yellow
