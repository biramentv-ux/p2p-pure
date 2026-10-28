<#
  Преминава всички стъпки от docs/PRIVATE-REPO.md: кодът става частен, а изданията и сайтът
  остават публични (в отделно публично репо).

    1. Създава публичното репо за изданията (ако го няма).
    2. Токен (скрито въвеждане) -> secret RELEASES_TOKEN; задава променливите на частното репо.
    3. Публикува сайта в gh-pages на публичното репо и включва Pages там.
    4. Сочи домейна към новото място (Cloudflare токен се пита от point-domain-to-pages.ps1).
    5. Прави новото издание (таг), изчаква Windows + Linux билдовете и подписания SBOM
       (тримата качват в една чернова; последният я публикува).
    6. Проверява сайта и изданията.
    7. Пита дали да направи основното репо private. Преди това НЕ го променя.

  Пускане (PowerShell, от папката на проекта, след `gh auth login`):
    powershell -ExecutionPolicy Bypass -File scripts\windows\go-private.ps1

  Може да се пуска пак: стъпките, които са готови, се прескачат. -From 5 започва от стъпка 5.
  Нито един токен не се записва във файл или в историята; токенът за публичното репо се подава на gh
  като аргумент само за момента на запис на secret-а (виден само на твоя компютър).
#>
[CmdletBinding()]
param(
    [string]$Source = "biramentv-ux/p2p-pure",
    [string]$Releases = "biramentv-ux/p2p-pure-releases",
    [string]$Domain = "dyrakarmy.online",
    # Тагът на новото издание. Празно = desktop-v<версията в main> (electron/package.json).
    [string]$Tag = "",
    [switch]$SkipDomain,
    [ValidateRange(1, 7)][int]$From = 1
)
$ErrorActionPreference = "Stop"

function Say($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Ok($t) { Write-Host "    OK: $t" -ForegroundColor Green }
function Warn($t) { Write-Host "    ! $t" -ForegroundColor Yellow }
function RunGh {   # NOT named Gh: PowerShell names are case-insensitive and would call itself forever
    & gh @args
    if ($LASTEXITCODE -ne 0) { throw "gh $($args[0..([Math]::Min(2, $args.Count - 1))] -join ' ') ... завърши с грешка ($LASTEXITCODE)" }
}
function GhQuiet {   # връща $true/$false, без да хвърля и без да печата
    # Windows PowerShell 5.1 прави от stderr на външна програма грешка, която спира скрипта при "Stop".
    $ErrorActionPreference = "Continue"
    $null = & gh @args 2>&1
    return ($LASTEXITCODE -eq 0)
}
function GhOut {     # изход на gh или $null при грешка; без шум
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
function Confirm-Step($q) {
    $a = Read-Host "$q (д/н)"
    return ($a -match '^(д|y|yes|да)$')
}
# Намира пускане на workflow за таг/клон и чака да приключи. $Since (UTC): взима само пускане, започнало
# след този момент (иначе след нов таг със старо име можем да хванем предишното, вече паднало пускане).
# При провал казва коя стъпка е паднала и дава линк.
function Wait-Run($workflow, $branch, $event, $Since = $null) {
    $id = $null
    for ($i = 0; $i -lt 30 -and -not $id; $i++) {
        Start-Sleep -Seconds 10
        $args2 = @("run", "list", "--repo", $Source, "--workflow", $workflow, "--limit", "5", "--json", "databaseId,createdAt")
        if ($branch) { $args2 += @("--branch", $branch) }
        if ($event) { $args2 += @("--event", $event) }
        $runs = GhOut @args2
        if ($runs) {
            # една JSON стойност от всички редове; ForEach-Object разгъва масива (Windows PowerShell 5.1)
            $list = @((($runs -join "`n") | ConvertFrom-Json) | ForEach-Object { $_ })
            if ($Since) { $list = @($list | Where-Object { ([datetime]$_.createdAt).ToUniversalTime() -ge $Since.AddSeconds(-30) }) }
            if ($list.Count -gt 0) { $id = $list[0].databaseId }
        }
    }
    if (-not $id) { throw "Не намирам пускане на $workflow." }
    Write-Host "    чакам $workflow (пускане $id)..."
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & gh run watch $id --repo $Source --exit-status --interval 30
    $code = $LASTEXITCODE
    $ErrorActionPreference = $prev
    if ($code -ne 0) {
        $failed = (@(GhJson run view $id --repo $Source --json jobs | ForEach-Object { $_.jobs }) |
            Where-Object { $_.conclusion -eq "failure" } |
            ForEach-Object { $_.name + " -> " + ((@($_.steps) | Where-Object { $_.conclusion -eq "failure" } | ForEach-Object { $_.name }) -join ", ") }) -join "; "
        throw "$workflow падна ($failed). Подробности: https://github.com/$Source/actions/runs/$id"
    }
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw "Липсва GitHub CLI (winget install GitHub.cli), после gh auth login." }
RunGh auth status | Out-Null
if (-not $Tag) {
    $content = GhOut api "repos/$Source/contents/electron/package.json" --jq .content
    if (-not $content) { throw "Не мога да прочета electron/package.json от main на $Source." }
    $mainVer = ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($content -replace '\s', ''))) | ConvertFrom-Json).version
    $Tag = "desktop-v$mainVer"
}
$ver = $Tag -replace '^desktop-v', ''
if ($ver -notmatch '^\d+\.\d+\.\d+$') { throw "Тагът трябва да е като desktop-v0.7.1, а е $Tag" }
$ownerRel = $Releases.Split("/")[0].ToLower()

