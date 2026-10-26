#!/usr/bin/env pwsh
# Lilypad CLI for Windows PowerShell 5.1 and PowerShell 7+. Same commands as the bash CLI.
#   lilypad auth <email> | login <key> | logout | whoami
#   lilypad list [--client C]
#   lilypad setup [<name>] [--conf FILE] [--repo <url>] [--client C] [--branch B] [--port N] [--health /p] [--size S] [--env-file F] [--notes T]
#     GitHub access from $env:GITHUB_AUTH or a hidden prompt: a PAT, a deploy key file path, or "public"
#   lilypad setup --sample > demoproject.conf   (a documented sample conf file)
#   lilypad create|redeploy|status|extend|destroy|pin|unpin <name> | logs|build-logs <name> [lines]   (pin/unpin: admins; logs = app, build-logs = build)
#   lilypad config url <URL> | update | '<json>' | - | --how-to
# Key: $env:LILYPAD_KEY, else %APPDATA%\lilypad\key. URL: $env:LILYPAD_URL, else %APPDATA%\lilypad\url.
$ErrorActionPreference = 'Stop'
$Version = '1.1.1'

function Die([string]$msg) { [Console]::Error.WriteLine("lilypad: $msg"); exit 1 }
function Usage {
  Get-Content $PSCommandPath | Select-Object -Skip 1 -First 9 | ForEach-Object { [Console]::Error.WriteLine(($_ -replace '^# ?', '')) }
  exit 2
}

$appData = if ($env:LILYPAD_CONFIG_DIR) { $env:LILYPAD_CONFIG_DIR }
           elseif ($env:APPDATA) { Join-Path $env:APPDATA 'lilypad' }
           else { Join-Path $HOME '.config/lilypad' }
$keyFile = Join-Path $appData 'key'
$urlFile = Join-Path $appData 'url'
$emailDomain = if ($env:LILYPAD_EMAIL_DOMAIN) { $env:LILYPAD_EMAIL_DOMAIN } else { 'lftechnology.com' }

function HowTo {
  @'
Lilypad: how to deploy a demo

Lilypad builds a GitHub repo (it needs a Dockerfile) and serves it at https://<name>.<the platform's demo domain>,
or https://<name>-<client>.<the platform's demo domain> when you give a client.
Demos are deleted after 30 days.

1. One-time setup
  The installer saved the platform URL. Check or change it:
      lilypad config url <URL>       # https only; $env:LILYPAD_URL overrides

2. Get an access key (your company email is your identity)
      lilypad auth you@lftechnology.com    # exact address, no + aliases
      lilypad login lpk_...                # paste the key from the email (check spam/junk too)
      lilypad whoami                       # shows your email, key expiry, role

3. Prepare the repo
   - Dockerfile at the repo root (the branch you deploy).
   - The app listens on one port (default 8080).
   - A health path returns 200-399 without a login (default /). If the app is behind a login,
     add an open /health route.
   - No real secrets in env vars: operators can see them. Auth is the app's own job.

4. Give Lilypad read access to the repo (one of three)
   - Public repo: nothing to create. Use the word public.
   - Deploy key: ssh-keygen -t ed25519 -f $HOME\.ssh\lilypad_shop (press Enter twice: no passphrase),
     add lilypad_shop.pub under the repo's Settings > Deploy keys (read-only), and pass the
     private key file's path.
   - Fine-grained PAT: read-only "Contents" on that one repo.
   Give it to the CLI via the environment or the hidden prompt, never as an option:
      $env:GITHUB_AUTH = 'public'                    (or)
      $env:GITHUB_AUTH = "$HOME\.ssh\lilypad_shop"   (or)
      $env:GITHUB_AUTH = 'github_pat_...'

5. Save the demo's configuration (nothing is deployed yet)
   Easiest: keep the settings in a conf file.
      lilypad setup --sample > demoproject.conf     # a documented template
      (edit demoproject.conf: NAME, REPO, PORT, HEALTH, SIZE, ...)
      lilypad setup --conf demoproject.conf
   Or give everything as options (these override the file):
      lilypad setup shop --client acme --repo https://github.com/<org>/<repo>  `
        --port 3000 --health /health --size small [--branch main] [--env-file app.env]
   GitHub access is never read from the conf file (step 4).
   Name (the project): 3-24 chars, lowercase letters, digits, hyphens, starts with a letter.
   Client (optional): 1-20 chars, lowercase letters, digits, hyphens. The address becomes
   <name>-<client> (shop-acme) and every resource is tagged Client=acme. Fixed once deployed.
   Size: tiny (default), small, medium (large is admin-only).
   Then check it: lilypad status acme-poc   # expect "Repo readable, Dockerfile found"

6. Deploy
      lilypad create acme-poc
   Takes 5-10 minutes. You get one email when it is live, or one if it fails.
   Follow along with: lilypad status acme-poc   # RUNNING + settled means ready

7. Change something
   - New code: push it, then  lilypad redeploy acme-poc
   - New settings: edit the conf file and run setup again (or repeat EVERY option you want to keep), then redeploy.

8. When it fails or misbehaves
      lilypad status acme-poc
      lilypad build-logs acme-poc 200   # the build: clone, docker build, push
      lilypad logs acme-poc 200         # the running app
   Check that --port matches the container and --health returns 200-399 without a login.
   A failed demo's status has a `Last failure:` line with the cause. Fix it, then
   lilypad redeploy acme-poc (it also retries a FAILED demo).

9. Lifecycle
      lilypad list                 # your demos, any status but destroyed
      lilypad extend acme-poc      # expiry = now + 30 days (90 days total at most)
      lilypad destroy acme-poc     # permanent; the name is free for anyone afterwards
   A warning email arrives on day 27. At most 5 active demos per person (25 for sales, 50 for admins).

More: lilypad --help, lilypad <command> --help.
'@ | Write-Output
}

