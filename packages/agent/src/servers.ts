import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { loadState, saveState, RESUME_WINDOW_MS, type ServerRecord, type State } from './state.ts';
import * as tmux from './tmux.ts';
import * as cc from './claudeCode.ts';
import { log } from './log.ts';
import { sleep } from './exec.ts';
import { APP_DIR } from './config.ts';
import * as permissions from './permissions.ts';

export interface SessionView {
  pid: number;
  name: string;
  status: string;
  waitingFor: string | null;
  sessionId: string;
  bridgeSessionId: string | null;
  link: string | null;
  cwd: string;
  startedAt: number;
  tmux: string | null;
}

export interface ServerView {
  folder: string;
  slug: string;
  name: string;
  pid: number | null;
  state: 'running' | 'stopped';
  /** `agent`: we started it in a `cca-*` tmux session. `manual`: found running some other way. */
  origin: 'agent' | 'manual';
  spawn: string;
  /** True for a single interactive session CCA started with a first prompt (M4 handoff). */
  handoff: boolean;
  tmuxSession: string | null;
  /** `cca` for the agent's own tmux server (GUI session, keychain works), `default` for the user's. */
  tmuxSocket: string | null;
  link: string | null;
  id: string | null;
  startedAt: number | null;
  stoppedAt: number | null;
  resumableUntil: number | null;
  sessions: SessionView[];
}

export interface StartSessionOptions {
  /** First task. Required unless `resume` is given. */
  prompt?: string;
  /** Claude Code session id to resume instead of starting a new conversation. */
  resume?: string;
  name?: string;
  permissionMode?: string | null;
}

export interface HandoffSessionView {
  folder: string;
  slug: string;
  name: string;
  tmuxSession: string;
  tmuxSocket: string;
  pid: number;
  sessionId: string;
  link: string;
  permissionMode: string | null;
  startedAt: number;
}

export interface Snapshot {
  /** Multi-session `claude remote-control` servers, running or recently stopped. */
  servers: ServerView[];
  /** Single interactive sessions CCA started with a first prompt. Independent of any server. */
  handoffSessions: ServerView[];
  /** Sessions not under a server and not started by CCA (plain `claude` in a terminal). */
  standaloneSessions: SessionView[];
  takenAt: number;
}

export interface StartOptions {
  name?: string;
  spawn?: string;
  permissionMode?: string | null;
  /** Use `claude remote-control --continue` to bring back the previous session. */
  continue?: boolean;
  continueOnRestart?: boolean;
}

export function slugOf(folder: string): string {
  return path.basename(folder).replace(/[^A-Za-z0-9_.-]+/g, '-');
}

export function tmuxNameFor(folder: string): string {
  return `cca-${slugOf(folder)}`;
}

/** Every session CCA starts is named "CCA …" so it is recognisable in the claude.ai session list. */
export function ccaName(name: string): string {
  const n = name.trim();
  return /^CCA\s/.test(n) ? n : `CCA ${n}`;
}

