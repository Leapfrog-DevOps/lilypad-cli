#!/usr/bin/env bash
# Regenerate SHA256SUMS for the files the installers download. Run before tagging a release.
set -euo pipefail
cd "$(dirname "$0")/.."
files=(bin/lilypad bin/lilypad.ps1 skill/lilypad/SKILL.md skill/lilypad/references/commands.md skill/lilypad/references/troubleshooting.md)
if command -v sha256sum >/dev/null; then sha256sum "${files[@]}" >SHA256SUMS; else shasum -a 256 "${files[@]}" >SHA256SUMS; fi
cat SHA256SUMS
