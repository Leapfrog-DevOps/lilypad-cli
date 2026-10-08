#!/usr/bin/env pwsh
# Lilypad CLI for Windows PowerShell 5.1 and PowerShell 7+. Same commands as the bash CLI.
#   lilypad auth <email> | login <key> | logout | whoami
#   lilypad list [--client C]
#   lilypad setup <name> --repo <url> [--client C] [--branch B] [--port N] [--health /p] [--size S] [--env-file F]
#   lilypad create|redeploy|status|extend|destroy <name> | logs <name> [lines]
#   lilypad config url <URL> | update | '<json>' | - | --how-to
# Key: $env:LILYPAD_KEY, else %APPDATA%\lilypad\key. URL: $env:LILYPAD_URL, else %APPDATA%\lilypad\url.
$ErrorActionPreference = 'Stop'
$Version = '1.0.0'

function Die([string]$msg) { [Console]::Error.WriteLine("lilypad: $msg"); exit 1 }
function Usage {
  Get-Content $PSCommandPath | Select-Object -Skip 1 -First 7 | ForEach-Object { [Console]::Error.WriteLine(($_ -replace '^# ?', '')) }
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
      lilypad whoami                       # shows your email and key expiry

3. Prepare the repo
   - Dockerfile at the repo root (the branch you deploy).
   - The app listens on one port (default 8080).
   - A health path returns 200-399 without a login (default /). If the app is behind a login,
     add an open /health route.
   - No real secrets in env vars: operators can see them. Auth is the app's own job.

4. Create a GitHub token for the repo
   Fine-grained PAT, read-only "Contents" on that one repo. Give it to the CLI via the
   environment or the hidden prompt, never as an option:
      $env:GITHUB_PAT = 'github_pat_...'

5. Save the demo's configuration (nothing is deployed yet)
      lilypad setup shop --client acme --repo https://github.com/<org>/<repo>  `
        --port 3000 --health /health --size small [--branch main] [--env-file app.env]
   Name (the project): 3-24 chars, lowercase letters, digits, hyphens, starts with a letter.
   Client (optional): 1-20 chars, lowercase letters, digits, hyphens. The address becomes
   <name>-<client> (shop-acme) and every resource is tagged Client=acme. Fixed once deployed.
   Size: tiny, small (default), medium (large is admin-only).
   Then check it: lilypad status acme-poc   # expect "Repo readable, Dockerfile found"

6. Deploy
      lilypad create acme-poc
   Takes 5-10 minutes. You get one email when it is live, or one if it fails.
   Follow along with: lilypad status acme-poc   # RUNNING + settled means ready

7. Change something
   - New code: push it, then  lilypad redeploy acme-poc
   - New settings: run setup again with EVERY option you want to keep, then redeploy.

8. When it fails or misbehaves
      lilypad status acme-poc
      lilypad logs acme-poc 200
   Check that --port matches the container and --health returns 200-399 without a login.

9. Lifecycle
      lilypad list                 # active demos
      lilypad extend acme-poc      # expiry = now + 30 days (90 days total at most)
      lilypad destroy acme-poc     # permanent; the name is free for anyone afterwards
   A warning email arrives on day 27. At most 3 active demos per person.

More: lilypad --help, lilypad <command> --help.
'@ | Write-Output
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
  '^(create|redeploy|status|extend|destroy)$' {
    if ($rest.Count -ne 1) { Usage }
    $body = ToJson @{ action = $action; name = $rest[0] }; break
  }
  '^logs$' {
    if ($rest.Count -lt 1 -or $rest.Count -gt 2) { Usage }
    $o = @{ action = 'logs'; name = $rest[0] }
    if ($rest.Count -eq 2 -and $rest[1]) { $o.args = @{ lines = $rest[1] } }
    $body = ToJson $o; break
  }
  '^setup$' {
    if ($rest.Count -lt 1) { Usage }
    $name = $rest[0]
    if ($name.StartsWith('-')) { Die 'setup needs a demo name first: lilypad setup <name> --repo <url> ...' }
    $opt = @{}
    $i = 1
    while ($i -lt $rest.Count) {
      if ($i + 1 -ge $rest.Count) { Die "$($rest[$i]) needs a value" }
      switch ($rest[$i]) {
        '--repo'     { $opt.repoUrl = $rest[$i + 1] }
        '--client'   { if ($rest[$i + 1]) { $opt.client = $rest[$i + 1] } }
        '--branch'   { $opt.branch = $rest[$i + 1] }
        '--port'     { $opt.port = $rest[$i + 1] }
        '--health'   { $opt.healthPath = $rest[$i + 1] }
        '--size'     { $opt.size = $rest[$i + 1] }
        '--env-file' {
          if (-not (Test-Path $rest[$i + 1])) { Die "cannot read $($rest[$i + 1])" }
          $opt.env = [IO.File]::ReadAllText((Resolve-Path $rest[$i + 1]))
        }
        default { Die "unknown option $($rest[$i]) (see: lilypad --help)" }
      }
      $i += 2
    }
    if (-not $opt.repoUrl) { Die 'setup needs --repo https://github.com/<org>/<repo>' }
    # The PAT never goes on the command line. Blank keeps the one already stored, except on a destroyed name.
    $pat = $env:GITHUB_PAT
    if (-not $pat -and [Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
      $sec = Read-Host -AsSecureString 'GitHub PAT (blank keeps the stored one; required for a destroyed name)'
      $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
      try { $pat = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    }
    if ($pat) { $opt.githubPat = $pat }
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