function Sample {
  @'
# Lilypad demo configuration (.env style: KEY=VALUE, one per line, # starts a comment).
# Save as demoproject.conf, edit, then run:
#
#   lilypad setup --conf demoproject.conf
#
# Command-line options override the same key here. GitHub access is NOT set in this file:
# export GITHUB_AUTH=... (a PAT, a deploy key file path, or public) or type it at the hidden prompt.

# Project name: 3-24 chars, lowercase letters, digits, hyphens; starts with a letter.
NAME=acme-poc

# Required. The repo to build (needs a Dockerfile at the root).
REPO=https://github.com/your-org/your-repo

# Optional client, 1-20 chars (lowercase letters, digits, hyphens). The address becomes
# <name>-<client> and the demo is tagged Client=<client>. Fixed after the first deploy.
# CLIENT=acme

BRANCH=main
PORT=8080

# A path that returns 200-399 without a login.
HEALTH=/

# tiny | small | medium | large (large is admin-only)
SIZE=tiny

# Optional file of KEY=VALUE environment variables for the demo itself (no real secrets).
# A relative path is relative to this file. Leave it out to clear the demo's env vars.
# ENV_FILE=app.env

# Optional notes for your own record, up to 1000 characters: who it is for, dates, demo tips.
# Shown in full by status, shortened in list. Kept when left out; NOTES="" clears them.
# Write \n for a line break. Not for passwords.
# NOTES="Acme pilot. Demo on 30 Oct\nLogin with the guest button"
'@ | Write-Output
}

