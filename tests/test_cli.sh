#!/usr/bin/env bash
# Tests the bash CLI and installer against a local mock server. No network, no AWS.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'kill "$srv" 2>/dev/null || true; rm -rf "$work"' EXIT
export HOME="$work/home" XDG_CONFIG_HOME="$work/home/.config"
unset GITHUB_AUTH GITHUB_PAT
mkdir -p "$HOME"
python3 "$here/tests/mock_server.py" "$work/port" "$work/log" &
srv=$!
for _ in $(seq 50); do [ -s "$work/port" ] && break; sleep 0.1; done
url="http://127.0.0.1:$(cat "$work/port")/"   # http only for the mock; installer enforces https separately

pass=0
ok() { pass=$((pass + 1)); echo "ok - $*"; }
bad() { echo "FAIL - $*"; exit 1; }
cli="${CLI:-$here/bin/lilypad}"   # CLI=<path> runs the same tests against another build (e.g. the internal CLI)
last() { tail -n1 "$work/log"; }

out="$(env -u LILYPAD_URL "$cli" whoami 2>&1 || true)"
grep -q "no platform URL configured" <<<"$out" || bad "missing URL message: $out"
ok "refuses without URL"

export LILYPAD_URL="$url"
out="$("$cli" auth someone@gmail.com 2>&1 || true)"; grep -q "not allowed" <<<"$out" || bad "domain check"
[ ! -s "$work/log" ] || bad "non-company address reached the server"
ok "client-side email check blocks other domains"

"$cli" auth Someone@lftechnology.com >/dev/null 2>&1
[ "$(last | jq -r .body.email)" = "someone@lftechnology.com" ] || bad "auth body"
ok "auth sends normalised email"
[ "$(last | jq -r '.body | has("new")')" = "false" ] || bad "auth sends new only when asked"
"$cli" auth --new someone@lftechnology.com >/dev/null 2>&1
[ "$(last | jq -c '.body | {email, new}')" = '{"email":"someone@lftechnology.com","new":true}' ] || bad "auth --new before email"
"$cli" auth someone@lftechnology.com --new >/dev/null 2>&1
[ "$(last | jq -r .body.new)" = "true" ] || bad "auth --new after email"
"$cli" auth --new >/dev/null 2>&1 && bad "auth --new without email"
ok "auth --new asks for a new key"

LILYPAD_EMAIL_DOMAIN=example.org "$cli" auth a@example.org >/dev/null 2>&1 || bad "domain override"
ok "LILYPAD_EMAIL_DOMAIN override"

"$cli" login lpk_abc123 >/dev/null
[ "$(stat -c %a "$XDG_CONFIG_HOME/lilypad/key" 2>/dev/null || stat -f %Lp "$XDG_CONFIG_HOME/lilypad/key")" = 600 ] || bad "key mode"
"$cli" whoami >/dev/null
[ "$(last | jq -r .key)" = lpk_abc123 ] || bad "key header"
ok "login saves key (600) and it is sent as X-Lilypad-Key"

unset LILYPAD_URL
"$cli" config url "http://insecure.example" >/dev/null 2>&1 && bad "config accepted http" || true
"$cli" config url "https://example.invalid/x" >/dev/null
[ "$(cat "$XDG_CONFIG_HOME/lilypad/url")" = "https://example.invalid/x" ] || bad "config url content"
ok "config url validates https and saves"
export LILYPAD_URL="$url"

"$cli" list >/dev/null; [ "$(last | jq -r .body.action)" = list ] || bad list
[ "$(last | jq -r '.body.args // "none"')" = none ] || bad "list sent args without --client"
"$cli" list --client acme >/dev/null; [ "$(last | jq -r .body.args.client)" = acme ] || bad list-client
"$cli" list --bogus >/dev/null 2>&1 && bad "list accepted an unknown option" || true
for c in create redeploy status extend destroy; do
  "$cli" "$c" demo1 >/dev/null
  [ "$(last | jq -r .body.action)/$(last | jq -r .body.name)" = "$c/demo1" ] || bad "$c"
