# Installs (or refreshes) the moa skill into Claude Code's user-level skills directory.
# Usage: powershell -ExecutionPolicy Bypass -File moa/skill/install.ps1
$ErrorActionPreference = 'Stop'
$src = Join-Path $PSScriptRoot 'moa'
$dest = Join-Path $env:USERPROFILE '.claude\skills\moa'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item (Join-Path $src 'SKILL.md') $dest -Force
Copy-Item (Join-Path $src 'ledger.schema.json') $dest -Force
Copy-Item (Join-Path $src 'validate-ledger.mjs') $dest -Force
Write-Host "moa skill installed to $dest"