# Reads a .env-style conf file for `setup`. Parsed as text, never evaluated.
function Read-Conf([string]$file) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { Die "cannot read $file" }
  $res = @{}
  $n = 0
  foreach ($raw in [IO.File]::ReadAllLines((Resolve-Path -LiteralPath $file).Path)) {
    $n++
    $line = $raw.TrimEnd("`r")
    if ($n -eq 1) { $line = $line.TrimStart([char]0xFEFF) }
    $line = $line.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { continue }
    if ($line -match '^export\s+(.*)$') { $line = $Matches[1] }
    $eq = $line.IndexOf('=')
    if ($eq -lt 1) { Die "${file}:${n}: expected KEY=VALUE" }
    $key = $line.Substring(0, $eq).Trim()
    $val = $line.Substring($eq + 1).TrimStart()
    if ($key -notmatch '^[A-Za-z0-9_]+$') { Die "${file}:${n}: '$key' is not a valid key name" }
    if ($val.Length -gt 0 -and ($val[0] -eq '"' -or $val[0] -eq "'")) {
      $q = $val[0]
      $close = $val.IndexOf($q, 1)
      if ($close -lt 0) { Die "${file}:${n}: missing closing quote for $key" }
      $after = $val.Substring($close + 1).Trim()
      if ($after -ne '' -and -not $after.StartsWith('#')) { Die "${file}:${n}: unexpected text after the closing quote for $key" }
      $val = $val.Substring(1, $close - 1)
    } elseif ($val.StartsWith('#')) {
      $val = ''
    } else {
      $val = ($val -replace '\s+#.*$', '').TrimEnd()
    }
    if ($res.ContainsKey($key)) { Die "${file}:${n}: $key is set twice" }
    switch ($key) {
      { $_ -in 'NAME', 'REPO', 'CLIENT', 'BRANCH', 'PORT', 'HEALTH', 'SIZE', 'ENV_FILE', 'NOTES' } { $res[$key] = $val }
      { $_ -in 'GITHUB_AUTH', 'GITHUB_PAT', 'PAT', 'GITHUB_TOKEN', 'DEPLOY_KEY' } { Die "${file}:${n}: GitHub access cannot be set in a conf file; use `$env:GITHUB_AUTH or the hidden prompt" }
      default { Die "${file}:${n}: unknown key $key (supported: NAME REPO CLIENT BRANCH PORT HEALTH SIZE ENV_FILE NOTES)" }
    }
  }
  return $res
}

if ($args.Count -ge 1 -and $args[0] -in '--how-to', 'how-to') { HowTo; exit 0 }
if ($args.Count -ge 1 -and $args[0] -in '--version', '-V') { Write-Output "lilypad $Version"; exit 0 }
if ($args.Count -lt 1) { Usage }
$action = [string]$args[0]
$rest = @(); if ($args.Count -gt 1) { $rest = @($args[1..($args.Count - 1)] | ForEach-Object { [string]$_ }) }
if ($action -eq 'deploy') { $action = 'create' }

function Save-Private([string]$path, [string]$text) {
  New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
  Set-Content -Path $path -Value $text -Encoding ASCII
  if ($IsLinux -or $IsMacOS) { & chmod 600 $path } else {
    # Windows: drop inherited ACLs, keep only the current user.
    & icacls $path /inheritance:r /grant:r "$($env:USERNAME):F" | Out-Null
  }
}

if ($action -in '-h', '--help', 'help' -and $rest.Count -eq 0) { Usage }
if ($rest.Count -ge 1 -and $rest[0] -in '-h', '--help') { Usage }

switch ($action) {
  'login' {
    if ($rest.Count -ne 1) { Usage }
    if (-not $rest[0].StartsWith('lpk_')) { Die 'that does not look like a demo key (lpk_...)' }
    Save-Private $keyFile $rest[0]
    Write-Output "key saved to $keyFile"; exit 0
  }
  'setup' { if ($rest.Count -ge 1 -and $rest[0] -eq '--sample') { if ($rest.Count -ne 1) { Usage }; Sample; exit 0 } }
  'logout' { Remove-Item -Force -ErrorAction SilentlyContinue $keyFile; Write-Output 'key removed'; exit 0 }
  'config' {
    if ($rest.Count -ne 2 -or $rest[0] -ne 'url') { Usage }
    if ($rest[1] -notmatch '^https://\S+$' -or $rest[1].Contains('"')) { Die 'the URL must start with https:// and contain no spaces or quotes' }
    Save-Private $urlFile $rest[1]
    Write-Output "URL saved to $urlFile"; exit 0
  }
  'update' {
    $srcFile = Join-Path $appData 'source'
    if (-not (Test-Path $srcFile)) { Die 'no install source recorded; reinstall with the installer' }
    $src = (Get-Content $srcFile -TotalCount 1).Trim()
    if ($src -notmatch '^https://\S+$') { Die "install source in $srcFile is not an https URL" }
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("lilypad-install-" + [guid]::NewGuid().ToString('N') + '.ps1')
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "$src/install.ps1" -OutFile $tmp
      $env:LILYPAD_BASE_URL = $src
      & $tmp -Upgrade
    } finally { Remove-Item -Force -ErrorAction SilentlyContinue $tmp }
    exit 0
  }
}