Write-Host "Частно репо:  $Source" -ForegroundColor White
Write-Host "Публично репо: $Releases" -ForegroundColor White
Write-Host "Домейн:       $(if ($SkipDomain) { '(пропуснат)' } else { $Domain })   Издание: $Tag"

# ---------------------------------------------------------------- 1
if ($From -le 1) {
    Say "1. Публично репо за изданията"
    if (GhQuiet repo view $Releases) {
        $vis = (& gh repo view $Releases --json visibility --jq .visibility)
        if ($vis -ne "PUBLIC") { throw "$Releases съществува, но е $vis. Трябва да е публично." }
        Ok "$Releases вече съществува и е публично"
    } else {
        RunGh repo create $Releases --public --add-readme --description "Releases and website of P2P Messenger (the source code is private)"
        Ok "създадено $Releases"
    }
}

# ---------------------------------------------------------------- 2
if ($From -le 2) {
    Say "2. Токен, secret и променливи"
    Write-Host @"
    Нужен е fine-grained токен (само за $Releases):
      https://github.com/settings/personal-access-tokens/new
      Repository access: Only select repositories -> $Releases
      Permissions: Contents = Read and write, Pages = Read and write (Metadata = Read е автоматично)
      Expiration: колкото избереш; когато изтече, изданията спират (старите остават).
"@
    $s = Read-Host "Токен (скрито)" -AsSecureString
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
    if (-not $plain) { throw "Не е въведен токен." }

    # проверка: токенът може ли да пише в публичното репо
    $old = $env:GH_TOKEN
    try {
        $env:GH_TOKEN = $plain
        $push = GhOut api "repos/$Releases" --jq ".permissions.push"
    } finally { $env:GH_TOKEN = $old }
    if ($push -ne "true") { $plain = $null; throw "Токенът не може да пише в $Releases. Провери репото и правата (Contents: Read and write)." }
    Ok "токенът може да пише в $Releases"

    # GitHub понякога връща HTTP 500 при запис на secret: до 4 опита
    $saved = $false
    for ($i = 1; $i -le 4 -and -not $saved; $i++) {
        $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
        & gh secret set RELEASES_TOKEN --repo $Source --body $plain 2>&1 | Out-Null
        $saved = ($LASTEXITCODE -eq 0)
        $ErrorActionPreference = $prev
        if (-not $saved) { Warn "записът на secret не успя (опит $i от 4), опитвам пак след 10 s"; Start-Sleep -Seconds 10 }
    }
    if (-not $saved) { $plain = $null; throw "GitHub не прие secret RELEASES_TOKEN (4 опита). Опитай пак след малко: continue-private.ps1" }
    $plain = $null
    Ok "secret RELEASES_TOKEN е записан в $Source"

    RunGh variable set RELEASES_REPO --repo $Source --body $Releases
    RunGh variable set SOURCE_CLOSED --repo $Source --body "1"
    RunGh variable set PAGES_PUBLISH_REPO --repo $Source --body $Releases
    if ($SkipDomain) {
        RunGh variable set PAGES_BASE --repo $Source --body "/$($Releases.Split('/')[1])/"
    } else {
        RunGh variable set PAGES_BASE --repo $Source --body "/"
        RunGh variable set PAGES_DOMAIN --repo $Source --body $Domain
    }
    Ok "променливите са зададени"
}

# ---------------------------------------------------------------- 3
if ($From -le 3) {
    Say "3. Сайтът в gh-pages на публичното репо"
    $pagesSince = (Get-Date).ToUniversalTime()
    RunGh workflow run pages.yml --repo $Source
    Wait-Run "pages.yml" "" "workflow_dispatch" $pagesSince
    if (GhQuiet api "repos/$Releases/pages") {
        Ok "Pages в $Releases вече е включен"
    } else {
        RunGh api -X POST "repos/$Releases/pages" -f "source[branch]=gh-pages" -f "source[path]=/" | Out-Null
        Ok "Pages в ${Releases}: gh-pages / root"
    }
}

