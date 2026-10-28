<#
  Продължава преминаването към частен код оттам, докъдето си стигнал. Сам проверява в GitHub кои
  стъпки от go-private.ps1 са готови, показва ги и пуска go-private.ps1 от първата незавършена.

  Освен това оправя най-честото засядане: тагът на изданието е направен, но билдовете за него са
  паднали (например преди поправка в main). Тогава предлага да изтрие тага (само ако изданието още
  не е публикувано, т.е. нищо непроменяемо не е създадено) и да го направи наново върху новия main.

  Пускане (PowerShell, от папката на проекта, след `gh auth login`):
    git pull
    powershell -ExecutionPolicy Bypass -File scripts\windows\continue-private.ps1

  -DryRun: само показва докъде си стигнал, без да променя нищо.
#>
[CmdletBinding()]
param(
    [string]$Source = "biramentv-ux/p2p-pure",
    [string]$Releases = "biramentv-ux/p2p-pure-releases",
    [string]$Domain = "dyrakarmy.online",
    # Празно = desktop-v<версията в main>: след PR с нова версия скриптът сам минава на нея.
    [string]$Tag = "",
    [switch]$SkipDomain,
    [switch]$DryRun
)
$ErrorActionPreference = "Stop"

function GhQuiet {   # $true/$false, без шум (stderr не спира скрипта в Windows PowerShell 5.1)
    $ErrorActionPreference = "Continue"
    $null = & gh @args 2>&1
    return ($LASTEXITCODE -eq 0)
}
function GhOut {     # изходът на gh или $null при грешка
    $ErrorActionPreference = "Continue"
    $o = & gh @args 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return $o
}
function GhJson {    # JSON от gh като масив от обекти. Без --jq с кавички вътре: Windows PowerShell 5.1
                     # маха вътрешните " при подаване на аргументи на външна програма.
    $o = GhOut @args
    if (-not $o) { return @() }
    return @((($o -join "`n") | ConvertFrom-Json) | ForEach-Object { $_ })
}
function Show($n, $done, $text) {
    if ($done) { Write-Host ("  [x] {0}. {1}" -f $n, $text) -ForegroundColor Green }
    else { Write-Host ("  [ ] {0}. {1}" -f $n, $text) -ForegroundColor Yellow }
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw "Липсва GitHub CLI (winget install GitHub.cli), после gh auth login." }
if (-not (GhQuiet auth status)) { throw "gh не е влязъл: пусни gh auth login" }
$go = Join-Path $PSScriptRoot "go-private.ps1"
if (-not (Test-Path $go)) { throw "Липсва $go. Пусни git pull." }

if (-not $Tag) {
    $content = GhOut api "repos/$Source/contents/electron/package.json" --jq .content
    if (-not $content) { throw "Не мога да прочета electron/package.json от main на $Source." }
    $mainVer = ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($content -replace '\s', ''))) | ConvertFrom-Json).version
    $Tag = "desktop-v$mainVer"
}

Write-Host "`nПроверявам докъде си стигнал (издание $Tag)..." -ForegroundColor Cyan

# 1. публичното репо
$vis = GhOut repo view $Releases --json visibility --jq .visibility
$s1 = ($vis -eq "PUBLIC")

# 2. secret + променливи в изходното репо
$secrets = @(GhOut secret list --repo $Source --json name --jq ".[].name" | Where-Object { $_ })
$vars = @{}
foreach ($v in (GhJson variable list --repo $Source --json name,value)) { $vars[$v.name] = $v.value }
$s2 = ($secrets -contains "RELEASES_TOKEN") -and ($vars["RELEASES_REPO"] -eq $Releases) -and
      ($vars["SOURCE_CLOSED"] -eq "1") -and ($vars["PAGES_PUBLISH_REPO"] -eq $Releases)

# 3. сайтът в gh-pages и Pages включен
$s3 = (GhQuiet api "repos/$Releases/branches/gh-pages") -and (GhQuiet api "repos/$Releases/pages")

# 4. домейнът
$cname = GhOut api "repos/$Releases/pages" --jq ".cname // empty"
$s4 = $SkipDomain -or ($cname -eq $Domain)

# 5. изданието: публикувано, с инсталатор, Linux суми и SBOM
$assets = @(GhOut api "repos/$Releases/releases/tags/$Tag" --jq ".assets[].name" | Where-Object { $_ })
$published = $assets.Count -gt 0
$hasSbom = $assets -contains "SHA256SUMS-sbom.txt"
$hasBuilds = ($assets -contains "P2P-Messenger-Setup-x64.exe") -and ($assets -contains "SHA256SUMS-linux.txt")
$s5 = $published -and $hasBuilds -and $hasSbom

