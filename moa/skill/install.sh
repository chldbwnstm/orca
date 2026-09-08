#!/bin/sh
# Installs (or refreshes) the moa skill into Claude Code's user-level skills directory.
# Usage: sh moa/skill/install.sh
set -eu
src="$(cd "$(dirname "$0")" && pwd)/moa"
dest="${HOME}/.claude/skills/moa"
mkdir -p "$dest"
cp "$src"/SKILL.md "$src"/ledger.schema.json "$src"/validate-ledger.mjs "$dest"/
echo "moa skill installed to $dest"
