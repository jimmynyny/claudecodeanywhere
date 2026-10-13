#!/bin/bash
# Claude Code Anywhere (CCA) installer for macOS.
#
#   git clone git@github.com:jimmynyny/claudecodeanywhere.git
#   cd claudecodeanywhere
#   ./install.sh
#
# Installs every prerequisite (Homebrew, Node, tmux, gh, Claude Code), walks through the
# logins that need a browser, accepts Remote Control once, writes the config, installs the
# launchd agent, and prints the Orchestrator link. Safe to rerun; every step is skipped when
# already done.
#
# Options:
#   --check            Report what is installed and configured; change nothing.
#   --root <folder>    Folder that holds your project folders (asked interactively otherwise).
#   --name <name>      Machine name shown in the Orchestrator's title (default: hostname).
#   --no-github        Skip gh login (GitHub repo creation will be unavailable).
#   --yes              Non-interactive: take defaults, skip anything that needs a person.
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$HOME/Library/Application Support/ClaudeCodeAnywhere"
CONFIG="$APP_DIR/config.json"
PORT="${CCA_PORT:-7777}"
CHECK=0; YES=0; GITHUB=1; ROOT=""; NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --yes|-y) YES=1 ;;
    --no-github) GITHUB=0 ;;
    --root) ROOT="$2"; shift ;;
    --name) NAME="$2"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

bold=$(tput bold 2>/dev/null || true); dim=$(tput dim 2>/dev/null || true); reset=$(tput sgr0 2>/dev/null || true)
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✘\033[0m %s\n' "$*"; }
step() { printf '\n%s%s%s\n' "$bold" "$*" "$reset"; }
ask()  { # ask "question" "default" -> echoes answer
  local q="$1" d="${2:-}" a
  if [ $YES -eq 1 ]; then echo "$d"; return; fi
  read -r -p "  $q${d:+ [$d]}: " a </dev/tty || true
  echo "${a:-$d}"
}
confirm() { # confirm "question" (default yes) -> exit status
  if [ $YES -eq 1 ]; then return 0; fi
  local a; read -r -p "  $1 [Y/n]: " a </dev/tty || true
  [[ -z "$a" || "$a" =~ ^[Yy] ]]
}
PROBLEMS=0

[ "$(uname -s)" = "Darwin" ] || { fail "CCA runs on macOS only."; exit 1; }
if [ $CHECK -eq 1 ]; then step "Claude Code Anywhere: checking this Mac (nothing will be changed)"; else step "Claude Code Anywhere: installing on $(hostname -s)"; fi

# ---------------------------------------------------------------- Homebrew
step "1. Homebrew"
BREW_BIN=""
for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && BREW_BIN="$b" && break; done
if [ -n "$BREW_BIN" ]; then
  eval "$("$BREW_BIN" shellenv)"
  ok "Homebrew at $BREW_BIN"
elif [ $CHECK -eq 1 ]; then
  fail "Homebrew is not installed"; PROBLEMS=$((PROBLEMS+1))
else
  echo "  Homebrew is not installed. Its installer will ask for your password (it needs sudo once)."
  confirm "Install Homebrew now?" || { fail "Homebrew is required."; exit 1; }
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/tty
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && BREW_BIN="$b" && break; done
  [ -n "$BREW_BIN" ] || { fail "Homebrew did not install."; exit 1; }
  eval "$("$BREW_BIN" shellenv)"
  ok "Homebrew installed"
fi

# ---------------------------------------------------------------- packages
step "2. Node, tmux, gh, Claude Code"
need_formula() { # name command
  if command -v "$2" >/dev/null 2>&1; then ok "$1 ($(command -v "$2"))"; return; fi
  if [ $CHECK -eq 1 ]; then fail "$1 is not installed"; PROBLEMS=$((PROBLEMS+1)); return; fi
  echo "  installing $1…"; brew install "$1" >/dev/null; ok "$1 installed"
}
need_formula node node
need_formula tmux tmux
if [ $GITHUB -eq 1 ]; then need_formula gh gh; fi
if command -v claude >/dev/null 2>&1; then
  ok "Claude Code $(claude --version 2>/dev/null | head -1)"
elif [ $CHECK -eq 1 ]; then
  fail "Claude Code is not installed"; PROBLEMS=$((PROBLEMS+1))
else
  echo "  installing Claude Code…"; brew install --cask claude-code@latest >/dev/null; ok "Claude Code installed ($(claude --version | head -1))"
fi
if command -v node >/dev/null 2>&1; then
  NODE_V=$(node -p 'process.versions.node')
  if node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)'; then ok "Node $NODE_V runs TypeScript natively (22.18+ needed)"
  else fail "Node $NODE_V is too old; CCA needs 22.18 or newer (brew upgrade node)"; PROBLEMS=$((PROBLEMS+1)); fi