# --- build the JSON body ---------------------------------------------------------
function ToJson($o) { $o | ConvertTo-Json -Compress -Depth 6 }

switch -Regex ($action) {
  '^-$' { $body = [Console]::In.ReadToEnd(); break }
  '^\{' { $body = $action; break }
  '^auth$' {
    if ($rest.Count -ne 1) { Usage }
    $email = ($rest[0] -replace '\s', '').ToLowerInvariant()
    if ($email -notmatch ('^[a-z0-9][a-z0-9._-]{0,63}@' + [regex]::Escape($emailDomain) + '$')) {
      Die "'$($rest[0])' is not allowed: use your plain @$emailDomain address (no + aliases, no other domain)"
    }
    $body = ToJson @{ action = 'auth'; email = $email }; break
  }
  '^whoami$' { if ($rest.Count -ne 0) { Usage }; $body = ToJson @{ action = $action }; break }
  '^list$' {
    $o = @{ action = 'list' }
    if ($rest.Count -gt 0) {
      if ($rest.Count -ne 2 -or $rest[0] -ne '--client') { Usage }
      if ($rest[1]) { $o.args = @{ client = $rest[1] } }
    }
    $body = ToJson $o; break
  }
  '^(create|redeploy|status|extend|destroy|pin|unpin)$' {
    if ($rest.Count -ne 1) { Usage }
    $body = ToJson @{ action = $action; name = $rest[0] }; break
  }
  '^(logs|build-logs)$' {
    if ($rest.Count -lt 1 -or $rest.Count -gt 2) { Usage }
    $o = @{ action = $action; name = $rest[0] }
    if ($rest.Count -eq 2 -and $rest[1]) { $o.args = @{ lines = $rest[1] } }
    $body = ToJson $o; break
  }
  '^setup$' {
    if ($rest.Count -lt 1) { Usage }
    $name = ''
    $conf = ''
    $envPath = ''
    $notes = $null   # $null = not given, so the stored notes are kept; '' clears them
    $opt = @{}
    $flag = @{}   # which options were given on the command line; they beat the conf file
    $i = 0
    if (-not $rest[0].StartsWith('-')) { $name = $rest[0]; $flag['NAME'] = $true; $i = 1 }
    while ($i -lt $rest.Count) {
      if ($i + 1 -ge $rest.Count) { Die "$($rest[$i]) needs a value" }
      $v = $rest[$i + 1]
      switch ($rest[$i]) {
        '--conf'     { $conf = $v }
        '--repo'     { $opt.repoUrl = $v; $flag['REPO'] = $true }
        '--client'   { if ($v) { $opt.client = $v }; $flag['CLIENT'] = $true }
        '--branch'   { $opt.branch = $v; $flag['BRANCH'] = $true }
        '--port'     { $opt.port = $v; $flag['PORT'] = $true }
        '--health'   { $opt.healthPath = $v; $flag['HEALTH'] = $true }
        '--size'     { $opt.size = $v; $flag['SIZE'] = $true }
        '--env-file' { $envPath = $v; $flag['ENV_FILE'] = $true }
        '--notes'    { $notes = [string]$v; $flag['NOTES'] = $true }
        default { Die "unknown option $($rest[$i]) (see: lilypad --help)" }
      }
      $i += 2
    }
    if ($conf) {
      $c = Read-Conf $conf
      if (-not $flag['NAME'] -and $c['NAME']) { $name = $c['NAME'] }
      $map = @{ REPO = 'repoUrl'; CLIENT = 'client'; BRANCH = 'branch'; PORT = 'port'; HEALTH = 'healthPath'; SIZE = 'size' }
      foreach ($k in $map.Keys) { if ($c[$k] -and -not $flag[$k]) { $opt[$map[$k]] = $c[$k] } }
      if (-not $flag['NOTES'] -and $c.ContainsKey('NOTES')) { $notes = [string]$c['NOTES'] }
      if (-not $flag['ENV_FILE'] -and $c['ENV_FILE']) {
        $envPath = $c['ENV_FILE']
        # A relative ENV_FILE in a conf file is relative to that file.
        if (-not [IO.Path]::IsPathRooted($envPath)) { $envPath = Join-Path (Split-Path (Resolve-Path -LiteralPath $conf).Path) $envPath }
      }
    }
    if ($envPath) {
      if (-not (Test-Path -LiteralPath $envPath)) { Die "cannot read $envPath" }
      $opt.env = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $envPath).Path)
    }
    if (-not $name) { Die 'setup needs a demo name: lilypad setup <name> ... (or NAME= in the conf file)' }
    if (-not $opt.repoUrl) { Die 'setup needs --repo https://github.com/<org>/<repo> (or REPO= in the conf file)' }
    # GitHub access never goes on the command line: a PAT, a deploy key file path, or "public".
    # Blank keeps the one already stored, except on a destroyed name. The server works out which it is.
    $pat = if ($env:GITHUB_AUTH) { $env:GITHUB_AUTH } else { $env:GITHUB_PAT }
    if (-not $pat -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
      $sec = Read-Host -AsSecureString 'GitHub access: PAT, path to a deploy key file, or public (blank keeps the stored one)'
      $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
      try { $pat = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    }
    if ($pat -match '^~[\\/]') { $pat = Join-Path $HOME $pat.Substring(2) }
    if ($pat -and (Test-Path -LiteralPath $pat -PathType Leaf)) {
      try { $keyText = Get-Content -LiteralPath $pat -Raw } catch { Die "cannot read $pat" }
      if (-not $keyText -or -not $keyText.Contains('PRIVATE KEY-----')) { Die "$pat is not a private key (use the deploy key file without .pub)" }
      $pat = $keyText
    }
    if ($pat) { $opt.githubPat = $pat }
    # Notes are sent only when given (option or NOTES=), so leaving them out keeps the stored ones; "" clears.
    if ($null -ne $notes) { $opt.notes = $notes.Replace('\n', "`n") }
    $body = ToJson @{ action = 'setup'; name = $name; args = $opt }; break
  }
  default { Die "unknown command '$action' (see: lilypad --help)" }
}

