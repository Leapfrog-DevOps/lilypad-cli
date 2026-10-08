#!/usr/bin/env bash
# Fail if anything that must not be public is in the tracked files or the git history.
# Patterns are deliberately generic; extend .leak-patterns.local (git-ignored) with real values
# (account IDs, the platform URL, internal hostnames) on your machine.
set -euo pipefail
cd "$(dirname "$0")/.."
patterns=(
  'lambda-url' 'amazonaws\.com' 'arn:aws' 'execute-api' 'lilypad-ingress' 'lilypad-orchestrator'
  'aws lambda' 'AWS_PROFILE' 'AWS_ACCESS_KEY' 'AKIA[0-9A-Z]{16}' '[^0-9][0-9]{12}[^0-9]'
  'sandbox@' 'demo\.lftechnology\.com' 'lpk_[A-Za-z0-9]{16,}' 'github_pat_[A-Za-z0-9_]{20,}' 'ghp_[A-Za-z0-9]{20,}'
  'BEGIN [A-Z ]*PRIVATE KEY'
)
[ -f .leak-patterns.local ] && while IFS= read -r l; do [ -n "$l" ] && patterns+=("$l"); done < .leak-patterns.local
rx="$(IFS='|'; echo "${patterns[*]}")"
fail=0
# Working tree (tracked + untracked, minus ignored), excluding this script and local patterns.
while IFS= read -r f; do
  case "$f" in tools/leak-scan.sh | .leak-patterns.local) continue ;; esac
  if grep -nE "$rx" "$f" >/tmp/leak.$$ 2>/dev/null; then echo "LEAK in $f:"; cat /tmp/leak.$$; fail=1; fi
done < <(git ls-files --cached --others --exclude-standard)
rm -f /tmp/leak.$$
# History: every blob ever committed.
if git rev-parse HEAD >/dev/null 2>&1; then
  if git log -p --all -- . ':!tools/leak-scan.sh' | grep -nE "^\+.*($rx)" | head -20 | grep .; then echo "LEAK in git history"; fail=1; fi
fi
[ "$fail" = 0 ] && echo "leak scan: clean" || { echo "leak scan: FAILED"; exit 1; }