fi

# ---------------------------------------------------------------- repo deps
step "3. Agent dependencies"
if [ -d "$REPO/node_modules/@modelcontextprotocol/sdk" ]; then ok "node_modules present"
elif [ $CHECK -eq 1 ]; then fail "run npm install in $REPO"; PROBLEMS=$((PROBLEMS+1))
else (cd "$REPO" && npm install --omit=dev --no-fund --no-audit >/dev/null) && ok "npm install done"; fi

# ---------------------------------------------------------------- Claude login
step "4. Claude Code login (claude.ai Pro or Max; Remote Control does not work with API keys)"
claude_logged_in() { claude auth status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.loggedIn?("yes "+(j.email||"")+" "+(j.subscriptionType||"")):"no")}catch{process.stdout.write("no")}})'; }
LOGIN=$(claude_logged_in 2>/dev/null || echo no)
if [[ "$LOGIN" == yes* ]]; then ok "logged in as ${LOGIN#yes }"
elif [ $CHECK -eq 1 ] || [ $YES -eq 1 ]; then fail "Claude Code is not logged in; run: claude auth login"; PROBLEMS=$((PROBLEMS+1))
else
  echo "  A browser will open to sign in to claude.ai."
  claude auth login </dev/tty || true
  LOGIN=$(claude_logged_in 2>/dev/null || echo no)
  if [[ "$LOGIN" == yes* ]]; then ok "logged in as ${LOGIN#yes }"; else fail "still not logged in"; PROBLEMS=$((PROBLEMS+1)); fi
fi

# ---------------------------------------------------------------- GitHub login
if [ $GITHUB -eq 1 ]; then
  step "5. GitHub CLI login (for creating repos)"
  if gh auth status >/dev/null 2>&1; then ok "gh is logged in as $(gh api user --jq .login 2>/dev/null || echo '?')"
  elif [ $CHECK -eq 1 ] || [ $YES -eq 1 ]; then warn "gh is not logged in; run: gh auth login -h github.com -p ssh -w  (or pass --no-github)"
  else
    echo "  A browser will open to authorize gh. Choosing SSH lets gh set up a key for pushes."
    gh auth login -h github.com -p ssh -w </dev/tty || true
    if gh auth status >/dev/null 2>&1; then ok "gh logged in"; else warn "gh still not logged in; GitHub repo creation will fail until it is"; fi
  fi
else
  step "5. GitHub CLI login: skipped (--no-github)"
fi

# ---------------------------------------------------------------- Remote Control consent
step "6. Remote Control one-time acceptance"
rc_seen() { node -e 'const fs=require("fs");try{const j=JSON.parse(fs.readFileSync(process.env.HOME+"/.claude.json","utf8"));process.exit(j.remoteDialogSeen===true?0:1)}catch{process.exit(1)}'; }
if rc_seen; then ok "Remote Control has been accepted on this Mac"
elif [ $CHECK -eq 1 ] || [ $YES -eq 1 ]; then fail "Remote Control not yet accepted: run 'claude remote-control' once in a terminal, answer y, then Ctrl-C"; PROBLEMS=$((PROBLEMS+1))
else
  echo "  Claude Code asks once per Mac before it will serve sessions remotely."
  echo "  A server will start now: answer ${bold}y${reset} if asked 'Enable Remote Control?', wait for 'Connected',"
  echo "  then press ${bold}Ctrl-C${reset} to come back here."
  confirm "Ready?" || true
  TMPD=$(mktemp -d /tmp/cca-rc-check.XXXX)
  (cd "$TMPD" && claude remote-control --name "CCA setup check" --spawn=session </dev/tty) || true
  rm -rf "$TMPD"
  if rc_seen; then ok "Remote Control accepted"; else warn "could not confirm acceptance; the agent will report it if a server fails to start"; fi
fi

