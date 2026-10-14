# Claude Code Anywhere — Plan

A macOS menu bar app that keeps an always-on Claude Code Remote Control session called
**The Orchestrator** running on each home Mac. From the Claude iPhone app you open the
Orchestrator and say "new private project tcg-scanner" or "start a session in
my-app", and it does the folder, git, GitHub, and server work on the Mac and
hands you a tappable link into the new session. No cloud service, no VPN, no Tailscale,
no web UI of our own: the Claude app and claude.ai/code in any browser on any device are
the interface, and Anthropic's Remote Control channel is the transport, already
authenticated and encrypted, with push notifications included.

The effect: the Orchestrator turns your own Macs into your personal Claude cloud. Same
"ask Claude to work on X" experience as Anthropic's cloud sessions, but the code, files,
tools, and compute are all at home.

Status: planning. Nothing built yet.

---

## 1. The problem, concretely

Today, starting a Remote Control (RC) session away from home means:

1. Open Tailscale, SSH into the Studio from the phone.
2. `cd` to the repo (or `mkdir`, `git init`, create a GitHub repo, add the remote).
3. `tmux new -s something`, run `claude remote-control --name "..."`, answer the
   trust and spawn-mode prompts, detach.
4. Open the Claude app and find the session.

The tmux pane on this Mac literally shows the pain: typo'd commands, a `claude --rc &`
that got suspended on tty output, a login that had expired mid-flow.

Goal: each of those steps becomes one sentence typed (or dictated) to the Orchestrator,
and the menu bar tells you at a glance what is running.

## 2. What was verified on this Mac (the Studio, Claude Code 2.1.289)

These facts drive the design. Re-verify them when Claude Code updates; some are
undocumented internals.

**Remote Control is a per-folder server, not a per-session command.**
`claude remote-control --name "X"` started in a folder runs a server that can host up
to 32 sessions (`--capacity`). It prints a per-folder deep link:

```
https://claude.ai/code?environment=env_…
```

Once that server is up, the Claude iOS app and claude.ai/code can create **new**
sessions in that folder on their own ("spawn mode"). `--spawn=session` makes a server
host exactly one session and refuse others, which is the right shape for the
Orchestrator.

**Every live session is registered on disk.** `~/.claude/sessions/<pid>.json` holds:

```json
{"pid":87137,"sessionId":"0348d31e-…","cwd":"/Users/…/claudecodeanywhere",
 "kind":"interactive","entrypoint":"sdk-cli","tmux":"claudecodeanywhere:@2.%2",
 "name":"claudecodeanywhere-35","status":"busy","bridgeSessionId":"session_01PtBh…",
 "startedAt":1791859405233,"updatedAt":…}
```

`status` flips between `idle` and `busy`, `bridgeSessionId` is the claude.ai session,
and `tmux` names the pane. `claude agents --json` returns a trimmed version of the same
list without a TTY. The JSON files also support `fs.watch`.

**Process shape.** The server process is `claude remote-control --name X`; each session
it hosts is a child `claude --print --sdk-url …/code/sessions/cse_… --session-id cse_…`
with a scratch dir under `~/.claude/bridge-spawn/<cse_id>-xxxx/`. A `ps` join on parent
pid maps sessions to servers.

**Headless launch gotchas, all solvable.**
- Workspace trust: with no TTY the server exits with `Workspace not trusted`. Fix: launch
  inside tmux (gives a pty) and pre-write
  `~/.claude.json → projects["<abs path>"].hasTrustDialogAccepted = true` for new folders.
- Spawn-mode prompt (`Choose [1/2]`): skipped by passing `--spawn=…` explicitly.
- One-time "Enable Remote Control? (y/n)": already accepted on this machine
  (`remoteDialogSeen: true`); must be accepted once on the Mini by hand.
- Auth: RC needs a claude.ai login (Pro/Max), not an API key. Credentials live in
  `~/.claude/.credentials.json`, so a launchd-started process can use them. Logins do
  expire; the app must detect `You must be logged in` and surface it.
- Network: in server mode a ~10 minute outage makes the server exit. Sessions can be
  resumed with `claude remote-control` in the same folder for about 4 hours after a stop.
  The agent auto-restarts servers and uses that window.

