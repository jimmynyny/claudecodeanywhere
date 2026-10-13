#!/bin/bash
# Remove the launchd job. Running Remote Control servers in tmux are left alone.
set -euo pipefail
LABEL="com.claudecodeanywhere.agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "removed $LABEL (tmux sessions named cca-* are still running; 'tmux ls' to see them)"
