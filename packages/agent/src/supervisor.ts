import path from 'node:path';
import type { Config } from './config.ts';
import type { ServerManager } from './servers.ts';
import type { Projects } from './projects.ts';
import * as orchestrator from './orchestrator.ts';
import * as cc from './claudeCode.ts';
import { log } from './log.ts';

const TICK_MS = 15_000;
const LOGIN_CHECK_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;

interface Backoff {
  failures: number;
  nextAt: number;
  lastError: string;
}

/** Keeps the Orchestrator and pinned project servers alive. */
export class Supervisor {
  private cfg: Config;
  private servers: ServerManager;
  private projects: Projects;
  private backoff = new Map<string, Backoff>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  loginOk: boolean | null = null;
  lastLoginCheck = 0;

  constructor(cfg: Config, servers: ServerManager, projects: Projects) {
    this.cfg = cfg;
    this.servers = servers;
    this.projects = projects;
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  problems(): Array<{ key: string; failures: number; nextAt: number; lastError: string }> {
    return [...this.backoff.entries()].map(([key, b]) => ({ key, ...b }));
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (Date.now() - this.lastLoginCheck > LOGIN_CHECK_MS) {
        const auth = await cc.authStatus();
        if (this.loginOk !== auth.loggedIn) log(auth.loggedIn ? 'info' : 'error', `Claude Code login: ${auth.loggedIn ? 'ok' : 'NOT logged in'}`, auth.email ?? auth.raw);
        this.loginOk = auth.loggedIn;
        this.lastLoginCheck = Date.now();
      }
      if (!this.loginOk) return; // nothing we start will work until someone logs in on this Mac

      if (this.cfg.orchestrator.enabled) {
        await this.ensure('orchestrator', orchestrator.ORCH_DIR, () => orchestrator.ensureRunning(this.cfg, this.servers), true);
      }
      for (const name of this.cfg.pinned) {
        let folder: string;
        try {
          folder = this.projects.resolve(name);
        } catch (e) {
          log('warn', `pinned project "${name}" not found`, e);
          continue;
        }
        await this.ensure(`pinned:${name}`, folder, () => this.servers.start(folder, { name: path.basename(folder) }));
      }
    } catch (e) {
      log('error', 'supervisor tick failed', e);
    } finally {
      this.ticking = false;
    }
  }

  private async ensure(key: string, folder: string, startFn: () => Promise<unknown>, always = false): Promise<void> {
    const b = this.backoff.get(key);
    if (b && Date.now() < b.nextAt) return;
    const cur = await this.servers.running(folder);
    if (cur && cur.origin === 'agent' && cur.tmuxSocket && cur.tmuxSocket !== 'cca' && !always) {
      log('info', `${key}: moving to the CCA tmux server (GUI session, keychain access)`);
      await this.servers.stop(folder);
    } else if (!always && cur) {
      this.backoff.delete(key);
      return;
    }
    try {
      const before = await this.servers.running(folder);
      await startFn();
      this.backoff.delete(key);
      if (!before || !(await this.servers.running(folder)) || (await this.servers.running(folder))?.pid !== before.pid) log('info', `${key}: server started`);
    } catch (e) {
      const failures = (b?.failures ?? 0) + 1;
      const wait = Math.min(30_000 * 2 ** (failures - 1), MAX_BACKOFF_MS);
      const lastError = e instanceof Error ? e.message : String(e);
      this.backoff.set(key, { failures, nextAt: Date.now() + wait, lastError });
      log('error', `${key}: start failed (${failures}x), retry in ${Math.round(wait / 1000)}s`, lastError);
    }
  }
}