# 7. изходното репо частно
$srcVis = GhOut repo view $Source --json visibility --jq .visibility
$s7 = ($srcVis -eq "PRIVATE")

Write-Host ""
Show 1 $s1 "публично репо $Releases"
Show 2 $s2 "токен RELEASES_TOKEN и променливите"
Show 3 $s3 "сайтът в gh-pages, Pages включен"
Show 4 $s4 $(if ($SkipDomain) { "домейн (пропуснат)" } else { "домейнът $Domain сочи към $Releases" })
Show 5 $s5 "издание $Tag (инсталатор, Linux, SBOM)"
Show 7 $s7 "$Source е частно"
Write-Host ""

if ($s7) { Write-Host "Всичко е готово: кодът е частен, изданията и сайтът са в $Releases." -ForegroundColor Green; return }

$from = if (-not $s1) { 1 } elseif (-not $s2) { 2 } elseif (-not $s3) { 3 } elseif (-not $s4) { 4 } elseif (-not $s5) { 5 } else { 6 }

# ---- стъпка 5: оправя засядането с тага
# Тагът се проверява винаги, когато изданието не е готово, дори да започваме от по-ранна стъпка:
# иначе go-private.ps1 стига до стъпка 5 и чака старото, вече паднало пускане.
if (-not $s5) {
    $mainSha = GhOut api "repos/$Source/git/ref/heads/main" --jq .object.sha
    $tagSha = GhOut api "repos/$Source/git/ref/tags/$Tag" --jq .object.sha
    if ($published -and -not $hasBuilds) {
        Write-Host "Изданието $Tag е публикувано без всички файлове, а публикувано издание не може да се допълни." -ForegroundColor Yellow
        Write-Host "Вдигни версията в main (PR с новата версия), слей го и пусни този скрипт пак: той сам минава на новата версия."
        return
    }
    if ($published -and -not $hasSbom -and $from -eq 5) {
        Write-Host "Изданието е публикувано, липсва само SBOM: пускам го." -ForegroundColor Cyan
        if (-not $DryRun) {
            & gh workflow run release-sbom.yml --repo $Source -f "tag=$Tag"
            Write-Host "Пуснато. Следи го в Actions -> Release SBOM, после пусни този скрипт пак."
        }
        return
    }
    if ($tagSha -and -not $published) {
        $states = @()
        foreach ($wf in @("windows-desktop.yml", "linux-desktop.yml", "release-sbom.yml")) {
            $runs = GhJson run list --repo $Source --workflow $wf --branch $Tag --limit 1 --json status,conclusion
            $r = if ($runs.Count -gt 0) { "$($runs[0].status)/$($runs[0].conclusion)" } else { $null }
            $states += "${wf}: $(if ($r) { $r } else { 'няма пускане' })"
        }
        $failed = ($states -join " ") -match "failure|cancelled|timed_out|няма пускане"
        if (-not $mainSha) { throw "Не мога да прочета main на $Source." }
        Write-Host "Тагът $Tag сочи $($tagSha.Substring(0, 7)), main е $($mainSha.Substring(0, 7))." -ForegroundColor Cyan
        foreach ($st in $states) { Write-Host "    $st" }
        if ($failed -or $tagSha -ne $mainSha) {
            Write-Host "Изданието не е публикувано, така че тагът може да се направи наново безопасно." -ForegroundColor Yellow
            if ($DryRun) { Write-Host "(-DryRun: не трия нищо)"; return }
            $a = Read-Host "Да изтрия ли тага $Tag и да го направя наново върху main? (д/н)"
            if ($a -notmatch '^(д|y|yes|да)$') { Write-Host "Оставям тага. Нищо не е променено."; return }
            # старата чернова от предишен опит desktop-release.sh я трие сама (друг commit = стари файлове)
            & gh api -X DELETE "repos/$Source/git/refs/tags/$Tag" | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Не успях да изтрия тага $Tag." }
            $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
            & git tag -d $Tag 2>&1 | Out-Null
            $ErrorActionPreference = $prev
            Write-Host "    OK: тагът е изтрит (и локално)." -ForegroundColor Green
        } else {
            Write-Host "Билдовете за тага още вървят или са минали: продължавам да ги чакам." -ForegroundColor Cyan
        }
    }
}

if ($DryRun) { Write-Host "Следващата стъпка е $from. (-DryRun: не пускам нищо)"; return }

Write-Host "Продължавам от стъпка $from." -ForegroundColor Cyan
$params = @{ Source = $Source; Releases = $Releases; Domain = $Domain; Tag = $Tag; From = $from }
if ($SkipDomain) { $params.SkipDomain = $true }
& $go @params
