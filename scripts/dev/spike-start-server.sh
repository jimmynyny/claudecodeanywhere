#!/bin/bash
# M0 spike: start a Claude Code Remote Control server for a folder inside a detached
# tmux session, from a process that has no terminal of its own, and print the link.
#
# Usage: spike-start-server.sh <folder> <display-name> [same-dir|worktree|session]
# Prints one JSON line on success. Exit codes: 0 ok, 2 bad args, 3 timeout, 4 error line.
set -u
FOLDER="${1:?folder}"; NAME="${2:?display name}"; SPAWN="${3:-same-dir}"
[ -d "$FOLDER" ] || { echo "no such folder: $FOLDER" >&2; exit 2; }
SLUG=$(basename "$FOLDER" | tr -c 'A-Za-z0-9_-\n' '-')
TMUX_SESSION="cca-$SLUG"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  echo "tmux session $TMUX_SESSION already exists" >&2; exit 2
fi

tmux new-session -d -s "$TMUX_SESSION" -c "$FOLDER" -x 200 -y 50
tmux send-keys -t "$TMUX_SESSION" \
  "claude remote-control --name \"$NAME\" --spawn=$SPAWN" Enter

answered_trust=0
for i in $(seq 1 90); do
  sleep 1
  PANE=$(tmux capture-pane -p -t "$TMUX_SESSION" -J 2>/dev/null)
  # same-dir / worktree servers print a folder link (?environment=env_…);
  # --spawn=session servers print a single session link (/code/session_…).
  LINK=$(printf '%s' "$PANE" | grep -o -E 'https://claude\.ai/code(\?environment=env_[A-Za-z0-9]+|/session_[A-Za-z0-9]+)' | head -1)
  if [ -n "$LINK" ]; then
    ID=$(printf '%s' "$LINK" | grep -o -E '(env|session)_[A-Za-z0-9]+')
    printf '{"tmux":"%s","id":"%s","link":"%s","spawn":"%s","seconds":%d}\n' \
      "$TMUX_SESSION" "$ID" "$LINK" "$SPAWN" "$i"
    exit 0
  fi
  # New folders ask the owner to confirm trust once. The caller chose this folder, so answer yes.
  if [ $answered_trust -eq 0 ] && printf '%s' "$PANE" | grep -q '\[y/N\]'; then
    tmux send-keys -t "$TMUX_SESSION" y Enter; answered_trust=1
  fi
  if printf '%s' "$PANE" | grep -q -E '^Error:|must be logged in|not trusted'; then
    printf '%s\n' "$PANE" | grep -E 'Error:|must be logged in|not trusted' >&2; exit 4
  fi
done
echo "timed out; last pane output:" >&2; tmux capture-pane -p -t "$TMUX_SESSION" >&2; exit 3