# ---------------------------------------------------------------- 4
if ($From -le 4) {
    Say "4. Домейнът"
    if ($SkipDomain) {
        Warn "пропуснат (-SkipDomain). Сайтът ще е на https://$ownerRel.github.io/$($Releases.Split('/')[1])/"
    } elseif (Confirm-Step "Соча $Domain към $Releases (ще поиска Cloudflare токен). Продължавам?") {
        & "$PSScriptRoot\point-domain-to-pages.ps1" -Repo $Source -PagesRepo $Releases -Domain $Domain
    } else { Warn "пропуснато" }
}

# ---------------------------------------------------------------- 5
if ($From -le 5) {
    Say "5. Ново издание $Tag"
    $content = & gh api "repos/$Source/contents/electron/package.json" --jq .content
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(($content -replace '\s', ''))) | ConvertFrom-Json
    if ($json.version -ne $ver) {
        throw "Версията в main е $($json.version), а тагът е $Tag. Първо слей PR-а с вдигането на версията (electron, tauri, Cargo, metainfo), после пусни със -From 5."
    }
    if (GhQuiet api "repos/$Releases/releases/tags/$Tag") {
        Ok "изданието $Tag вече съществува в $Releases"
    } else {
        $since = $null
        if (-not (GhQuiet api "repos/$Source/git/ref/tags/$Tag")) {
            $since = (Get-Date).ToUniversalTime()
            $sha = & gh api "repos/$Source/git/ref/heads/main" --jq .object.sha
            RunGh api -X POST "repos/$Source/git/refs" -f "ref=refs/tags/$Tag" -f "sha=$sha" | Out-Null
            Ok "таг $Tag върху main ($($sha.Substring(0, 7)))"
        } else { Ok "тагът $Tag вече съществува" }
        Write-Host "    Windows, Linux и SBOM тръгват от тага и траят около 20-50 минути."
        # SBOM също тръгва от тага и качва в същата чернова: изданието се публикува само с трите
        Wait-Run "release-sbom.yml" $Tag "push" $since
        Wait-Run "windows-desktop.yml" $Tag "push" $since
        Wait-Run "linux-desktop.yml" $Tag "push" $since
    }
}

# ---------------------------------------------------------------- 6
if ($From -le 6) {
    Say "6. Проверка"
    $rel = & gh release view $Tag --repo $Releases --json isDraft,assets --jq '{draft: .isDraft, files: [.assets[].name]}' | ConvertFrom-Json
    if ($rel.draft) { throw "Изданието $Tag в $Releases е още чернова." }
    foreach ($need in @("P2P-Messenger-Setup-x64.exe", "SHA256SUMS-linux.txt", "SHA256SUMS-sbom.txt")) {
        if ($rel.files -notcontains $need) {
            throw "Липсва $need в изданието. Публикуваното издание не може да се допълни: вдигни версията в main (PR), после пусни continue-private.ps1."
        }
    }
    Ok "изданието има $($rel.files.Count) файла, включително инсталатор, суми и SBOM"
    $url = if ($SkipDomain) { "https://$ownerRel.github.io/$($Releases.Split('/')[1])/" } else { "https://$Domain/" }
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 30
        if ($r.StatusCode -ne 200) { throw "код $($r.StatusCode)" }
        if ($r.Content -match 'Отворен код|Open source') { Warn "сайтът още казва „отворен код“ (Pages може да е на стара версия: изчакай пет минути)" }
        elseif ($r.Content -notmatch [regex]::Escape("github.com/$Releases/releases")) { Warn "сайтът не сочи към $Releases (изчакай и пусни със -From 6)" }
        else { Ok "$url е онлайн и сочи към $Releases" }
    } catch { throw "Сайтът $url не отговаря: $($_.Exception.Message). Домейнът/HTTPS може да още се издават (до 15 минути). Пусни пак със -From 6." }
    Write-Host @"

    Ръчна проверка преди private:
      * отвори $url и свали инсталатора от бутона;
      * отвори ${url}app/ и влез в приложението.
"@
}

# ---------------------------------------------------------------- 7
if ($From -le 7) {
    Say "7. Основното репо -> private"
    Warn "Старите линкове към изданията в $Source (напр. desktop-v0.7.0) спират да работят."
    Warn "Публичните форкове остават публични; клонинги и кешове на досегашния код не се изтриват."
    $t = Read-Host "Напиши PRIVATE, за да направя $Source частно (всичко друго = не)"
    if ($t -ceq "PRIVATE") {
        RunGh repo edit $Source --visibility private --accept-visibility-change-consequences
        Ok "$Source е частно. Изданията и сайтът остават в $Releases."
    } else {
        Write-Host "    Оставям $Source публично. Пусни със -From 7, когато си готов."
    }
}
Write-Host "`nГотово." -ForegroundColor Green