**Cross-session messaging exists.** Sessions on the same account can list and message
each other (`ListAgents`, `SendMessage`), including across machines when RC is
connected. Needs an M0 test, but it means the Orchestrator can hand a first prompt to a
session it just created.

**Environment on this Mac.** Node 25 and npm 11, Xcode/swiftc, tmux, gh (token currently
logged in with a fine-grained PAT, verified for private repo create/delete), Claude.app installed. No Rust, no bun. Tailscale is
installed but this design does not use it.

## 3. Architecture

```
 iPhone Claude app / claude.ai/code
        │  Anthropic Remote Control (already authenticated, encrypted, push-capable)
        ▼
 ┌────────────────────────────────────────┐  one per Mac, always on
 │  The Orchestrator                      │  claude remote-control --spawn=session
 │  a normal Claude Code session running  │  in ~/…/ClaudeCodeAnywhere/orchestrator
 │  in a dedicated folder with:           │
 │   • CLAUDE.md  (role + rules)          │
 │   • .mcp.json  (the cca MCP server)    │
 │   • .claude/settings.json (allowlist)  │
 └───────────────────┬────────────────────┘
                     │ MCP tools (stdio)
                     ▼
 ┌────────────────────────────────────────┐
 │  cca-mcp   thin stdio shim             │──── localhost HTTP ────┐
 └────────────────────────────────────────┘                        ▼
                                             ┌──────────────────────────────┐
 ┌────────────────────────────────────────┐  │  Agent (Node/TS, launchd)    │
 │  Menu bar app (SwiftUI)                │─▶│  discovery, tmux, git, gh,   │
 │  status, quick actions, login item,    │  │  keep-alive                  │
 │  installs the agent LaunchAgent        │  │  127.0.0.1:7777              │
 └────────────────────────────────────────┘  └──────────────────────────────┘
```

The control plane is Claude itself. There is nothing to host and nothing to secure
beyond what every RC session already has.

### 3.1 The Orchestrator session

A dedicated folder, e.g. `~/Library/Application Support/ClaudeCodeAnywhere/orchestrator/`,
created and maintained by the agent, containing:

- **`CLAUDE.md`**: "You are the Orchestrator for the Studio. Your only job is to manage
  Claude Code projects and Remote Control servers on this Mac using the `cca` tools.
  Projects live under `<root>`. Always answer with the tappable link to the resulting
  session. Confirm before stopping servers or deleting anything. Never edit files in
  project folders yourself; start a session there instead." Plus a cheat sheet of what
  each tool does and the house conventions (branch `main`, private repos by default).
- **`.mcp.json`**: registers `cca` as a stdio MCP server (`node …/cca-mcp/dist/index.js`).
- **`.claude/settings.json`**: `permissions.allow: ["mcp__cca__*"]` so routine tool calls
  never prompt, and `disableAllHooks`-style minimalism so project hooks never apply.
  Anything that would prompt is still forwarded to the phone, so leaving Bash at
  default permission is acceptable.

The agent launches it exactly like any other server, just with fixed flags:

```
claude remote-control --name "Orchestrator (Studio)" --spawn=session
```

`--spawn=session` keeps it to one conversation. The agent treats it as a pinned server
with the highest restart priority and resumes it (4h window) rather than creating a new
one, so the conversation history survives restarts. Compaction handles long histories.

The chain for every request is the same: you → Orchestrator session → `cca` MCP tool
→ agent on localhost → tmux → `claude remote-control` in the target folder → link back.

Worked examples (these two are the M1 acceptance test):

- **"start a new remote control code session in folder X"**
  1. Orchestrator calls `start_server({project: "X"})`.
  2. Agent pre-writes trust for the folder, runs `tmux new-session -d -s cca-X
     -c <root>/X`, sends `claude remote-control --name "X" --spawn=same-dir` into the
     pane, and polls the pane until `environment=env_…` appears (or an error line).
  3. Orchestrator replies with the link. Tapping it opens folder X in the Claude app,
     where you start the coding session.