# ---------------------------------------------------------------- config
step "7. Configuration ($CONFIG)"
if [ -f "$CONFIG" ]; then
  ok "config exists; leaving it alone"
  echo "    $(node -e 'const c=require(process.argv[1]);console.log("root: "+c.rootDir+"   machine: "+c.machineName+"   handoff mode: "+c.handoffPermissionMode)' "$CONFIG" 2>/dev/null)"
elif [ $CHECK -eq 1 ]; then
  warn "no config yet; the installer will create one"
else
  DEFAULT_ROOT="$HOME/Dropbox/Documents/__SCRIPTS"; [ -d "$DEFAULT_ROOT" ] || DEFAULT_ROOT="$HOME/Projects"
  [ -n "$ROOT" ] || ROOT=$(ask "Folder that holds (or will hold) your project folders" "$DEFAULT_ROOT")
  ROOT="${ROOT/#\~/$HOME}"
  [ -n "$NAME" ] || NAME=$(ask "Machine name for the Orchestrator's title" "$(hostname -s)")
  USER_NAME=$(ask "Your first name (how the Orchestrator refers to you)" "$(id -F 2>/dev/null | cut -d' ' -f1)")
  mkdir -p "$ROOT" "$APP_DIR"
  node -e '
    const fs=require("fs"); const [cfg,root,name,port,user]=process.argv.slice(1);
    fs.writeFileSync(cfg, JSON.stringify({
      rootDir: root, userName: user, machineName: name, port: Number(port), githubOwner: null,
      defaultSpawn: "same-dir", defaultPermissionMode: null, handoffPermissionMode: "auto",
      pinned: [], orchestrator: { enabled: true, permissionMode: null }, preventSleep: false
    }, null, 2) + "\n");' "$CONFIG" "$ROOT" "$NAME" "$PORT" "$USER_NAME"
  ok "config written: root $ROOT, machine $NAME"
fi

# ---------------------------------------------------------------- sleep
step "8. Sleep"
AC_SLEEP=$(pmset -g custom 2>/dev/null | awk '/AC Power/{f=1} f && $1=="sleep"{print $2; exit}')
if [ "${AC_SLEEP:-0}" = "0" ]; then ok "never sleeps on AC power"
elif [ $CHECK -eq 1 ] || [ $YES -eq 1 ]; then warn "sleeps after $AC_SLEEP min on AC; sessions go offline when it does (sudo pmset -c sleep 0)"
else
  echo "  This Mac sleeps after $AC_SLEEP minutes on AC power; sessions go offline when it does."
  if confirm "Set it to never sleep on AC (needs your password)?"; then sudo pmset -c sleep 0 </dev/tty && ok "AC sleep disabled"; else warn "left as is"; fi
fi

# ---------------------------------------------------------------- agent
step "9. Agent (launchd job, starts at login)"
if [ $CHECK -eq 1 ]; then
  if launchctl print "gui/$(id -u)/com.claudecodeanywhere.agent" >/dev/null 2>&1; then ok "launchd job loaded"; else fail "launchd job not installed"; PROBLEMS=$((PROBLEMS+1)); fi
else
  CCA_PORT="$PORT" "$REPO/scripts/install-agent.sh" | sed 's/^/  /'
fi

# ---------------------------------------------------------------- result
step "Result"
STATUS=$(curl -sf --max-time 5 "http://127.0.0.1:$PORT/api/status" 2>/dev/null || true)
if [ -z "$STATUS" ]; then
  fail "the agent is not answering on port $PORT (see ~/Library/Logs/ClaudeCodeAnywhere/agent.err.log)"; PROBLEMS=$((PROBLEMS+1))
else
  node -e '
    const s=JSON.parse(process.argv[1]);
    const ok=(m)=>console.log("  \x1b[32m✔\x1b[0m "+m), warn=(m)=>console.log("  \x1b[33m!\x1b[0m "+m);
    ok("agent "+s.agentVersion+" on "+s.machine+", Claude Code "+(s.claudeVersion||"?"));
    for (const w of s.warnings) warn(w);
    if (s.orchestrator && s.orchestrator.link) { ok("Orchestrator: "+s.orchestrator.name); console.log("\n  Open it from any device:\n  "+s.orchestrator.link+"\n"); }
    else console.log("\n  The Orchestrator is starting; it appears in your claude.ai session list within a minute as \"CCA Orchestrator ("+s.machine+")\".\n");
  ' "$STATUS"
fi
if [ $PROBLEMS -gt 0 ]; then echo "  $PROBLEMS problem(s) above need attention."; exit 1; fi
exit 0
