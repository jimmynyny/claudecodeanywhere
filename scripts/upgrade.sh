#!/bin/bash
# Upgrade this Mac's CCA from GitHub and restart the agent. Same as asking the Orchestrator
# to "upgrade CCA". Running servers and sessions are not touched.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain)" ]; then echo "local changes present; commit or stash them first" >&2; exit 1; fi
before=$(git rev-parse --short=10 HEAD)
git pull --ff-only -q
after=$(git rev-parse --short=10 HEAD)
npm install --omit=dev --no-fund --no-audit >/dev/null
launchctl kickstart -k "gui/$(id -u)/com.claudecodeanywhere.agent"
echo "CCA $before -> $after; agent restarted. The Orchestrator reloads itself if needed."