done
"$cli" deploy demo1 >/dev/null; [ "$(last | jq -r .body.action)" = create ] || bad deploy-alias
"$cli" logs demo1 100 >/dev/null; [ "$(last | jq -r .body.args.lines)" = 100 ] || bad logs
"$cli" build-logs demo1 100 >/dev/null
[ "$(last | jq -r .body.action)/$(last | jq -r .body.args.lines)" = build-logs/100 ] || bad build-logs
"$cli" build-logs demo1 >/dev/null; [ "$(last | jq -r '.body.args // "none"')" = none ] || bad build-logs-default
ok "simple commands"
out="$("$cli" status faildemo)" || bad "status on a FAILED demo exited non-zero"
grep -q "Last failure: .*ELB health checks" <<<"$(jq -r .message <<<"$out")" || bad "status message lost Last failure: $out"
[ "$(jq -r .data.lastFailure <<<"$out")" != null ] || bad "status data lost lastFailure: $out"
ok "status passes Last failure through (message and data.lastFailure)"
out="$("$cli" redeploy faildemo)" || bad "redeploy on a FAILED demo exited non-zero"
[ "$(last | jq -r .body.action)" = redeploy ] && [ "$(jq -r .ok <<<"$out")" = true ] || bad "redeploy on FAILED not accepted: $out"
ok "redeploy on a FAILED demo is accepted"
[ "$("$cli" --version)" = "lilypad 1.1.1" ] || bad version
ok "--version"