- **"create a new folder Y and attach it to my github, and start a new remote control
  session for a new project"**
  1. Orchestrator calls `create_project({name: "Y", github: true, private: true})`.
  2. Agent: mkdir → `git init -b main` → README → first commit →
     `gh repo create <owner>/Y --private --source . --remote origin --push` → same
     tmux start as above. Each step streams back as progress; a failure names the step
     and "retry" resumes from it.
  3. Orchestrator replies with the link.
- "what's running?" → table of servers and sessions with idle/busy, uptime, links.
- "stop everything except Orchestrator" → confirms, then stops.
- "tell the Mini to start a session in tcg-scanner" → forwards to the Mini's
  Orchestrator over Claude's cross-session messaging (M3).

### 3.2 `cca` MCP server (thin)

A stdio MCP server that only forwards to the agent's localhost API; it holds no logic,
so the agent remains the single brain and the menu bar app sees the same state.
Tools (all return compact JSON that Claude turns into prose):

```
list_status()                       machine, health, warnings, Claude Code version
list_projects({query?})             folders under root, git remote, server state
list_sessions()                     every RC server + its sessions, links, idle/busy
start_server({project, spawn?, permissionMode?})   start or resume; returns env link
stop_server({project})              stops; marks resumable-until
create_project({name, github: bool, private: bool, description?})
                                    full flow, streams step progress; returns links
pin_project({project, pinned})      always-on toggle
```

Links come back as markdown so they are tappable in the app.

### 3.3 Agent (the brain)

Single long-running Node/TypeScript process, installed as a user LaunchAgent
(`~/Library/LaunchAgents/com.claudecodeanywhere.agent.plist`, `KeepAlive`,
`RunAtLoad`, PATH including `/opt/homebrew/bin`). Listens on `127.0.0.1:7777` only.

- **Config**: root folder (`~/Dropbox/Documents/__SCRIPTS` today), machine name, pinned
  projects, GitHub owner, defaults for spawn and permission mode. Stored in
  `~/Library/Application Support/ClaudeCodeAnywhere/config.json`.
- **Discovery** (every 2s plus `fs.watch` on `~/.claude/sessions`): read the session
  JSON files, drop dead pids, join to `claude remote-control` parents via `ps`, join to
  tmux panes, parse `environment=env_…` from `tmux capture-pane` once per server and
  cache it per folder. Also detect servers started by hand.
- **Actions**: `startServer` (ensure trust in `~/.claude.json` → `tmux new-session -d
  -s cca-<slug> -c <folder>` → send the `claude remote-control …` line → poll the pane
  for the env link or an error), `stopServer` (C-c, then kill the tmux session),
  `createProject` (slug check → mkdir → `git init -b main` → README → commit →
  `gh repo create <owner>/<name> --private --source . --remote origin --push` →
  `startServer`), each step reported as job progress and resumable on failure.
- **Keep-alive**: Orchestrator first, then pinned projects; restart on exit with
  backoff; prefer resume inside the 4h window.
- **Health**: login state, Claude Code version/update, tmux and gh presence, root
  folder, Mac sleep setting (warn, or run `caffeinate -s`), disk free.
- **Optional local dashboard**: the same API can serve a small static page for use on
  the Mac itself. Not needed on the phone, so it is a late, optional milestone.

### 3.4 Menu bar app

Native SwiftUI `MenuBarExtra` (macOS 13+), deliberately thin:

- Icon shows counts, red when the agent is down, the login expired, or the
  Orchestrator is offline.
- Menu: Open Orchestrator (deep link), running servers (click → open in Claude.app or
  claude.ai), Start server in… (folder picker limited to root), New project…, Pause /
  Resume all, Logs, Quit agent.
- **Auto-start**: registers itself as a login item with `SMAppService.mainApp` and the
  agent's LaunchAgent with `SMAppService.agent(plistName:)`, so one install sets up
  both. The agent keeps running when the menu bar app is quit.
- Root folder chooser via `NSOpenPanel`, saved as a security-scoped bookmark and written
  to the agent config.

## 4. Multi-machine

Same agent and menu bar app on the Mini, with its own Orchestrator. The two Macs never
talk to each other over the network. Both Orchestrators appear in your session list, so
you can address either directly, and in M3 the Studio's Orchestrator can relay a request
to the Mini's through Claude's cross-session messaging, which rides the same RC
connection. Each Mac is fully independent: if one is down, the other is unaffected.

