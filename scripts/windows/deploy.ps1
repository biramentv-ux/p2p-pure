<#
  Publishes the latest validated version of the app to the public address.

  The site is served by "vite preview" on 127.0.0.1:4173 (scheduled task "p2p-preview")
  and reached through the Cloudflare Tunnel. This script brings that server up to date:
    1. checks that the working tree is clean (no local edits would be overwritten)
    2. fast-forwards main from origin
    3. installs dependencies, runs the unit tests and builds dist\
    4. restarts the preview server so it serves the new build
    5. checks the local address and reports the public one

  Run from the project folder in PowerShell:
    powershell -ExecutionPolicy Bypass -File scripts\windows\deploy.ps1

  It never reads, prints or stores the tunnel token. The tunnel itself is not restarted.
#>
[CmdletBinding()]
param(
    [string]$Branch = "main",
    [string]$PublicUrl = "https://dyrakarmy.online/",
    [int]$Port = 4173,
    [string]$TaskName = "p2p-preview"
)

$ErrorActionPreference = "Stop"

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Fail($text) { throw "Deploy stopped: $text" }

if (-not (Test-Path ".git")) { Fail "run this script from the project folder (no .git here)." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "git is not installed." }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail "npm is not installed." }

Step "Checking the working tree"
$dirty = git status --porcelain
if ($dirty) {
    Write-Host $dirty
    Fail "local changes exist. Commit or stash them first, so nothing is lost."
}

Step "Updating $Branch from origin"
git fetch origin
if ($LASTEXITCODE -ne 0) { Fail "git fetch failed." }
git checkout $Branch
if ($LASTEXITCODE -ne 0) { Fail "could not switch to $Branch." }
git pull --ff-only origin $Branch
if ($LASTEXITCODE -ne 0) { Fail "could not fast-forward $Branch. Resolve the history by hand." }
$commit = git rev-parse --short HEAD
Write-Host "Now at $commit"

Step "Installing dependencies"
npm ci
if ($LASTEXITCODE -ne 0) { Fail "npm ci failed." }

Step "Running unit tests"
npm test
if ($LASTEXITCODE -ne 0) { Fail "unit tests failed. The public site was not changed." }

Step "Building the app"
npm run build
if ($LASTEXITCODE -ne 0) { Fail "build failed. The public site was not changed." }
if (-not (Test-Path "dist\index.html")) { Fail "dist\index.html is missing after the build." }

Step "Restarting the preview server on 127.0.0.1:$Port"
& "$PSScriptRoot\register-preview-task.ps1" -Port $Port -TaskName $TaskName -ProjectDir (Get-Location).Path
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}
# Stop whatever still listens on the port, so the new build is served.
$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($owner in ($listeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
    Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2
if ($task) {
    Start-ScheduledTask -TaskName $TaskName
} else {
    Write-Host "Scheduled task '$TaskName' not found. Starting the preview server in this window instead."
    Start-Process -FilePath "npx.cmd" -ArgumentList "vite", "preview", "--host", "127.0.0.1", "--port", "$Port", "--strictPort" -WindowStyle Minimized
}

Step "Checking the local server"
$local = "http://127.0.0.1:$Port/"
$ok = $false
for ($i = 0; $i -lt 20 -and -not $ok; $i++) {
    Start-Sleep -Seconds 1
    try {
        $response = Invoke-WebRequest -Uri $local -UseBasicParsing -TimeoutSec 5
        $ok = ($response.StatusCode -eq 200) -and ($response.Content -match "P2P")
    } catch {
        $ok = $false
    }
}
if (-not $ok) { Fail "the local server does not answer on $local with the app. Look at preview.log in the project folder." }
Write-Host "Local server OK: $local"

Step "Public address"
try {
    $public = Invoke-WebRequest -Uri $PublicUrl -UseBasicParsing -TimeoutSec 15
    Write-Host "Public $PublicUrl answered with HTTP $($public.StatusCode)."
} catch {
    Write-Host "Public $PublicUrl did not answer yet. The tunnel may be down or still starting. Local build is live."
}

Write-Host "`nDeployed commit $commit to the local server." -ForegroundColor Green