printf 'FOO=bar\n' >"$work/app.env"
GITHUB_PAT=github_pat_x "$cli" setup demo1 --repo https://github.com/o/r --port 3000 --size tiny --env-file "$work/app.env" >/dev/null </dev/null
[ "$(last | jq -r .body.args.repoUrl)" = https://github.com/o/r ] || bad setup-repo
[ "$(last | jq -r .body.args.githubPat)" = github_pat_x ] || bad setup-pat
[ "$(last | jq -r .body.args.env)" = "FOO=bar" ] || bad setup-env
ok "setup builds body, PAT from env"
GITHUB_PAT=github_pat_x "$cli" setup demo1 --repo https://github.com/o/r >/dev/null </dev/null
[ "$(last | jq -r '.body.args | has("client")')" = false ] || bad "setup sent client when none given"
GITHUB_PAT=github_pat_x "$cli" setup demo1 --repo https://github.com/o/r --client acme >/dev/null </dev/null
[ "$(last | jq -r .body.args.client)" = acme ] || bad setup-client
ok "setup and list send client only when given"

GITHUB_AUTH=public "$cli" setup demo1 --repo https://github.com/o/r >/dev/null </dev/null
[ "$(last | jq -r .body.args.githubPat)" = public ] || bad "GITHUB_AUTH=public"
ok "GITHUB_AUTH=public sends public"
GITHUB_AUTH=github_pat_a GITHUB_PAT=github_pat_b "$cli" setup demo1 --repo https://github.com/o/r >/dev/null </dev/null
[ "$(last | jq -r .body.args.githubPat)" = github_pat_a ] || bad "GITHUB_AUTH must win over GITHUB_PAT"
ok "GITHUB_AUTH wins over GITHUB_PAT; GITHUB_PAT still works alone (above)"
mkdir -p "$HOME/.ssh"
ssh-keygen -q -t ed25519 -N "" -C test -f "$HOME/.ssh/lp_test" >/dev/null
GITHUB_AUTH="$HOME/.ssh/lp_test" "$cli" setup demo1 --repo https://github.com/o/r >/dev/null </dev/null
[ "$(last | jq -r .body.args.githubPat)" = "$(cat "$HOME/.ssh/lp_test")" ] || bad "deploy key file contents not sent"
# shellcheck disable=SC2088  # the literal ~/ is the point: the CLI must expand it
GITHUB_AUTH="~/.ssh/lp_test" "$cli" setup demo1 --repo https://github.com/o/r >/dev/null </dev/null
[ "$(last | jq -r .body.args.githubPat)" = "$(cat "$HOME/.ssh/lp_test")" ] || bad "leading tilde path not expanded"
ok "GITHUB_AUTH=<key file> (and ~/key file) sends the private key text"
n_before="$(wc -l <"$work/log" | tr -d ' ')"
out="$(GITHUB_AUTH="$HOME/.ssh/lp_test.pub" "$cli" setup demo1 --repo https://github.com/o/r 2>&1 </dev/null)" && bad ".pub accepted"
grep -q "is not a private key (use the deploy key file without .pub)" <<<"$out" || bad "wrong .pub message: $out"
[ "$(wc -l <"$work/log" | tr -d ' ')" = "$n_before" ] || bad ".pub sent a request"
ok "GITHUB_AUTH=<file.pub> dies before sending"

echo '{"action":"list"}' | "$cli" - >/dev/null; [ "$(last | jq -r .body.action)" = list ] || bad raw-stdin
ok "raw JSON via stdin"

LILYPAD_KEY=lpk_bad "$cli" whoami >/dev/null 2>&1 && bad "401 should fail" || true
ok "HTTP 401 exits non-zero"

mkdir -p "$work/bin"; printf '#!/bin/sh\necho AWS CALLED >&2; exit 99\n' >"$work/bin/aws"; chmod +x "$work/bin/aws"
PATH="$work/bin:$PATH" "$cli" whoami >/dev/null 2>"$work/err" || true
! grep -q "AWS CALLED" "$work/err" || bad "aws invoked"
ok "no aws call"

LILYPAD_URL="https://example.invalid/y" LILYPAD_SKILL=yes bash "$here/install.sh" >/dev/null
[ -x "$HOME/.local/bin/lilypad" ] || bad "installer binary"
[ "$(cat "$XDG_CONFIG_HOME/lilypad/url")" = "https://example.invalid/y" ] || bad "installer url"
[ -f "$HOME/.claude/skills/lilypad/SKILL.md" ] || bad "installer skill"
ok "installer (env URL, skill)"
LILYPAD_URL="http://x" bash "$here/install.sh" >/dev/null 2>&1 && bad "installer accepted http" || true
ok "installer rejects non-https URL"
out="$(env -u LILYPAD_URL HOME="$work/empty" "$cli" --how-to)"; grep -q "Lilypad: how to deploy a demo" <<<"$out" || bad "how-to"
ok "--how-to prints the guide without a URL or network"

# --- setup --conf -------------------------------------------------------------------
sent() { wc -l <"$work/log" | tr -d ' '; }
mkdir -p "$work/proj"
cat >"$work/proj/app.env" <<'EOF'
FOO=bar
EOF
printf '\xef\xbb\xbf# comment\r\nexport NAME=confdemo   # inline comment\r\nREPO="https://github.com/o/r"\r\nCLIENT=\r\nBRANCH='"'"'dev'"'"'\r\nPORT=3000\r\nHEALTH=/health # ok\r\nSIZE=tiny\r\nENV_FILE=app.env\r\n' >"$work/proj/demoproject.conf"
GITHUB_PAT=github_pat_x "$cli" setup --conf "$work/proj/demoproject.conf" >/dev/null </dev/null
a="$(last | jq -c '.body')"
[ "$(jq -r .action <<<"$a")" = setup ] && [ "$(jq -r .name <<<"$a")" = confdemo ] || bad "conf name: $a"
[ "$(jq -r .args.repoUrl <<<"$a")" = https://github.com/o/r ] && [ "$(jq -r .args.branch <<<"$a")" = dev ] || bad "conf repo/branch (quotes): $a"
[ "$(jq -r .args.port <<<"$a")" = 3000 ] && [ "$(jq -r .args.healthPath <<<"$a")" = /health ] && [ "$(jq -r .args.size <<<"$a")" = tiny ] || bad "conf port/health/size: $a"
[ "$(jq -r '.args.client // "none"' <<<"$a")" = none ] || bad "empty CLIENT must be omitted: $a"
[ "$(jq -r .args.env <<<"$a")" = "FOO=bar" ] || bad "relative ENV_FILE not resolved against the conf folder: $a"
ok "setup --conf (BOM, CRLF, export, quotes, inline comments, relative ENV_FILE)"

GITHUB_PAT=github_pat_x "$cli" setup renamed --conf "$work/proj/demoproject.conf" --size small --port 4000 >/dev/null </dev/null
a="$(last | jq -c '.body')"
[ "$(jq -r .name <<<"$a")" = renamed ] && [ "$(jq -r .args.size <<<"$a")" = small ] && [ "$(jq -r .args.port <<<"$a")" = 4000 ] && [ "$(jq -r .args.branch <<<"$a")" = dev ] || bad "precedence: $a"
ok "command-line options and <name> override the conf file"

n="$(sent)"
conf_err() { # conf_err <expected text> <conf content>
  printf '%b' "$2" >"$work/bad.conf"
  out="$(GITHUB_PAT=x "$cli" setup --conf "$work/bad.conf" 2>&1 </dev/null)" && bad "accepted: $2"
  grep -q -- "$1" <<<"$out" || bad "wanted '$1' in: $out"
  [ "$(sent)" = "$n" ] || bad "a request was sent for: $2"
}
conf_err "bad.conf:2: unknown key COLOR" 'NAME=a\nCOLOR=red\n'
conf_err "bad.conf:2: REPO is set twice" 'REPO=a\nREPO=b\n'
conf_err "GitHub access cannot be set in a conf file" 'GITHUB_PAT=github_pat_zzz\n'
conf_err "bad.conf:1: GitHub access cannot be set in a conf file" 'GITHUB_AUTH=public\n'
conf_err "GitHub access cannot be set in a conf file" 'DEPLOY_KEY=/tmp/k\n'
conf_err "bad.conf:1: expected KEY=VALUE" 'just words\n'
conf_err "missing closing quote" 'NAME="abc\n'
conf_err "setup needs --repo" 'NAME=abc\n'
conf_err "setup needs a demo name" 'REPO=https://github.com/o/r\n'
"$cli" setup --conf "$work/nope.conf" >/dev/null 2>&1 </dev/null && bad "missing conf accepted" || true
ok "conf errors name the line and send nothing"

rm -f "$work/pwned"
printf 'NAME=safe\nREPO=https://github.com/o/r\nHEALTH=$(touch %s/pwned)\nPORT=`touch %s/pwned`\n' "$work" "$work" >"$work/evil.conf"
GITHUB_PAT=x "$cli" setup --conf "$work/evil.conf" >/dev/null 2>&1 </dev/null || true
[ ! -e "$work/pwned" ] || bad "conf file content was executed"
ok "conf file is data, never executed"

"$cli" setup --sample >"$work/sample.out"
cmp -s "$work/sample.out" "$here/demoproject.sample.conf" || bad "--sample differs from demoproject.sample.conf"
GITHUB_PAT=x "$cli" setup --conf "$work/sample.out" >/dev/null 2>&1 </dev/null || bad "the sample conf is not accepted as is"
[ "$(last | jq -r .body.name)" = acme-poc ] || bad "sample name"
ok "--sample prints the sample, and the sample is a valid conf"

# --- setup notes ----------------------------------------------------------------------
GITHUB_PAT=x "$cli" setup demo1 --repo https://github.com/o/r >/dev/null </dev/null
[ "$(last | jq -r '.body.args | has("notes")')" = false ] || bad "notes sent when not given"
ok "setup without notes sends no notes key (server keeps the stored ones)"
GITHUB_PAT=x "$cli" setup demo1 --repo https://github.com/o/r --notes 'a\nb' >/dev/null </dev/null
[ "$(last | jq -r .body.args.notes)" = "$(printf 'a\nb')" ] || bad "--notes \\n not a newline: $(last)"
ok "--notes 'a\\nb' sends a real line break"
GITHUB_PAT=x "$cli" setup demo1 --repo https://github.com/o/r --notes '' >/dev/null </dev/null
[ "$(last | jq -c '.body.args.notes')" = '""' ] || bad "--notes '' must send an empty string: $(last)"
ok "--notes '' sends notes \"\" (clears)"
printf 'NAME=notedemo\nREPO=https://github.com/o/r\nNOTES="Acme pilot\\nDay 2"\n' >"$work/notes.conf"
GITHUB_PAT=x "$cli" setup --conf "$work/notes.conf" >/dev/null </dev/null
[ "$(last | jq -r .body.args.notes)" = "$(printf 'Acme pilot\nDay 2')" ] || bad "conf NOTES not sent: $(last)"
ok "conf NOTES is sent"
GITHUB_PAT=x "$cli" setup --conf "$work/notes.conf" --notes other >/dev/null </dev/null
[ "$(last | jq -r .body.args.notes)" = other ] || bad "--notes must beat NOTES: $(last)"
GITHUB_PAT=x "$cli" setup --conf "$work/notes.conf" --notes '' >/dev/null </dev/null
[ "$(last | jq -c .body.args.notes)" = '""' ] || bad "--notes '' must beat NOTES: $(last)"
printf 'NAME=notedemo\nREPO=https://github.com/o/r\nNOTES=""\n' >"$work/notes-empty.conf"
GITHUB_PAT=x "$cli" setup --conf "$work/notes-empty.conf" >/dev/null </dev/null
[ "$(last | jq -c .body.args.notes)" = '""' ] || bad "NOTES=\"\" must send an empty string: $(last)"
ok "--notes beats NOTES; NOTES=\"\" clears"
sed -n "/^function Sample/,/^'@/p" "$here/bin/lilypad.ps1" | sed '1,2d;$d' >"$work/ps-sample.out"
cmp -s "$work/ps-sample.out" "$here/demoproject.sample.conf" || bad "PowerShell sample differs from demoproject.sample.conf"
ok "PowerShell sample matches demoproject.sample.conf"

echo "all $pass passed"