## 5. Repo layout

```
claudecodeanywhere/
  PLAN.md
  packages/
    agent/        Node + TypeScript (Hono, execa, chokidar, zod)
    cca-mcp/      stdio MCP server, forwards to the agent
    shared/       API and tool types
  orchestrator/   CLAUDE.md, .mcp.json, .claude/settings.json templates the agent
                  copies into the Orchestrator folder on first run
  apps/
    menubar/      Xcode project, SwiftUI MenuBarExtra
  scripts/
    install-agent.sh   writes the LaunchAgent plist, loads it
    dev.sh             runs the agent in watch mode
```

## 6. Milestones

**M0 — Spike. Done 2026-10-12, see section 9.** From a launchd-started shell, start `claude remote-control`
in tmux for a given folder with trust pre-written and `--spawn=…`, and print the `env_…`
link. Start a second one with `--spawn=session` and confirm the Claude app can only open
that one conversation. Test cross-session messaging between two local sessions. Fix
`gh auth login`.

**M1 — Agent + MCP + Orchestrator (the MVP). Done 2026-10-12, see section 10.** Discovery, start/stop/resume, create
project with GitHub, keep-alive, the Orchestrator folder and its CLAUDE.md. Installed
via `scripts/install-agent.sh`. Done when: from the phone, in the Orchestrator chat,
"new private project foo" ends with a tappable link and you are talking to Claude in
that repo within 30 seconds.

**M2 — Menu bar app (optional, deferred 2026-10-12).** Auto-start is already covered by the
launchd job from M1 (`RunAtLoad` + `KeepAlive`, installed by `scripts/install-agent.sh`), so a
menu bar app is no longer required. If built later: status icon, quick actions, root folder
picker. Note: with FileVault on, nothing runs after a cold boot until someone unlocks the disk
at the login screen; a LaunchDaemon would not change that. `sudo fdesetup authrestart` skips
the unlock once for a planned restart.

**M3 — Mini.** Install on the Mini. Verify cross-session messaging between the two
Orchestrators so either one can relay "start a session in X" to the other machine.

**M4 — First-prompt handoff. Done 2026-10-13, see section 11.** `create_project` and the
new `start_session` accept a first prompt. The agent starts an interactive session with
`claude --remote-control "<name>" --permission-mode auto "<prompt>"` inside tmux, so work
starts before you open it. (Cross-session messaging was the original idea; the CLI route was
chosen because messages between sessions in different permission modes can be held for
approval.) Handoff sessions default to `auto` permission mode (decided 2026-10-13).

## 7. Risks and open questions

- **Undocumented internals.** `~/.claude/sessions/*.json`, `bridge-spawn/`, the
  `~/.claude.json` trust key, and the pane output format are not public API. Isolate
  them in one `claudeCode.ts` adapter with fixture tests; fall back to
  `claude agents --json` where possible.
- **The Orchestrator is a single point of control.** If its session dies, the agent
  restarts or resumes it within seconds; if the agent dies, launchd restarts the agent.
  Every other server still shows in the Claude app's native session list and the app
  can still spawn sessions in those folders without us. The Mini's Orchestrator is an
  independent second control plane.
- **Login expiry is the one thing a phone cannot fix.** RC needs a live claude.ai login
  and it expired on this machine today. Re-login needs a browser on the Mac. The agent
  must detect it early (before it bites) and the menu bar and a push notification must
  shout. Worth testing how long `~/.claude/.credentials.json` stays valid under
  continuous use; if it refreshes while a session is active, keeping the Orchestrator
  alive may keep the login alive.
- **Latency and cost.** Every Orchestrator action is a model turn, a few seconds and a
  little usage. Acceptable for a few actions a day; keep tool outputs compact.
- **Mac sleep.** The Studio must not sleep: Energy Saver setting or `caffeinate -s`.
- **Server exits after ~10 min offline.** Auto-restart plus the 4h resume window.
- **Root folder in Dropbox.** Dropbox syncing `.git` can be slow or conflict; consider a
  non-synced root for new projects.
- **Security.** The Orchestrator is a full Claude Code session on your Mac, like any RC
  session. The agent binds to localhost only. Nothing is exposed to the internet.

