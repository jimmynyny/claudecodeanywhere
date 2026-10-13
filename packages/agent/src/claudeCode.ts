/**
 * Adapter for everything we know about Claude Code's on-disk and process state.
 * Several of these are undocumented internals (verified on 2.1.289); keep them all here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './exec.ts';

export const CLAUDE_DIR = path.join(os.homedir(), '.claude');

export interface RegistrySession {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string;
  status: string;
  waitingFor: string | null;
  bridgeSessionId: string | null;
  startedAt: number;
  tmux: string | null;
  kind: string;
  entrypoint: string;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Every live session writes ~/.claude/sessions/<pid>.json; dead pids are stale files. */
export function readSessionRegistry(): RegistrySession[] {
  const dir = path.join(CLAUDE_DIR, 'sessions');
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: RegistrySession[] = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<string, unknown>;
      const pid = Number(j.pid);
      if (!Number.isInteger(pid) || !pidAlive(pid)) continue;
      out.push({
        pid,
        sessionId: String(j.sessionId ?? ''),
        cwd: String(j.cwd ?? ''),
        name: String(j.name ?? ''),
        status: String(j.status ?? 'unknown'),
        waitingFor: typeof j.waitingFor === 'string' ? j.waitingFor : null,
        bridgeSessionId: typeof j.bridgeSessionId === 'string' ? j.bridgeSessionId : null,
        startedAt: Number(j.startedAt ?? 0),
        tmux: typeof j.tmux === 'string' ? j.tmux : null,
        kind: String(j.kind ?? ''),
        entrypoint: String(j.entrypoint ?? ''),
      });
    } catch {
      // unreadable or half-written file; skip
    }
  }
  return out;
}

export type ProcKind = 'server' | 'rc-child' | 'rc-interactive' | 'other';

export interface ClaudeProc {
  pid: number;
  ppid: number;
  argv: string[];
  kind: ProcKind;
  name: string | null;
  spawn: string | null;
}

export interface ProcTable {
  all: Map<number, { pid: number; ppid: number; command: string }>;
  claude: ClaudeProc[];
}

export async function listProcesses(): Promise<ProcTable> {
  const r = await run('ps', ['-axo', 'pid=,ppid=,command=']);
  const all: ProcTable['all'] = new Map();
  const claude: ClaudeProc[] = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const command = m[3] ?? '';
    all.set(pid, { pid, ppid, command });
    const argv = command.split(/\s+/);
    const exe = argv[0] ?? '';
    if (!(exe === 'claude' || exe.endsWith('/claude'))) continue;
    claude.push({ pid, ppid, argv, kind: classify(argv), name: parseName(argv), spawn: parseSpawn(argv) });
  }
  return { all, claude };
}

function classify(argv: string[]): ProcKind {
  if (argv[1] === 'remote-control') return 'server';
  if (argv.includes('--sdk-url')) return 'rc-child';
  if (argv.some((a) => a === '--rc' || a === '--remote-control')) return 'rc-interactive';
  return 'other';
}

/** `--name My Project` shows up in ps as separate tokens; gather until the next flag. */
function parseName(argv: string[]): string | null {
  for (const flag of ['--name', '-n', '--rc', '--remote-control']) {
    const i = argv.indexOf(flag);
    if (i < 0) continue;
    const parts: string[] = [];
    for (let j = i + 1; j < argv.length && !argv[j]!.startsWith('-'); j++) parts.push(argv[j]!);
    if (parts.length) return parts.join(' ');
  }
  return null;
}

function parseSpawn(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--spawn=')) return a.slice('--spawn='.length);
    if (a === '--spawn') return argv[i + 1] ?? null;
  }
  return null;
}

export function ancestors(table: ProcTable, pid: number, depth = 8): number[] {
  const out: number[] = [];
  let cur = table.all.get(pid)?.ppid;
  while (cur && cur > 1 && out.length < depth) {
    out.push(cur);
    cur = table.all.get(cur)?.ppid;
  }
  return out;
}

export async function cwdOfPid(pid: number): Promise<string | null> {
  const r = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeoutMs: 10_000 });
  const m = /^n(.+)$/m.exec(r.stdout);
  return m ? m[1]! : null;
}

/** Folder servers print `?environment=env_…`; single-session servers print `/session_…`. */
export const LINK_RE = /https:\/\/claude\.ai\/code(?:\?environment=env_[A-Za-z0-9]+|\/session_[A-Za-z0-9]+)/;

export function extractLink(text: string): string | null {
  const m = LINK_RE.exec(text);
  return m ? m[0] : null;
}

export function linkId(link: string): string | null {
  const m = /(?:env|session)_[A-Za-z0-9]+/.exec(link);
  return m ? m[0] : null;
}

export function sessionLink(bridgeSessionId: string): string {
  return `https://claude.ai/code/${bridgeSessionId}`;
}

export interface AuthStatus {
  loggedIn: boolean;
  email: string | null;
  subscription: string | null;
  raw: string;
}

export async function authStatus(): Promise<AuthStatus> {
  const r = await run('claude', ['auth', 'status', '--json'], { timeoutMs: 20_000 });
  try {
    const j = JSON.parse(r.stdout) as Record<string, unknown>;
    return {
      loggedIn: j.loggedIn === true,
      email: typeof j.email === 'string' ? j.email : null,
      subscription: typeof j.subscriptionType === 'string' ? j.subscriptionType : null,
      raw: '',
    };
  } catch {
    return { loggedIn: false, email: null, subscription: null, raw: (r.stdout + r.stderr).trim().slice(0, 500) };
  }
}

/**
 * Record workspace trust for a folder ahead of time, exactly as answering the trust prompt does.
 * This is the documented route for Remote Control in non-interactive use: the server cannot
 * accept a scripted answer, so trust has to exist before it starts. Only called for folders the
 * user explicitly asked the agent to serve.
 */
export function ensureTrusted(folder: string): 'already' | 'recorded' | 'failed' {
  const file = path.join(os.homedir(), '.claude.json');
  try {
    const text = fs.readFileSync(file, 'utf8');
    const cfg = JSON.parse(text) as { projects?: Record<string, Record<string, unknown>> };
    cfg.projects ??= {};
    const entry = (cfg.projects[folder] ??= {});
    if (entry.hasTrustDialogAccepted === true) return 'already';
    entry.hasTrustDialogAccepted = true;
    fs.copyFileSync(file, file + '.cca-backup');
    const tmp = file + '.cca-tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, file);
    return 'recorded';
  } catch {
    return 'failed';
  }
}

export async function claudeVersion(): Promise<string | null> {
  const r = await run('claude', ['--version']);
  return r.code === 0 ? r.stdout.trim() : null;
}
