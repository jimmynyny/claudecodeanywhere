# Claude Code Anywhere (CCA)

Turn your own Macs into your personal Claude Code cloud.

CCA keeps an always-on Claude Code Remote Control session called **CCA Orchestrator** running on
your Mac. Open it from the Claude app on your phone, or from claude.ai/code in any browser, and
talk to it:

- "what's running?"
- "list my projects"
- "start a session in tcg-scanner"
- "new private project inventory-bot and put it on GitHub"
- "new project price-watch, and have it scaffold a Python CLI that fetches a page and commit"
- "in my-app, run the test suite and fix anything that fails"
- "anything waiting on me?"

The Orchestrator uses a small set of `cca` tools backed by a local agent. The agent starts
`claude remote-control` servers and sessions inside tmux, creates folders and GitHub repos, hands
a first task to a new session so it is already working when you open it, and keeps pinned servers
alive across logins. Every session CCA starts is named `CCA … (<machine>)`, so you can see which
Mac it runs on.

No cloud service, no VPN, no web UI of its own. The Claude app and claude.ai/code are the
interface, and Anthropic's Remote Control channel is the transport: outbound-only from your Mac,
authenticated, encrypted, with push notifications.

See [PLAN.md](PLAN.md) for the design history, the verified Claude Code internals it relies on,
and milestone results.

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Install](#install)
- [Using the Orchestrator](#using-the-orchestrator)
- [Permission modes](#permission-modes)
- [Configuration](#configuration)
- [What the agent does](#what-the-agent-does)
- [The cca tools](#the-cca-tools)
- [Operations](#operations)
- [Troubleshooting](#troubleshooting)
- [Repository layout](#repository-layout)
- [Development](#development)
- [Security notes](#security-notes)

## How it works

```
you ─ Claude app / claude.ai/code ─► CCA Orchestrator session ─► cca tools ─► agent ─► tmux ─► claude
      (any device, anywhere)          (Remote Control, always on)  (MCP, stdio)  (localhost:7777)
```

Three parts run on the Mac:

1. **The agent** (`packages/agent`): a Node process installed as a per-user launchd job. It
   watches Claude Code's own session registry and process table, starts and stops `claude`
   inside tmux, runs git and `gh`, and keeps the Orchestrator and pinned servers alive. It
   listens only on `127.0.0.1:7777`.
2. **The `cca` MCP server** (`packages/cca-mcp`): a thin stdio shim that exposes the agent's
   actions as tools. It holds no logic of its own.
3. **The Orchestrator**: an ordinary Claude Code session running in
   `~/Library/Application Support/ClaudeCodeAnywhere/orchestrator/`, started by the agent as
   `claude remote-control --spawn=session`. Its `CLAUDE.md` defines its job, its `.mcp.json`
   registers the `cca` tools, and its settings pre-approve them so routine calls never prompt.

Two kinds of Claude Code processes get started on your behalf:

| Kind | Command | Link shape | When |
| - | - | - | - |
| **Server** for a project folder | `claude remote-control --name "CCA <project>" --spawn=same-dir` in tmux `cca-<project>` | `claude.ai/code?environment=env_…` | "start a session in X". Once it is up, you open the link and create or pick sessions in that folder yourself, as many as you like. |
| **Handoff session** with a first task | `claude --remote-control "CCA <project>: <task>" --permission-mode auto "<prompt>"` in tmux `cca-<project>-sN` | `claude.ai/code/session_…` | "in X, do Y" or "new project X and build Y". The session starts working immediately; open the link to watch or steer it. |

A stopped server's sessions stay resumable for about four hours; starting the server again in
the same folder brings them back. The Orchestrator itself is restarted with `--continue` so its
conversation survives restarts, and the agent restarts it automatically whenever its
instructions or tools change, so updates take effect without you doing anything.

**Servers vs sessions, as `list_sessions` reports them.** A *server* is a `claude remote-control`
process for a folder; it can host many sessions, created from the Claude app or by CCA, and each
hosted session has its own link. A *handoff session* is a single `claude` process CCA started
with a task; it is independent of the folder's server, so stopping one never affects the other.
A *standalone session* is a plain `claude` someone started in a terminal: if Remote Control was turned on inside it (`/rc`), it has a link; otherwise it is
terminal-only and shows "no link". CCA discovers all of them, whoever started them, and can stop
any of them: servers and handoff sessions get Ctrl-C in their tmux window; hosted and standalone
sessions get the same interrupt signals a person would send, so Claude Code saves the
conversation for `claude --resume`. The Orchestrator asks before stopping anything CCA did not
start.

## Requirements

A Mac. The installer puts everything else in place:

- Homebrew, Node 22.18+, tmux, gh, and Claude Code (`claude-code@latest` cask), all via Homebrew
- A claude.ai login with a Pro or Max plan (Remote Control does not work with API keys)
- A GitHub login for `gh`, if you want repos created or cloned for you (optional). Every GitHub
  action first checks that `gh` is installed and logged in, and refuses with instructions
  otherwise; local-only projects work without it.
- Remote Control accepted once on the Mac (Claude Code asks the first time)
- The Mac set to never sleep on AC power

## Install

On any Mac, including a fresh one:

```bash
git clone git@github.com:jimmynyny/claudecodeanywhere.git
cd claudecodeanywhere
./install.sh
```

The installer is interactive where a person is needed (the claude.ai and GitHub logins open a
browser, the Remote Control acceptance wants a `y`, disabling sleep wants your password) and
automatic everywhere else. It asks for two things: the folder that holds your project folders,
and the machine name to show in the Orchestrator's title. It ends by printing the Orchestrator
link. Rerunning it is safe; every step is skipped once done.

```
./install.sh --check              # report what is installed and configured, change nothing
./install.sh --root ~/Projects --name Mini --yes   # non-interactive, for scripted setups
./install.sh --no-github          # skip the gh login
```

Each Mac gets its own agent and its own Orchestrator, named `CCA Orchestrator (<machine name>)`,
so with two Macs you see two Orchestrators in your session list and talk to whichever machine
you want. They do not need to know about each other. Give each Mac its own projects root (never
a folder synced between them by Dropbox or iCloud; two machines editing one working tree
corrupts git). Code moves between Macs through GitHub: ask either Orchestrator for a session in
a project it does not have yet and it clones the repository first.

What the installer sets up:

- `~/Library/LaunchAgents/com.claudecodeanywhere.agent.plist`, a per-user launchd
  job that starts the agent at login and restarts it if it dies. No terminal, menu bar item, or
  babysitting required. After a cold boot with FileVault on, nothing runs until the disk is
  unlocked at the login screen; `sudo fdesetup authrestart` skips that once for a planned restart.
- `~/Library/Application Support/ClaudeCodeAnywhere/config.json` (see Configuration).

To remove the agent: `scripts/uninstall-agent.sh`. Running servers and sessions in tmux are
left alone. To remove everything, also delete the Application Support folder above and the
launchd plist, and `brew uninstall` whatever you no longer want.

## Using the Orchestrator

Open the Orchestrator session and type (or dictate) what you want. It replies with one or two
lines and a tappable link. The link opens the folder or session in the Claude app or the
browser you are already in.

| You say | It does |
| - | - |
| what's running / anything waiting on me | Lists servers and sessions with idle, busy, or waiting state and links; waiting items first. |
| list my projects / which project | Numbered list of recent project folders; answer with a number or a name. |
| what repos do I have / is X on GitHub | Lists every repository your `gh` login can reach, marking which are already cloned here. |
| start a session in X (when X is only on GitHub) | Clones the repository into the root first, then proceeds. This is how a second Mac picks up a project. |
| clone X here | Clones without starting anything. |
| start a session in X / open X / resume X | Starts (or resumes) X's server and returns the folder link. |
| new project X | Creates `<root>/X`, `git init -b main`, README, first commit, a private GitHub repo, pushes, starts the server. Say "public" or "no github" to change that. |
| in X, do Y / new project X and build Y | Starts one handoff session that begins on Y right away and returns its link. For a new project, no folder server is started in this case, so you get exactly one new entry in your session list. |
| move the X session to the CCA server | Resumes that session's conversation inside CCA's tmux server so it can use the login keychain (for Xcode signing). |
| stop X / stop that session | Stops a server or a session (it confirms first). Works for servers and sessions you started by hand too, including a server in the root folder. The Orchestrator refuses to stop itself. |
| keep X running / pin X | Marks X pinned so its server is always restarted, including after login. |
| let sessions push without asking / enable auto git push in X / stop asking about npm test | Adds a permission allow rule for that folder (reaches running sessions) or, if you say "for all my sessions", for every session on the Mac. "From now on" also makes it a default for future CCA sessions. |
| is the Mac ok / why did that fail | Reports login state, gh state, sleep setting, and any failures with their cause. |

Tips:

- Write handoff tasks as you would brief an engineer: goal, stack, and "commit when done" if
  you want a commit. The Orchestrator passes it through.
- A handoff session that needs you shows as `waiting` with a reason (for example `permission
  prompt`). Turn on **Push when actions required** with `/config` in any Claude Code session so
  your phone is notified.
- You can also use Claude Code's own session list directly: once a project's server is running,
  the Claude app can start new sessions in that folder without the Orchestrator.
- At the desk, `tmux -L cca attach -t cca-<project>` shows a server's screen and
  `tmux -L cca attach -t cca-<project>-s1` a handoff session's. Detach with `Ctrl-b d`. CCA
  runs its own tmux server (socket `cca`), separate from any tmux you start yourself; see
  [Xcode, signing, and the keychain](#xcode-signing-and-the-keychain) for why.

## Permission modes

Claude Code's permission mode decides which actions a session may take without asking.

- **Project servers** use Claude Code's default unless `defaultPermissionMode` is set. Prompts
  from their sessions are forwarded to your phone like any Remote Control session.
- **Handoff sessions** use `handoffPermissionMode`, default `auto`: Claude Code's classifier
  allows routine actions and only stops for risky ones, so unattended work makes progress.
  `acceptEdits` is the conservative alternative (file edits proceed, commands still ask).
  Either can be overridden per request by telling the Orchestrator, for example "in plan mode".
- **The Orchestrator** runs in Claude Code's default mode with the `cca` tools pre-approved.
  Anything else it tries to do prompts, and that prompt reaches your phone.
- **Allow rules** sit on top of any mode. Every folder CCA starts a server or session in gets
  the rules in `allowRules` (default `Bash(git push:*)`) written to its
  `.claude/settings.local.json`, which Claude Code keeps out of git. Claude Code reloads that
  file live, so the `allow_rules` tool can switch a rule on for sessions that are already
  running. Rules use Claude Code's own syntax; `Bash(npm test:*)` allows any `npm test …`.

## Xcode, signing, and the keychain

Building and signing iOS or macOS apps needs the login keychain, where your signing keys live.
macOS only hands the keychain to processes in your GUI login session. A tmux server started
from an SSH session is not in that session, and neither is anything it spawns, ever: inside it,
`security` answers "User interaction is not allowed" and `xcodebuild` cannot sign. Unlocking the
keychain in the SSH shell does not help, because the lock state belongs to the session, not the
file.

CCA avoids this by running its own tmux server, on socket `cca`, started by the agent, which
launchd runs inside your GUI login session. Every server and session CCA starts inherits that
session, so `xcodebuild`, `codesign`, `security`, and anything else that needs the keychain
works exactly as it does in a terminal window at the desk. `list_status` reports `keychainOk`
and the number of code-signing identities the agent can see; a warning appears if the keychain
is not reachable.

Two things can still get in the way:

- **A key that still asks for a click.** The first time a tool such as `codesign` uses a
  signing key, macOS shows an "allow access" dialog, which nobody is there to click. Grant it
  once at the desk by clicking "Always Allow", or grant it from a terminal for the Apple tools:
  `security set-key-partition-list -S apple-tool:,apple: -s -k '<login password>' ~/Library/Keychains/login.keychain-db`.
- **A keychain that locks itself.** Keychain Access → login keychain → Settings: if "Lock after
  N minutes" or "Lock when sleeping" is on, the keychain locks while you are away and signing
  waits for a password. Turn both off on a machine that builds unattended.

Servers you started by hand in your own tmux keep whatever session they were born in. To give one
keychain access, stop it and let CCA start it: "start a session in X". For a session you want to
keep, say "move the X session to the CCA server": it is stopped and resumed with
`claude --resume` inside CCA's tmux server, same conversation, same claude.ai link. Shell commands
that were running in it are lost, so the Orchestrator confirms first if it is busy.

## Configuration

`~/Library/Application Support/ClaudeCodeAnywhere/config.json` is created on first start:

| Key | Default | Meaning |
| - | - | - |
| `rootDir` | asked at install (or `$CCA_ROOT`) | Folder that contains all project folders. Projects are referred to by folder name. |
| `userName` | your account's first name | How the Orchestrator refers to you. |
| `machineName` | hostname | Appears in the Orchestrator's name and status. |
| `port` | `7777` | Agent port on localhost. |
| `githubOwner` | `null` | Owner for new repos; `null` uses the account `gh` is logged in as. |
| `defaultSpawn` | `same-dir` | `same-dir` or `worktree` for sessions created in a project's server. |
| `defaultPermissionMode` | `null` | Permission mode for project servers; `null` is Claude Code's default. |
| `handoffPermissionMode` | `auto` | Permission mode for handoff sessions. |
| `allowRules` | `["Bash(git push:*)"]` | Permission allow rules written into every folder CCA starts a server or session in. |
| `pinned` | `[]` | Project folder names whose server is always kept running. |
| `orchestrator.enabled` | `true` | Set `false` to run the agent without an Orchestrator. |
| `orchestrator.permissionMode` | `null` | Permission mode for the Orchestrator session. |
| `preventSleep` | `false` | Run `caffeinate -s` while the agent is up. |

Restart after editing: `launchctl kickstart -k gui/$(id -u)/com.claudecodeanywhere.agent`.

Other files in the same folder: `state.json` (servers the agent started, for resume), `orchestrator/`
(the Orchestrator's folder, regenerated on every agent start), `prompts/` (handoff prompts).
Logs are in `~/Library/Logs/ClaudeCodeAnywhere/agent.log` and `agent.err.log`.

## What the agent does

- **Discovery**, every time it is asked: reads `~/.claude/sessions/*.json` (Claude Code writes
  one per live session with name, folder, idle/busy/waiting status, and claude.ai session id),
  joins it with `ps` to find `claude remote-control` servers and their child sessions, and with
  `tmux list-panes` to know which tmux session hosts what. Links for hand-started servers are
  read from their tmux screen. Servers you started yourself in your own tmux are listed too.
- **Starting a server**: records workspace trust for the folder in `~/.claude.json` (the same
  thing answering Claude Code's trust prompt does; required because Remote Control rejects
  scripted answers), creates tmux session `cca-<project>`, runs `claude remote-control` there,
  and waits for the link. Idempotent. Resumes recent sessions automatically.
- **Starting a handoff session**: same trust step, tmux session `cca-<project>-sN`, then
  `claude --remote-control "<name>" --permission-mode <mode> "<prompt>"`, with the prompt read
  from a file so quoting never matters. Waits until the session registers with Remote Control.
- **Creating a project**: `mkdir`, `git init -b main`, README and `.gitignore`, first commit,
  `gh repo create <owner>/<name> --private --source . --remote origin --push`, then either
  starts the folder's server, or, when a first task was given, one handoff session instead. Each step is reported; on failure the folder is kept so
  the problem can be fixed and `start_server` used.
- **Supervisor**, every 15 seconds: checks the Claude login every 5 minutes, keeps the
  Orchestrator running (resuming with `--continue` when possible), keeps pinned servers running,
  with exponential backoff on failures.
- **Health**: Claude Code version and login, `gh` auth, tmux, root folder, AC sleep setting, and
  any supervisor failures, exposed as warnings.

## The cca tools

| Tool | Arguments | Returns |
| - | - | - |
| `list_status` | | Machine health, warnings, Orchestrator link, counts. |
| `list_projects` | `query?` | Folders under the root with git branch, remote, last commit, pinned flag, server state. |
| `list_repos` | `query?` | GitHub repositories reachable by `gh`, each with the local folder that tracks it or null. |
| `clone_repo` | `repo`, `name?` | Clones a reachable repository into the root. |
| `list_sessions` | | Three lists: servers (with the sessions they host), handoff sessions (independent single sessions CCA started with a task), standalone sessions. |
| `start_server` | `project`, `name?`, `spawn?`, `permission_mode?` | The server, with its folder link. Clones the repo first if the folder is missing. |
| `stop_server` | `project` | Stopped state and resume deadline. |
| `start_session` | `project`, `prompt`, `name?`, `permission_mode?` | The handoff session, with its link. |
| `stop_session` | `session` (name, id, pid, or tmux session) | Whether it was stopped; works for handoff, hosted, and standalone sessions. |
| `move_session` | `session` | Stops a session and resumes its conversation inside CCA's tmux server, for keychain access. |
| `create_project` | `name`, `github?`, `private?`, `description?`, `start?`, `prompt?` | Job steps, repo URL, server link, session link. |
| `allow_rules` | `scope?`, `project?`, `rules?`, `remember?` | Rules added to the folder's local settings or the user settings; takes effect in running sessions. |
| `pin_project` | `project`, `pinned` | The pinned list. |
| `upgrade_cca` | `check_only?` | Pulls the latest CCA on this Mac and restarts the agent, or just reports the version. |

The same actions are available over HTTP on `127.0.0.1:7777` (`/api/status`, `/api/projects`,
`/api/sessions`, `/api/projects/:slug/server`, `/api/projects/:slug/sessions`, `/api/sessions/:id`,
`/api/projects/:slug/pin`, `/api/permissions`, `/api/repos`, `/api/repos/:name/clone`, `/api/jobs/:id`, `/api/debug`).

## Operations

```bash
# status
curl -s localhost:7777/api/status | jq '{login: .login.loggedIn, warnings, orchestrator}'
tail -f ~/Library/Logs/ClaudeCodeAnywhere/agent.log

# restart / stop / start the agent
launchctl kickstart -k gui/$(id -u)/com.claudecodeanywhere.agent
launchctl bootout gui/$(id -u)/com.claudecodeanywhere.agent
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.claudecodeanywhere.agent.plist

# see what is running in CCA's tmux server
tmux -L cca ls
tmux -L cca attach -t cca-orchestrator      # Ctrl-b d to detach

# upgrade to the latest version (see "Upgrading")
scripts/upgrade.sh
```

Restarting the agent never stops servers or sessions; they live in tmux. Stopping the
Orchestrator's server (Ctrl-C in its tmux window) makes the agent resume it within 15 seconds.

## Upgrading

Every Mac upgrades itself from GitHub; nothing is pushed from one Mac to another.

- **From your phone**: tell that Mac's Orchestrator "upgrade CCA". It pulls the latest code,
  reinstalls dependencies if they changed, and restarts the agent. Running servers and sessions
  are untouched. If the Orchestrator's own instructions or tools changed it restarts itself a few
  seconds later and keeps its conversation. "Is CCA up to date?" reports the installed commit and
  how many commits behind it is without changing anything.
- **At the Mac**: `scripts/upgrade.sh` does the same thing from a terminal. `git pull &&
  ./install.sh --yes` is equivalent and also re-checks prerequisites and the launchd job.
- Upgrades refuse to run on a checkout with uncommitted local changes, which protects a machine
  you develop CCA on; commit or stash first.
- `list_status` includes a `version` block (commit, date, branch, commits behind origin).

## Troubleshooting

| Symptom | Cause and fix |
| - | - |
| Orchestrator missing from the session list | Agent not running or Claude not logged in. `curl localhost:7777/api/status`; check `agent.err.log`; on the Mac run `claude auth login`. |
| "Claude Code is not logged in" warning | The claude.ai login expired. This needs a browser on the Mac; nothing remote can fix it. |
| `create_project` fails at the GitHub step | `gh auth status` on the Mac; re-login or check the token's permissions. The folder is kept; `start_server` works once fixed. |
| Server start times out with a trust prompt on screen | Trust was not recorded. Check `~/.claude.json` is writable; `~/.claude.json.cca-backup` is the copy taken before the last write. |
| "Remote Control has not been enabled on this Mac yet" | Run `claude remote-control` once in a terminal there and accept. |
| Sessions go offline at night | The Mac sleeps. `sudo pmset -c sleep 0`, or set `preventSleep: true`. |
| Links missing for hand-started servers | They were started outside tmux, so there is no screen to read. The sessions still list with their own links. |
| `xcodebuild` or `codesign` fails with "User interaction is not allowed" | The session is not in the GUI login session. If it is a CCA session, check `keychainOk` in `list_status` and reinstall the agent; if you started it by hand over SSH, let CCA start it instead. See the keychain section. |
| Everything offline after a reboot | FileVault is waiting for a password at the login screen. |

## Repository layout

```
packages/agent/src/
  main.ts          entry point: config, API, supervisor
  api.ts           HTTP routes on localhost
  servers.ts       discovery snapshot, start/stop servers, start/stop handoff sessions
  projects.ts      project listing, git info, create project
  supervisor.ts    keep-alive loop for the Orchestrator and pinned servers
  orchestrator.ts  writes the Orchestrator folder and resumes its session
  claudeCode.ts    everything that depends on Claude Code internals (registry, ps, links, trust)
  tmux.ts          tmux helpers
  health.ts        health checks and warnings
  jobs.ts          step-by-step job progress
  config.ts        config file and paths
  state.ts         agent-started server records
  exec.ts, log.ts  process execution and logging
packages/cca-mcp/src/main.ts   the cca MCP server (stdio), forwards to the agent
orchestrator/CLAUDE.md.tmpl    the Orchestrator's instructions; installed on every agent start
install.sh                     one-shot installer: prerequisites, logins, config, launchd agent
scripts/install-agent.sh       launchd install only (idempotent); uninstall-agent.sh
scripts/upgrade.sh             pull the latest CCA and restart the agent
scripts/dev/run.sh             foreground agent with auto-reload
scripts/dev/spike-start-server.sh  the M0 proof-of-concept, kept for reference
PLAN.md                        design, decisions, verified internals, milestone results
```

## Development

```bash
scripts/dev/run.sh                 # foreground agent with auto-reload (stop the launchd job first, or set CCA_PORT)
npm run typecheck
curl -s localhost:7777/api/debug | jq   # process/pane matching, for discovery problems
```

Everything that depends on undocumented Claude Code behavior is in `claudeCode.ts` and is
listed in PLAN.md section 2, so a Claude Code update that breaks discovery has one place to fix.

## Security notes

- CCA's tmux server runs inside your GUI login session so sessions can use the login keychain
  for code signing. That is the same access a terminal window at the desk has.
- The agent binds to localhost only. Nothing is exposed to the network; all remote access goes
  through Anthropic's Remote Control, which is outbound-only from the Mac.
- The Orchestrator and every session it starts are full Claude Code sessions on your Mac, with
  the permissions described above. Treat the Orchestrator's link like a terminal on that Mac.
- Recording workspace trust is limited to folders you explicitly ask the agent to serve, and
  the Orchestrator's own folder. A backup of `~/.claude.json` is taken before each write.
- While Remote Control is connected, session transcripts are stored by Anthropic to keep devices
  in sync, as with any Remote Control session. Execution and files stay on the Mac.
