import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR } from './config.ts';

/** Claude Code keeps a stopped server's sessions resumable for about four hours. */
export const RESUME_WINDOW_MS = 4 * 60 * 60 * 1000;

export interface ServerRecord {
  folder: string;
  name: string;
  spawn: string;
  permissionMode: string | null;
  tmuxSession: string;
  /** tmux server socket name: `cca` (agent's own server) or `default` (records from before it existed). */
  tmuxSocket: string;
  startedAt: number;
  stoppedAt: number | null;
  link: string | null;
  id: string | null;
  /** Restart with `--continue` so the same conversation comes back (used by the Orchestrator). */
  continueOnRestart: boolean;
}

export interface State {
  servers: Record<string, ServerRecord>;
  /** Hash of the Orchestrator files the running Orchestrator session was started with. */
  orchestratorHash: string | null;
}

const STATE_PATH = path.join(APP_DIR, 'state.json');

export function loadState(): State {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) as Partial<State>;
    const servers = raw.servers ?? {};
    for (const r of Object.values(servers)) r.tmuxSocket ??= 'default';
    return { servers, orchestratorHash: raw.orchestratorHash ?? null };
  } catch {
    return { servers: {}, orchestratorHash: null };
  }
}

export function saveState(s: State): void {
  fs.mkdirSync(APP_DIR, { recursive: true });
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n');
  fs.renameSync(tmp, STATE_PATH);
}