## 8. Decisions (settled 2026-10-12)

1. **Root folder**: keep `~/Dropbox/Documents/__SCRIPTS`. Revisit only if Dropbox sync
   causes git trouble.
2. **GitHub**: `gh` on the Studio, logged in with a fine-grained PAT; verified it can
   create and delete private repos. The Mini needs the same login at M3. Fine-grained
   PATs fail some GraphQL fields, so the agent uses `gh repo create` and REST
   (`gh api repos/…`), never GraphQL.
3. **Default spawn mode** for project servers: `same-dir`. Per-project override allowed.
4. **Orchestrator permissions**: a normal Claude Code session with Bash. Routine `cca`
   tool calls are pre-allowed; anything else prompts, and prompts are forwarded to the
   phone.

## 9. M0 results (2026-10-12, Claude Code 2.1.289)

Run with `scripts/dev/spike-start-server.sh <folder> <name> [same-dir|worktree|session]`
from a process whose stdout was not a terminal.

- **Headless start works.** A brand-new folder under the root got a running
  `claude remote-control` server inside a detached tmux session in 2 seconds, and the
  script captured `https://claude.ai/code?environment=env_…` from the pane.
- **No trust prompt appeared** for the new folder, and no trust entry was written to
  `~/.claude.json`. The script still answers `[y/N]` if one shows up, but the agent may
  not need the pre-write at all. Keep both paths and log which one fires.
- **The pre-created session registers normally.** Within seconds the server's own
  session appeared in `~/.claude/sessions/<pid>.json` (name `cca-spike-test-8f`, status
  `idle`, `tmux` pane, `bridgeSessionId`) and in `claude agents --json`. The pane shows
  `Capacity: 0/32` until then, so the agent should not treat 0 as an error.
- **`--spawn=session` prints a different link.** Single-session servers print
  `https://claude.ai/code/session_…` and the line `Single session · exits when complete`,
  not an `environment=` link. The Orchestrator's link is therefore a session link. The
  script now matches both shapes.
- **Cross-session messaging works and respects permissions.** `ListAgents` listed both
  spike sessions with their tmux panes. A `SendMessage` to the spike session was
  delivered, and that session immediately attempted a `Write`, then paused with registry
  status `waiting` and `waitingFor: "permission prompt"`, which was forwarded to the
  phone. Two consequences for M4: sessions meant to start work unattended need a
  permission mode chosen up front (for example `--permission-mode acceptEdits` on the
  server), and the Orchestrator should tell you when a session is waiting on you. The
  `waiting` / `waitingFor` fields are also exactly what the menu bar should surface.
- **Stopping is clean.** Ctrl-C in the pane ended each server, the registry entries
  disappeared, and `claude agents --json` no longer listed them. Resume-after-stop
  (the 4h window) was not exercised.
- **Not yet tested:** starting from a real launchd job rather than a non-TTY shell, and
  the Mini's one-time "Enable Remote Control?" acceptance.

## 10. M1 results (2026-10-12)

Shipped: `packages/agent` (Node/TypeScript, no build step), `packages/cca-mcp` (stdio MCP shim),
`orchestrator/CLAUDE.md.tmpl`, `scripts/install-agent.sh` (launchd). Installed and running on the
Studio as `com.claudecodeanywhere.agent`. The Orchestrator is live as
**CCA Orchestrator (the Studio)** in the claude.ai session list.

What was verified end to end:

- **Discovery** finds every server, including ones started by hand in the user's own tmux
  sessions, with folder, link, and hosted sessions (idle/busy/waiting). Sessions not under a
  server are listed separately.
- **Orchestrator answers through the tools.** Asked "what's running?" over cross-session
  messaging, it called `list_sessions` and replied in the house format with tappable links,
  waiting items first. The `.mcp.json` server loaded and the `mcp__cca` allow rule meant no
  permission prompt.
- **create_project** ran mkdir, `git init -b main`, README and first commit, `gh repo create
  --private --push`, and server start. Total 5 to 10 seconds once trust is handled.