function toSessionView(s: cc.RegistrySession): SessionView {
  return {
    pid: s.pid,
    name: s.name,
    status: s.status,
    waitingFor: s.waitingFor,
    sessionId: s.sessionId,
    bridgeSessionId: s.bridgeSessionId,
    link: s.bridgeSessionId ? cc.sessionLink(s.bridgeSessionId) : null,
    cwd: s.cwd,
    startedAt: s.startedAt,
    tmux: s.tmux,
  };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const START_TIMEOUT_MS = 90_000;

export class ServerManager {
  private cfg: Config;
  private state: State;
  private linkCache = new Map<number, string>();
  private starting = new Set<string>();

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.state = loadState();
  }

  record(folder: string): ServerRecord | undefined {
    return this.state.servers[path.resolve(folder)];
  }

  get orchestratorHash(): string | null {
    return this.state.orchestratorHash;
  }

  set orchestratorHash(h: string | null) {
    this.state.orchestratorHash = h;
    saveState(this.state);
  }

  async snapshot(): Promise<Snapshot> {
    const [table, panes] = await Promise.all([cc.listProcesses(), tmux.listPanes()]);
    const registry = cc.readSessionRegistry();
    const byPid = new Map(registry.map((s) => [s.pid, s]));
    const paneByPid = new Map(panes.map((p) => [p.panePid, p]));
    const servers: ServerView[] = [];
    const handoffSessions: ServerView[] = [];
    const claimed = new Set<number>();

    for (const proc of table.claude) {
      if (proc.kind !== 'server' && proc.kind !== 'rc-interactive') continue;

      let pane: tmux.Pane | null = null;
      for (const p of [proc.pid, ...cc.ancestors(table, proc.pid)]) {
        const found = paneByPid.get(p);
        if (found) {
          pane = found;
          break;
        }
      }
      const tmuxSession = pane?.session ?? null;
      const record = pane
        ? Object.values(this.state.servers).find((r) => r.tmuxSession === pane!.session && r.tmuxSocket === pane!.socket)
        : undefined;

      const sessions: SessionView[] = [];
      if (proc.kind === 'server') {
        for (const c of table.claude) {
          if (c.kind !== 'rc-child' || c.ppid !== proc.pid) continue;
          const reg = byPid.get(c.pid);
          if (reg) {
            sessions.push(toSessionView(reg));
            claimed.add(reg.pid);
          }
        }
      } else {
        const reg = byPid.get(proc.pid);
        if (reg) {
          sessions.push(toSessionView(reg));
          claimed.add(reg.pid);
        }
      }

      // A `claude --rc` process with no registered session is not serving anything (e.g. suspended by its shell).
      if (proc.kind === 'rc-interactive' && sessions.length === 0) continue;

      let folder: string | null = record?.folder ?? sessions[0]?.cwd ?? pane?.cwd ?? null;
      if (!folder) folder = await cc.cwdOfPid(proc.pid);

      let link: string | null = record?.link ?? this.linkCache.get(proc.pid) ?? null;
      if (!link && pane) {
        link = cc.extractLink(await tmux.capturePane(pane.target, 300, pane.socket));
        if (link) this.linkCache.set(proc.pid, link);
      }

      const handoff = proc.kind === 'rc-interactive' && (tmuxSession?.startsWith('cca-') ?? false);
      (handoff ? handoffSessions : servers).push({
        folder: folder ?? '(unknown)',
        slug: folder ? slugOf(folder) : '?',
        name: proc.name ?? record?.name ?? path.basename(folder ?? ''),
        pid: proc.pid,
        state: 'running',
        origin: handoff || record ? 'agent' : 'manual',
        spawn: proc.kind === 'rc-interactive' ? 'interactive' : (proc.spawn ?? record?.spawn ?? 'same-dir'),
        handoff,
        tmuxSession,
        tmuxSocket: pane?.socket ?? null,
        link,
        id: link ? cc.linkId(link) : null,
        startedAt: record?.startedAt ?? null,
        stoppedAt: null,
        resumableUntil: null,
        sessions,
      });
    }

    // Servers we started that are no longer running: resumable for a while.
    const now = Date.now();
    let dirty = false;
    for (const r of Object.values(this.state.servers)) {
      if (servers.some((s) => s.folder === r.folder && s.state === 'running')) continue;
      if (!fs.existsSync(r.folder)) {
        delete this.state.servers[r.folder]; // folder is gone; nothing to resume
        dirty = true;
        continue;
      }
      if (r.stoppedAt === null) {
        r.stoppedAt = now; // it died without us stopping it; start the resume clock now
        dirty = true;
      }
      if (now - r.stoppedAt < RESUME_WINDOW_MS) {
        servers.push({
          folder: r.folder,
          slug: slugOf(r.folder),
          name: r.name,
          pid: null,
          state: 'stopped',
          origin: 'agent',
          spawn: r.spawn,
          handoff: false,
          tmuxSession: null,
          tmuxSocket: null,
          link: r.link,
          id: r.id,
          startedAt: r.startedAt,
          stoppedAt: r.stoppedAt,
          resumableUntil: r.stoppedAt + RESUME_WINDOW_MS,
          sessions: [],
        });
      }
    }
    if (dirty) saveState(this.state);

    const standaloneSessions = registry.filter((s) => !claimed.has(s.pid)).map(toSessionView);
    return { servers, handoffSessions, standaloneSessions, takenAt: now };
  }

  async running(folder: string): Promise<ServerView | null> {
    const f = path.resolve(folder);
    const snap = await this.snapshot();
    return snap.servers.find((s) => s.folder === f && s.state === 'running') ?? null;
  }

  async start(folderIn: string, opts: StartOptions = {}): Promise<ServerView> {
    const folder = path.resolve(folderIn);
    const existing = await this.running(folder);
    if (existing) return existing;
    if (this.starting.has(folder)) throw new Error(`A server for ${folder} is already starting`);
    this.starting.add(folder);

    const prev = this.state.servers[folder];
    const name = ccaName(opts.name ?? prev?.name ?? path.basename(folder));
    const spawn = opts.spawn ?? prev?.spawn ?? this.cfg.defaultSpawn;
    const permissionMode = opts.permissionMode === undefined ? (prev?.permissionMode ?? this.cfg.defaultPermissionMode) : opts.permissionMode;
    const tmuxSession = tmuxNameFor(folder);
    const target = tmux.sessionTarget(tmuxSession);

    try {
      if (await tmux.hasSession(tmuxSession)) await tmux.killSession(tmuxSession); // stale shell, no server in it
      const trust = cc.ensureTrusted(folder);
      if (trust !== 'already') log(trust === 'recorded' ? 'info' : 'warn', `workspace trust ${trust}`, { folder });
      await permissions.applyToProject(folder, this.cfg.allowRules).catch((e) => log('warn', 'could not apply allow rules', e));
      await tmux.newSession(tmuxSession, folder);

      const cmd = ['claude', 'remote-control', '--name', shellQuote(name)];
      if (opts.continue) cmd.push('--continue');
      else cmd.push(`--spawn=${spawn}`);
      if (permissionMode) cmd.push('--permission-mode', permissionMode);
      log('info', `starting server`, { folder, cmd: cmd.join(' ') });
      await tmux.sendLiteral(target, cmd.join(' '));
      await tmux.sendKeys(target, ['Enter']);

      const startedAt = Date.now();
      let trustAnswers = 0;
      let answeredSpawn = false;
      let pane = '';
      while (Date.now() - startedAt < START_TIMEOUT_MS) {
        await sleep(500);
        pane = await tmux.capturePane(target, 300);
        if (/answer arrived too quickly/i.test(pane) && trustAnswers < 3) {
          // Claude Code wants a human-paced answer; wait and answer once more.
          await sleep(3000);
          await tmux.sendKeys(target, ['y', 'Enter']);
          trustAnswers++;
          await sleep(1500);
          continue;
        }
        const link = cc.extractLink(pane);
        if (link) {
          const rec: ServerRecord = {
            folder,
            name,
            spawn: opts.continue ? (prev?.spawn ?? spawn) : spawn,
            permissionMode,
            tmuxSession,
            tmuxSocket: tmux.CCA_SOCKET,
            startedAt,
            stoppedAt: null,
            link,
            id: cc.linkId(link),
            continueOnRestart: opts.continueOnRestart ?? prev?.continueOnRestart ?? false,
          };
          this.state.servers[folder] = rec;
          saveState(this.state);
          log('info', `server up`, { folder, link, seconds: Math.round((Date.now() - startedAt) / 1000) });
          const view = await this.running(folder);
          if (view) return view;
          // Registry may lag a beat; synthesize from the record.
          return {
            folder, slug: slugOf(folder), name, pid: null, state: 'running', origin: 'agent', spawn: rec.spawn, handoff: false,
            tmuxSession, tmuxSocket: tmux.CCA_SOCKET, link, id: rec.id, startedAt, stoppedAt: null, resumableUntil: null, sessions: [],
          };
        }
        if (/Enable Remote Control\? \(y\/n\)/i.test(pane)) {
          throw new Error(
            'Remote Control has not been enabled on this Mac yet. Run `claude remote-control` once in a terminal on it and accept the prompt.',
          );
        }
        if (trustAnswers === 0 && /\[y\/N\]/.test(pane)) {
          // Fallback if the pre-recorded trust was not picked up: answer at a human pace.
          await sleep(2500);
          await tmux.sendKeys(target, ['y', 'Enter']);
          trustAnswers++;
          continue;
        }
        if (!answeredSpawn && /Choose \[1\/2\]/.test(pane)) {
          await tmux.sendKeys(target, ['Enter']);
          answeredSpawn = true;
          continue;
        }
        const err = /^(Error:.*|.*must be logged in.*|.*not trusted.*|.*command not found.*|.*No (?:session|record).*)$/m.exec(pane);
        if (err) throw new Error(err[1]!.trim());
      }
      const tail = pane.split('\n').filter((l) => l.trim()).slice(-6).join('\n');
      throw new Error(`Timed out waiting for the Remote Control link. Last output:\n${tail}`);
    } catch (e) {
      await tmux.killSession(tmuxSession);
      throw e;
    } finally {
      this.starting.delete(folder);
    }
  }

  async stop(folderIn: string): Promise<ServerView | { folder: string; state: 'stopped'; note: string }> {
    const folder = path.resolve(folderIn);
    const s = await this.running(folder);
    if (!s) return { folder, state: 'stopped', note: 'No running server for this folder' };

    const socket = s.tmuxSocket ?? tmux.DEFAULT_SOCKET;
    if (s.tmuxSession) await tmux.sendKeys(tmux.sessionTarget(s.tmuxSession), ['C-c'], socket);
    else if (s.pid) process.kill(s.pid, 'SIGINT');

    const deadline = Date.now() + 15_000;
    while (s.pid && cc.pidAlive(s.pid) && Date.now() < deadline) await sleep(500);
    if (s.pid && cc.pidAlive(s.pid)) {
      process.kill(s.pid, 'SIGTERM');
      await sleep(2000);
    }
    if (s.origin === 'agent' && s.tmuxSession) await tmux.killSession(s.tmuxSession, socket);

    const rec = this.state.servers[folder];
    if (rec) {
      rec.stoppedAt = Date.now();
      saveState(this.state);
    }
    log('info', 'server stopped', { folder });
    return { ...s, pid: null, state: 'stopped', stoppedAt: rec?.stoppedAt ?? Date.now(), resumableUntil: rec ? rec.stoppedAt! + RESUME_WINDOW_MS : null, sessions: [] };
  }

  /**
   * M4 handoff: start one interactive Claude Code session in the folder, with Remote Control on
   * and a first prompt, so work begins before anyone opens it. Runs inside tmux `cca-<slug>-sN`.
   */
  async startSession(folderIn: string, opts: StartSessionOptions): Promise<HandoffSessionView> {
    const folder = path.resolve(folderIn);
    const prompt = opts.prompt?.trim() ?? '';
    if (!prompt && !opts.resume) throw new Error('prompt is required');
    const base = tmuxNameFor(folder);
    let n = 1;
    while (await tmux.hasSession(`${base}-s${n}`)) n++;
    const tmuxSession = `${base}-s${n}`;
    const target = tmux.sessionTarget(tmuxSession);
    const name = ccaName(opts.name?.trim() || `${path.basename(folder)}: ${prompt ? summarize(prompt) : 'resumed'}`);
    const permissionMode = opts.permissionMode === undefined ? this.cfg.handoffPermissionMode : opts.permissionMode;

    const trust = cc.ensureTrusted(folder);
    if (trust !== 'already') log(trust === 'recorded' ? 'info' : 'warn', `workspace trust ${trust}`, { folder });
    await permissions.applyToProject(folder, this.cfg.allowRules).catch((e) => log('warn', 'could not apply allow rules', e));

    await tmux.newSession(tmuxSession, folder);
    const cmd = ['claude'];
    if (opts.resume) cmd.push('--resume', shellQuote(opts.resume));
    cmd.push('--remote-control', shellQuote(name));
    if (permissionMode) cmd.push('--permission-mode', permissionMode);
    if (prompt) {
      // The prompt goes through a file so quotes and newlines never touch the shell.
      const promptDir = path.join(APP_DIR, 'prompts');
      fs.mkdirSync(promptDir, { recursive: true });
      const promptFile = path.join(promptDir, `${tmuxSession}.txt`);
      fs.writeFileSync(promptFile, prompt);
      cmd.push(`"$(cat ${shellQuote(promptFile)})"`);
    }
    log('info', 'starting handoff session', { folder, tmuxSession, name, permissionMode });
    await tmux.sendLiteral(target, cmd.join(' '));
    await tmux.sendKeys(target, ['Enter']);

    const startedAt = Date.now();
    try {
      while (Date.now() - startedAt < START_TIMEOUT_MS) {
        await sleep(1000);
        const reg = cc.readSessionRegistry().find((r) => r.tmux?.startsWith(tmuxSession + ':') && r.cwd === folder);
        if (reg?.bridgeSessionId) {
          log('info', 'handoff session up', { tmuxSession, link: cc.sessionLink(reg.bridgeSessionId), seconds: Math.round((Date.now() - startedAt) / 1000) });
          return {
            folder, slug: slugOf(folder), name, tmuxSession, tmuxSocket: tmux.CCA_SOCKET, pid: reg.pid, sessionId: reg.sessionId,
            link: cc.sessionLink(reg.bridgeSessionId), permissionMode, startedAt,
          };
        }
        const pane = await tmux.capturePane(target, 100);
        if (/Enable Remote Control\? \(y\/n\)/i.test(pane)) {
          throw new Error('Remote Control has not been enabled on this Mac yet. Run `claude remote-control` once in a terminal on it and accept the prompt.');
        }
        const err = /^(Error:.*|.*must be logged in.*|.*command not found.*)$/m.exec(pane);
        if (err) throw new Error(err[1]!.trim());
      }
      const pane = await tmux.capturePane(target, 100);
      throw new Error(`Timed out waiting for the session to connect to Remote Control. Last output:\n${pane.split('\n').filter((l) => l.trim()).slice(-6).join('\n')}`);
    } catch (e) {
      await tmux.killSession(tmuxSession);
      throw e;
    }
  }

  /**
   * Stop a session: a handoff session (by tmux session or display name), a session hosted by a
   * server, or a standalone interactive session someone started in a terminal. Matched by
   * registry session name, session id, or pid. Standalone sessions get the same two Ctrl-C
   * (SIGINT) sequence a person would use, so Claude Code saves the conversation for `--resume`.
   */
  async stopSession(id: string): Promise<{ stopped: boolean; name: string | null; note: string }> {
    const snap = await this.snapshot();
    const match = (x: SessionView) => x.name === id || x.sessionId === id || String(x.pid) === id;

    const handoff = snap.handoffSessions.find((v) => v.tmuxSession === id || v.name === id || v.sessions.some(match));
    if (handoff?.tmuxSession) {
      const target = tmux.sessionTarget(handoff.tmuxSession);
      const socket = handoff.tmuxSocket ?? tmux.DEFAULT_SOCKET;
      await tmux.sendKeys(target, ['C-c'], socket);
      await sleep(800);
      await tmux.sendKeys(target, ['C-c'], socket); // Claude Code exits on a second Ctrl-C
      await this.waitExit(handoff.pid);
      await tmux.killSession(handoff.tmuxSession, socket);
      log('info', 'handoff session stopped', { tmuxSession: handoff.tmuxSession });
      return { stopped: true, name: handoff.name, note: 'Stopped. The conversation can be resumed with `claude --resume` in that folder.' };
    }

    const hosted = snap.servers.flatMap((v) => v.sessions.map((x) => ({ server: v, session: x }))).find((p) => match(p.session));
    if (hosted) {
      process.kill(hosted.session.pid, 'SIGTERM');
      await this.waitExit(hosted.session.pid);
      log('info', 'hosted session stopped', { name: hosted.session.name, server: hosted.server.name });
      return { stopped: true, name: hosted.session.name, note: `Stopped. Its server "${hosted.server.name}" keeps running; the conversation is still in the claude.ai session list and can be reopened there.` };
    }

    const standalone = snap.standaloneSessions.find(match);
    if (standalone) {
      process.kill(standalone.pid, 'SIGINT');
      await sleep(800);
      if (cc.pidAlive(standalone.pid)) process.kill(standalone.pid, 'SIGINT');
      await this.waitExit(standalone.pid);
      log('info', 'standalone session stopped', { name: standalone.name, pid: standalone.pid });
      return { stopped: true, name: standalone.name, note: 'Stopped (it was started by hand in a terminal, so that terminal now shows a prompt). Resume with `claude --resume` in its folder.' };
    }
    return { stopped: false, name: null, note: `No session matches "${id}". Use the session name, session id, or pid from list_sessions.` };
  }

  /**
   * Move a session onto CCA's tmux server (GUI session, keychain access) keeping its conversation:
   * stop it, then `claude --resume <id>` in the same folder with Remote Control on. Running shell
   * commands in the old session are lost; the transcript and the claude.ai session are not.
   */
  async moveSession(id: string): Promise<HandoffSessionView> {
    const snap = await this.snapshot();
    const match = (x: SessionView) => x.name === id || x.sessionId === id || String(x.pid) === id;
    const handoff = snap.handoffSessions.find((v) => v.tmuxSession === id || v.name === id || v.sessions.some(match));
    const hosted = handoff ? undefined : snap.servers.flatMap((v) => v.sessions).find(match);
    const standalone = handoff || hosted ? undefined : snap.standaloneSessions.find(match);
    const session = handoff?.sessions[0] ?? hosted ?? standalone;
    if (!session) throw new Error(`No session matches "${id}"`);
    if (handoff && handoff.tmuxSocket === tmux.CCA_SOCKET) throw new Error(`${handoff.name} is already on the CCA tmux server`);
    const folder = session.cwd;
    const name = handoff?.name ?? session.name;
    const permissionMode = handoff ? (this.cfg.handoffPermissionMode ?? null) : null;
    await this.stopSession(session.sessionId);
    return this.startSession(folder, { resume: session.sessionId, name, permissionMode });
  }

  private async waitExit(pid: number | null): Promise<void> {
    if (!pid) return;
    const deadline = Date.now() + 15_000;
    while (cc.pidAlive(pid) && Date.now() < deadline) await sleep(500);
    if (cc.pidAlive(pid)) {
      process.kill(pid, 'SIGTERM');
      await sleep(2000);
    }
  }
}

/** First few words of a prompt, for a session title. */
function summarize(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= 48) return oneLine;
  const cut = oneLine.slice(0, 48);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 30)) + '…';
}
