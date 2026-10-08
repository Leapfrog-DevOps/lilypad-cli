# Lilypad CLI installer for Windows (PowerShell 5.1+ or 7+). No Git Bash, WSL or jq needed.
#
#   irm https://raw.githubusercontent.com/Leapfrog-DevOps/lilypad-cli/main/install.ps1 | iex
#
# Asks for the platform URL (not shipped with the CLI). Re-run any time to upgrade.
#
# Environment: LILYPAD_URL (skips the prompt), LILYPAD_VERSION (git tag, default main),
#              LILYPAD_BASE_URL (mirror/fork), LILYPAD_INSTALL_DIR, LILYPAD_SKILL=yes|no
# Parameter:   -Upgrade   keep the saved URL, never prompt
param([switch]$Upgrade)
$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { $null = $_ }

function Die([string]$m) { throw "install: $m" }

$repoRaw = 'https://raw.githubusercontent.com/Leapfrog-DevOps/lilypad-cli'
$version = if ($env:LILYPAD_VERSION) { $env:LILYPAD_VERSION } else { 'main' }
$base = if ($env:LILYPAD_BASE_URL) { $env:LILYPAD_BASE_URL.TrimEnd('/') } else { "$repoRaw/$version" }
$installDir = if ($env:LILYPAD_INSTALL_DIR) { $env:LILYPAD_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'lilypad' }
$configDir = if ($env:LILYPAD_CONFIG_DIR) { $env:LILYPAD_CONFIG_DIR } else { Join-Path $env:APPDATA 'lilypad' }

# Run from a clone (.\install.ps1)? Use local files instead of downloading.
$localDir = $null
if ($PSCommandPath -and (Test-Path (Join-Path (Split-Path $PSCommandPath) 'bin/lilypad.ps1'))) { $localDir = Split-Path $PSCommandPath }

$sums = $null
if (-not $localDir) { try { $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS").Content } catch { $null = $_ } }

function Get-Repo([string]$path, [string]$dest) {
  if ($localDir) { Copy-Item (Join-Path $localDir $path) $dest -Force; return }
  Invoke-WebRequest -UseBasicParsing -Uri "$base/$path" -OutFile $dest
  if ($sums) {
    $line = ($sums -split "`n") | Where-Object { ($_ -split '\s+')[1] -eq $path } | Select-Object -First 1
    if ($line) {
      $want = ($line -split '\s+')[0]
      $got = (Get-FileHash -Algorithm SHA256 $dest).Hash.ToLowerInvariant()
      if ($got -ne $want.ToLowerInvariant()) { Remove-Item -Force $dest; Die "checksum mismatch for $path; refusing to install" }
    }
  }
}

function Save-Private([string]$path, [string]$text) {
  New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
  Set-Content -Path $path -Value $text -Encoding ASCII
  & icacls $path /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null
}

New-Item -ItemType Directory -Force -Path $installDir, $configDir | Out-Null

$ps1 = Join-Path $installDir 'lilypad.ps1'
Get-Repo 'bin/lilypad.ps1' $ps1
if ((Get-Content $ps1 -TotalCount 1) -notmatch '^#!/usr/bin/env pwsh') { Remove-Item -Force $ps1; Die 'downloaded file is not the lilypad CLI' }

# `lilypad` command for cmd.exe and PowerShell: a shim that runs the script.
$shell = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
$cmd = "@echo off`r`n$shell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0lilypad.ps1`" %*`r`n"
Set-Content -Path (Join-Path $installDir 'lilypad.cmd') -Value $cmd -Encoding ASCII -NoNewline
Write-Output "installed $installDir\lilypad.cmd"

if (-not $localDir) { Save-Private (Join-Path $configDir 'source') $base }

# --- platform URL -----------------------------------------------------------------
$urlFile = Join-Path $configDir 'url'
function Test-Url([string]$u) { return ($u -match '^https://\S+$') -and (-not $u.Contains('"')) }
$current = if (Test-Path $urlFile) { (Get-Content $urlFile -TotalCount 1).Trim() } else { '' }

if ($env:LILYPAD_URL) {
  if (-not (Test-Url $env:LILYPAD_URL)) { Die 'LILYPAD_URL must start with https://' }
  Save-Private $urlFile $env:LILYPAD_URL; Write-Output "saved platform URL to $urlFile"
} elseif ($Upgrade -and $current) {
  Write-Output 'kept saved platform URL'
} elseif ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
  while ($true) {
    $prompt = if ($current) { "Lilypad platform URL [$current]" } else { 'Lilypad platform URL (ask your Lilypad admin; https://...)' }
    $a = Read-Host $prompt
    if (-not $a) { $a = $current }
    if (Test-Url $a) { Save-Private $urlFile $a; Write-Output "saved platform URL to $urlFile"; break }
    Write-Output 'That is not an https:// URL. Try again.'
  }
} elseif ($current) {
  Write-Output 'kept saved platform URL'
} else {
  Write-Output 'No terminal to ask for the platform URL. Set it later with: lilypad config url <URL>'
}

# --- PATH ---------------------------------------------------------------------------
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $installDir) {
  [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $installDir), 'User')
  $env:Path += ";$installDir"
  Write-Output "added $installDir to your user PATH; open a new terminal"
}

# --- optional Claude skill -------------------------------------------------------------
$wantSkill = $env:LILYPAD_SKILL
if (-not $wantSkill -and -not $Upgrade -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
  if ((Read-Host 'Install the Claude skill for lilypad? [y/N]') -match '^(y|yes)$') { $wantSkill = 'yes' }
}
if ($wantSkill -eq 'yes') {
  $skillDir = Join-Path $HOME '.claude/skills/lilypad'
  New-Item -ItemType Directory -Force -Path (Join-Path $skillDir 'references') | Out-Null
  foreach ($f in 'SKILL.md', 'references/commands.md', 'references/troubleshooting.md') {
    Get-Repo "skill/lilypad/$f" (Join-Path $skillDir $f)
  }
  Write-Output "installed Claude skill to $skillDir"
}

Write-Output ''
Write-Output 'Done. Next:'
Write-Output '  lilypad auth you@<company-domain>   # email yourself a 30-day key'
Write-Output '  lilypad login lpk_...               # save it'
Write-Output '  lilypad whoami'