- **start_server** on an existing folder takes about 2 seconds and is idempotent.
- **stop_server** stops cleanly; the record stays resumable for 4 hours.
- **Orchestrator resume**: after Ctrl-C on its server, the supervisor restarted it within one
  15-second tick using `--continue`, and the same session link came back.
- **launchd** start works; the agent adopts servers that were already running.

Things learned the hard way, all fixed in code:

- Claude Code rejects a scripted answer to the folder trust prompt ("That answer arrived too
  quickly after the question to count"). The documented route is to trust the folder in
  advance, so the agent records `hasTrustDialogAccepted` in `~/.claude.json` for a folder the
  user asked it to serve, with a backup copy first. Empty folders never prompt; folders with
  content do. A human-paced answer remains as a fallback.
- The Orchestrator's own folder prompts for trust because it carries `.mcp.json` and a
  pre-approved tool rule; same remedy.
- Under launchd there is no UTF-8 locale, and tmux then rewrites control characters in format
  strings, which silently broke pane matching. The agent now uses a printable separator and the
  launchd job sets `LANG`/`LC_ALL`.
- `launchctl bootout` is asynchronous; the install script now waits for the unload before
  bootstrapping again.
- tmux pane commands need `=name:` for an exact session match; `=name` alone is only valid for
  session-level commands.
- Single-session servers (`--spawn=session`) print a `/code/session_…` link, not an
  `environment=` link.

Not done in M1: the menu bar app (M2), the Mini (M3), first-prompt handoff (M4), and a
Claude Code login that expires still needs a browser on the Mac.

## 11. M4 results (2026-10-13)

Shipped: `start_session` / `stop_session` in the agent, API, and `cca` tools; `prompt` on
`create_project`; `handoffPermissionMode` (default `auto`) in config; Orchestrator
instructions for requests that include a task; full README.

Verified end to end through the API with a throwaway private repo:

- One request created the folder, repo, and server, then started a handoff session with the
  task "create hello.txt, commit, push". Total 9.3 seconds including the session connecting to
  Remote Control. Session name: `CCA cca-m4-test: Create a file named hello.txt in this repo…`,
  tmux `cca-cca-m4-test-s1`, link of the `/code/session_…` shape taken from the registry.
- Under `auto` mode the session created the file, committed, and pushed with no prompts
  (screen showed "Allowed by auto mode classifier" and the push result), finishing in about
  10 seconds after start.
- `stop_session` ended it cleanly (double Ctrl-C) and removed its tmux session.
- Discovery lists handoff sessions as `handoff: true` entries with `spawn: interactive`, and a
  folder's server and its handoff sessions coexist independently.

Verified through the Orchestrator itself (the real user path): asked "In cca-m4-orch, add an
MIT LICENSE file with the copyright holder the user, then commit it and push", it called
`start_session`, replied with the session link and the auto-mode note, and the session had the
commit on GitHub main about 15 seconds later. A first attempt failed because the running
Orchestrator predated the M4 files; the agent now hashes the Orchestrator's generated files and
restarts it (with `--continue`) whenever they change, so instruction and tool updates take
effect on their own.

Also added after a question from the user: `stop_session` works for any session (handoff, hosted
by a server, or standalone in a terminal; the latter get two SIGINTs like a person's Ctrl-C),
and `stop_server` accepts a server running in the root folder itself.

Changed 2026-10-13 after real use: `create_project` with a prompt now starts only the handoff
session, not the folder server as well. The server's pre-created idle session had shown up as a
second "CCA <project>" entry next to the working one. `start_server` adds the server later.

Added 2026-10-14: permission allow rules. `allowRules` (default `Bash(git push:*)`) are written
to `.claude/settings.local.json` of every folder CCA starts a server or session in, and the
`allow_rules` tool adds rules to a project or to `~/.claude/settings.json`. Claude Code reloads
settings files live, so this also reaches sessions already running.

Notes:

- The prompt is passed via a file (`…/ClaudeCodeAnywhere/prompts/<tmux>.txt`) and
  `"$(cat file)"`, so quotes and newlines in tasks are safe.
- The fine-grained GitHub token used by `gh` returns 403 on some read endpoints (commits,
  contents). The agent only needs `gh repo create`, which works; verification of pushes should
  use `git ls-remote` over SSH rather than the REST API.