# --- call -------------------------------------------------------------------------
$url = $env:LILYPAD_URL
if (-not $url -and (Test-Path $urlFile)) { $url = (Get-Content $urlFile -TotalCount 1).Trim() }
if (-not $url) { Die "no platform URL configured: run 'lilypad config url <URL>' (or re-run the installer)" }
$key = $env:LILYPAD_KEY
if (-not $key -and (Test-Path $keyFile)) { $key = (Get-Content $keyFile -TotalCount 1).Trim() }

$headers = @{ 'Content-Type' = 'application/json' }
if ($key) { $headers['X-Lilypad-Key'] = $key }
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { $null = $_ }

$code = 0; $resp = ''
try {
  $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri $url -Headers $headers -Body ([Text.Encoding]::UTF8.GetBytes($body)) -ContentType 'application/json'
  $code = [int]$r.StatusCode; $resp = $r.Content
} catch {
  $ex = $_.Exception
  if ($ex.PSObject.Properties.Name -contains 'Response' -and $ex.Response) {
    $code = [int]$ex.Response.StatusCode
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $resp = $_.ErrorDetails.Message }
    else {
      try { $sr = New-Object IO.StreamReader($ex.Response.GetResponseStream()); $resp = $sr.ReadToEnd() } catch { $null = $_ }
    }
  } else { Die $ex.Message }
}

try { Write-Output ((ConvertFrom-Json $resp) | ConvertTo-Json -Depth 10) } catch { Write-Output $resp }

if ($code -ge 200 -and $code -lt 300) {
  if ($action -eq 'auth') {
    [Console]::Error.WriteLine('lilypad: check your inbox, and your spam/junk folder, for the key (from "Lilypad"). Then run: lilypad login <key>')
  }
} elseif ($code -eq 401) { Die "HTTP 401: run 'lilypad auth you@$emailDomain', then 'lilypad login <key>'" }
else { Die "HTTP $code" }
