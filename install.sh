#!/usr/bin/env bash
# Lilypad CLI installer (macOS, Linux, WSL, Git Bash).
#
#   curl -fsSL https://raw.githubusercontent.com/Leapfrog-DevOps/lilypad-cli/main/install.sh | bash
#
# Asks for the platform URL (not shipped with the CLI). Re-run any time to upgrade.
#
# Environment:
#   LILYPAD_URL          platform URL; skips the prompt (use for non-interactive installs)
#   LILYPAD_VERSION      git tag to install (e.g. v1.0.0). Default: main
#   LILYPAD_BASE_URL     where to fetch files from, e.g. a fork or mirror. Default: the GitHub raw URL
#   LILYPAD_INSTALL_DIR  where the `lilypad` binary goes. Default: ~/.local/bin
#   LILYPAD_SKILL=yes|no install the Claude skill without asking. Default: ask
# Flags: --upgrade   keep the saved URL, never prompt
set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/Leapfrog-DevOps/lilypad-cli"
version="${LILYPAD_VERSION:-main}"
base="${LILYPAD_BASE_URL:-$REPO_RAW/$version}"
bin_dir="${LILYPAD_INSTALL_DIR:-$HOME/.local/bin}"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/lilypad"
upgrade=0
[ "${1:-}" = "--upgrade" ] && upgrade=1

say() { printf '%s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }

# When run from a clone (./install.sh) use the local files instead of downloading.
local_dir=""
src="${BASH_SOURCE[0]:-}"
if [ -n "$src" ] && [ -f "$src" ]; then
  d="$(cd "$(dirname "$src")" && pwd)"
  [ -f "$d/bin/lilypad" ] && local_dir="$d"
fi

fetch() { # fetch <path-in-repo> <dest>
  if [ -n "$local_dir" ]; then
    cp "$local_dir/$1" "$2"
  else
    curl -fsSL "$base/$1" -o "$2" || die "could not download $base/$1"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# Verify against SHA256SUMS from the same tag/branch when it is published. A mismatch is fatal.
verify() { # verify <path-in-repo> <downloaded-file>
  [ -z "$local_dir" ] || return 0
  [ -n "${sums:-}" ] || return 0
  want="$(awk -v f="$1" '$2 == f {print $1}' <<<"$sums")"
  [ -n "$want" ] || return 0
  [ "$(sha256 "$2")" = "$want" ] || die "checksum mismatch for $1; refusing to install"
}

case "$(uname -s)" in
  Darwin) os=mac ;;
  Linux) os=linux ;;
  MINGW* | MSYS* | CYGWIN*) os=gitbash ;;
  *) die "unsupported OS $(uname -s). On Windows use install.ps1 (PowerShell)." ;;
esac

command -v curl >/dev/null || die "curl is required"

install_jq() {
  say "jq not found; trying to install it"
  if command -v brew >/dev/null; then brew install jq
  elif command -v apt-get >/dev/null; then sudo apt-get update -qq && sudo apt-get install -y jq
  elif command -v dnf >/dev/null; then sudo dnf install -y jq
  elif command -v apk >/dev/null; then sudo apk add jq
  elif command -v pacman >/dev/null; then sudo pacman -S --noconfirm jq
  elif [ "$os" = gitbash ] && command -v winget >/dev/null; then winget install -e --id jqlang.jq
  else die "install jq (https://jqlang.org/download/) and re-run"; fi
}
command -v jq >/dev/null || install_jq
command -v jq >/dev/null || die "jq is still missing; install it and re-run"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

sums=""
if [ -z "$local_dir" ]; then sums="$(curl -fsSL "$base/SHA256SUMS" 2>/dev/null || true)"; fi

fetch bin/lilypad "$tmp/lilypad"
verify bin/lilypad "$tmp/lilypad"
head -n1 "$tmp/lilypad" | grep -q '^#!/usr/bin/env bash' || die "downloaded file is not the lilypad CLI"

mkdir -p "$bin_dir"
install -m 755 "$tmp/lilypad" "$bin_dir/lilypad"
say "installed $bin_dir/lilypad"

# Remember where updates come from (never contains a secret).
mkdir -p "$config_dir"
if [ -z "$local_dir" ]; then (umask 077 && printf '%s\n' "$base" >"$config_dir/source"); fi

# --- platform URL ---------------------------------------------------------------
url_file="$config_dir/url"
valid_url() { case "$1" in https://?*) case "$1" in *[[:space:]\"]*) return 1 ;; esac; return 0 ;; *) return 1 ;; esac; }

save_url() { (umask 077 && printf '%s\n' "$1" >"$url_file"); say "saved platform URL to $url_file"; }

have_tty() { [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; }

if [ -n "${LILYPAD_URL:-}" ]; then
  valid_url "$LILYPAD_URL" || die "LILYPAD_URL must start with https://"
  save_url "$LILYPAD_URL"
elif [ "$upgrade" = 1 ] && [ -s "$url_file" ]; then
  say "kept saved platform URL"
elif have_tty; then
  current=""; [ -s "$url_file" ] && current="$(head -n1 "$url_file")"
  while :; do
    if [ -n "$current" ]; then
      printf 'Lilypad platform URL [%s]: ' "$current" >/dev/tty
    else
      printf 'Lilypad platform URL (ask your Lilypad admin; https://...): ' >/dev/tty
    fi
    IFS= read -r answer </dev/tty || answer=""
    [ -z "$answer" ] && answer="$current"
    if valid_url "$answer"; then save_url "$answer"; break; fi
    say "That is not an https:// URL. Try again." >/dev/tty
  done
elif [ -s "$url_file" ]; then
  say "kept saved platform URL"
else
  say "No terminal to ask for the platform URL. Set it later with: lilypad config url <URL>"
fi

# --- PATH -------------------------------------------------------------------------
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *)
    line="export PATH=\"$bin_dir:\$PATH\""
    for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
      [ -f "$rc" ] || continue
      grep -Fqs "$bin_dir" "$rc" || printf '\n# lilypad\n%s\n' "$line" >>"$rc"
    done
    if [ -d "$HOME/.config/fish" ]; then
      mkdir -p "$HOME/.config/fish/conf.d"
      printf 'fish_add_path %s\n' "$bin_dir" >"$HOME/.config/fish/conf.d/lilypad.fish"
    fi
    say "added $bin_dir to PATH in your shell profile; open a new terminal (or run: $line)"
    ;;
esac

# --- optional Claude skill ----------------------------------------------------------
want_skill="${LILYPAD_SKILL:-}"
if [ -z "$want_skill" ] && [ "$upgrade" = 0 ] && have_tty; then
  printf 'Install the Claude skill for lilypad? [y/N]: ' >/dev/tty
  IFS= read -r a </dev/tty || a=""
  case "$a" in y | Y | yes) want_skill=yes ;; esac
fi
if [ "$want_skill" = yes ]; then
  skill_dir="$HOME/.claude/skills/lilypad"
  mkdir -p "$skill_dir/references"
  for f in SKILL.md references/commands.md references/troubleshooting.md; do
    fetch "skill/lilypad/$f" "$tmp/skill.part"
    verify "skill/lilypad/$f" "$tmp/skill.part"
    install -m 644 "$tmp/skill.part" "$skill_dir/$f"
  done
  say "installed Claude skill to $skill_dir"
fi

say ""
say "Done. Next:"
say "  lilypad auth you@<company-domain>   # email yourself a 30-day key"
say "  lilypad login lpk_...               # save it"
say "  lilypad whoami"
