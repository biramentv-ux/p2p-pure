# Signs one Windows file with signtool (Authenticode, SHA-256, RFC 3161 timestamp).
# Called by Tauri (bundle.windows.signCommand) for the app exe and the NSIS installer, and by
# .github/workflows/windows-desktop.yml. Only runs in CI when WINDOWS_CERT_PFX_BASE64 exists.
#
#   pwsh -File scripts/windows/sign.ps1 <file>
#
# Environment:
#   WINDOWS_CERT_PFX_PATH    the .pfx decoded from the secret (in $RUNNER_TEMP, deleted after)
#   WINDOWS_CERT_PASSWORD    its password (secret)
#   WINDOWS_TIMESTAMP_URL    optional, default http://timestamp.digicert.com
param([Parameter(Mandatory = $true)][string]$File)
$ErrorActionPreference = 'Stop'

if (-not $env:WINDOWS_CERT_PFX_PATH -or -not (Test-Path $env:WINDOWS_CERT_PFX_PATH)) { throw "WINDOWS_CERT_PFX_PATH is not set or missing" }
if (-not (Test-Path $File)) { throw "no such file: $File" }

function Find-SignTool {
  $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  $found = Get-ChildItem $kits -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\' } | Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $found) { throw "signtool.exe not found (Windows SDK)" }
  return $found.FullName
}

$signtool = Find-SignTool
$ts = if ($env:WINDOWS_TIMESTAMP_URL) { $env:WINDOWS_TIMESTAMP_URL } else { 'http://timestamp.digicert.com' }

# Timestamp servers fail now and then; retry a few times before giving up.
for ($i = 1; $i -le 4; $i++) {
  & $signtool sign /fd SHA256 /td SHA256 /tr $ts /d "P2P Messenger" /f $env:WINDOWS_CERT_PFX_PATH /p $env:WINDOWS_CERT_PASSWORD $File
  if ($LASTEXITCODE -eq 0) { break }
  if ($i -eq 4) { throw "signtool sign failed for $File" }
  Start-Sleep -Seconds (5 * $i)
}
& $signtool verify /pa /all $File
if ($LASTEXITCODE -ne 0) { throw "signtool verify failed for $File" }
Write-Output "signed: $File"
