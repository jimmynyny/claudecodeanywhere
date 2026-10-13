#!/bin/bash
# Install (or reinstall) the Claude Code Anywhere agent as a per-user launchd job.
# It starts at login, restarts if it dies, and logs to ~/Library/Logs/ClaudeCodeAnywhere/.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.claudecodeanywhere.agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Logs/ClaudeCodeAnywhere"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || NODE="/opt/homebrew/bin/node"
[ -x "$NODE" ] || { echo "node not found; install Node 22.18+ (brew install node)" >&2; exit 1; }
PORT="${CCA_PORT:-7777}"

mkdir -p "$LOGDIR" "$HOME/Library/LaunchAgents"
[ -d "$REPO/node_modules" ] || (cd "$REPO" && npm install --omit=dev)

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$REPO/packages/agent/src/main.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
    <key>CCA_PORT</key><string>$PORT</string>
    <key>LANG</key><string>en_US.UTF-8</string>
    <key>LC_ALL</key><string>en_US.UTF-8</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGDIR/agent.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/agent.err.log</string>
</dict>
</plist>
EOF

UID_NUM="$(id -u)"
DOMAIN="gui/$UID_NUM"
# Migrate from per-user labels used before the public release (com.<name>.claudecodeanywhere.agent).
for old in "$HOME"/Library/LaunchAgents/com.*.claudecodeanywhere.agent.plist; do
  [ -f "$old" ] || continue
  OLD_LABEL="$(basename "$old" .plist)"
  [ "$OLD_LABEL" = "$LABEL" ] && continue
  launchctl bootout "$DOMAIN/$OLD_LABEL" 2>/dev/null || true
  rm -f "$old"
  echo "removed old job $OLD_LABEL"
done
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  # bootout is asynchronous; wait until the job is really gone before loading it again
  for i in 1 2 3 4 5 6 7 8 9 10; do
    launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
    sleep 1
  done
fi
if ! launchctl bootstrap "$DOMAIN" "$PLIST" 2>/tmp/cca-bootstrap.err; then
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl kickstart -k "$DOMAIN/$LABEL"   # already loaded; just restart it with the new plist
  else
    echo "launchctl bootstrap failed: $(cat /tmp/cca-bootstrap.err)" >&2; exit 1
  fi
fi

echo "installed $LABEL"
echo "  plist: $PLIST"
echo "  logs:  $LOGDIR/agent.log"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf "http://127.0.0.1:$PORT/api/config" >/dev/null 2>&1; then
    echo "  agent is answering on http://127.0.0.1:$PORT"
    exit 0
  fi
  sleep 1
done
echo "  agent did not answer within 10s; check $LOGDIR/agent.err.log" >&2
exit 1
