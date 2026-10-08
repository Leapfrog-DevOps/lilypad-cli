#!/usr/bin/env bash
# Tests the bash CLI and installer against a local mock server. No network, no AWS.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'kill "$srv" 2>/dev/null || true; rm -rf "$work"' EXIT
export HOME="$work/home" XDG_CONFIG_HOME="$work/home/.config"
mkdir -p "$HOME"
python3 "$here/tests/mock_server.py" "$work/port" "$work/log" &
srv=$!
for _ in $(seq 50); do [ -s "$work/port" ] && break; sleep 0.1; done
url="http://127.0.0.1:$(cat "$work/port")/"   # http only for the mock; installer enforces https separately

pass=0
ok() { pass=$((pass + 1)); echo "ok - $*"; }
bad() { echo "FAIL - $*"; exit 1; }
cli="$here/bin/lilypad"
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
ok "simple commands"
[ "$("$cli" --version)" = "lilypad 1.0.0" ] || bad version
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
echo "all $pass passed"
