import { run, runOk } from './exec.ts';

/**
 * CCA runs its own tmux server on this socket, started by the agent from the GUI login session.
 * A tmux server born in an SSH session keeps that security session forever, and every pane it
 * spawns inherits it: no login keychain, so Xcode signing fails with "User interaction is not
 * allowed". The agent's own server inherits the GUI session instead. Attach with
 * `tmux -L cca attach -t <session>`.
 */
export const CCA_SOCKET = 'cca';
export const DEFAULT_SOCKET = 'default';

function withSocket(socket: string, rest: string[]): string[] {
  return socket === DEFAULT_SOCKET ? rest : ['-L', socket, ...rest];
}

export interface Pane {
  socket: string;
  session: string;
  windowId: string;
  paneId: string;
  panePid: number;
  cwd: string;
  /** Target in the same `session:@win.%pane` form Claude Code writes to its registry. */
  target: string;
}

/** `=name` makes tmux match the session name exactly instead of by prefix. */
const exact = (name: string): string => `=${name}`;

const SEP = '|||';

/** Last outcome of list-panes, surfaced by /api/status for diagnostics. */
export const lastListPanes = { code: 0, stderr: '', panes: 0, at: 0 };

/** Panes on CCA's own server and on the default server (where hand-started servers live). */
export async function listPanes(): Promise<Pane[]> {
  const out: Pane[] = [];
  for (const socket of [CCA_SOCKET, DEFAULT_SOCKET]) {
    const r = await run('tmux', withSocket(socket, [
      'list-panes',
      '-a',
      '-F',
      // A printable separator: under launchd (no UTF-8 locale) tmux rewrites control characters like tabs.
      `#{session_name}${SEP}#{window_id}${SEP}#{pane_id}${SEP}#{pane_pid}${SEP}#{pane_current_path}`,
    ]));
    if (socket === CCA_SOCKET) {
      lastListPanes.code = r.code;
      lastListPanes.stderr = r.stderr.trim().slice(0, 300);
      lastListPanes.at = Date.now();
      lastListPanes.panes = r.code === 0 ? r.stdout.split('\n').filter(Boolean).length : 0;
    }
    if (r.code !== 0) continue; // that server is not running
    for (const line of r.stdout.split('\n').filter(Boolean)) {
      const [session = '', windowId = '', paneId = '', pid = '0', cwd = ''] = line.split(SEP);
      out.push({ socket, session, windowId, paneId, panePid: Number(pid), cwd, target: `${session}:${windowId}.${paneId}` });
    }
  }
  return out;
}

export async function hasSession(name: string, socket = CCA_SOCKET): Promise<boolean> {
  return (await run('tmux', withSocket(socket, ['has-session', '-t', exact(name)]))).code === 0;
}

export async function newSession(name: string, cwd: string, socket = CCA_SOCKET): Promise<void> {
  await runOk('tmux', withSocket(socket, ['new-session', '-d', '-s', name, '-c', cwd, '-x', '220', '-y', '50']));
}

export async function sendKeys(target: string, keys: string[], socket = CCA_SOCKET): Promise<void> {
  await runOk('tmux', withSocket(socket, ['send-keys', '-t', target, ...keys]));
}

/** Type text exactly as given (no key-name interpretation), without pressing Enter. */
export async function sendLiteral(target: string, text: string, socket = CCA_SOCKET): Promise<void> {
  await runOk('tmux', withSocket(socket, ['send-keys', '-t', target, '-l', text]));
}

export async function capturePane(target: string, lines = 200, socket = CCA_SOCKET): Promise<string> {
  const r = await run('tmux', withSocket(socket, ['capture-pane', '-p', '-J', '-t', target, '-S', `-${lines}`]));
  return r.code === 0 ? r.stdout : '';
}

export async function killSession(name: string, socket = CCA_SOCKET): Promise<void> {
  await run('tmux', withSocket(socket, ['kill-session', '-t', exact(name)]));
}

/**
 * Pane-command target for a session: `=name:` means "exactly this session, its current window,
 * its active pane". Plain `=name` is only valid for session commands like has-session.
 */
export const sessionTarget = (name: string): string => `=${name}:`;

/** Start CCA's tmux server from this process (the agent, in the GUI session) if it is not running. */
export async function ensureServer(): Promise<'running' | 'started'> {
  const probe = await run('tmux', withSocket(CCA_SOCKET, ['list-sessions']));
  if (probe.code === 0 || /no server running|no sessions/i.test(probe.stderr)) {
    if (probe.code === 0) return 'running';
  }
  await runOk('tmux', withSocket(CCA_SOCKET, ['start-server']));
  return 'started';
}

/** Does a pane spawned by CCA's tmux server have the login keychain? (It inherits the server's session.) */
export async function probeKeychain(): Promise<{ ok: boolean; output: string }> {
  const name = 'cca-keychain-probe';
  const out = `/tmp/cca-keychain-probe-${process.pid}.txt`;
  await run('tmux', withSocket(CCA_SOCKET, ['kill-session', '-t', exact(name)]));
  const cmd = `security show-keychain-info "$HOME/Library/Keychains/login.keychain-db" >${out} 2>&1; echo EXIT:$? >>${out}`;
  const r = await run('tmux', withSocket(CCA_SOCKET, ['new-session', '-d', '-s', name, cmd]));
  if (r.code !== 0) return { ok: false, output: r.stderr.trim() };
  const fs = await import('node:fs');
  for (let i = 0; i < 20; i++) {
    await new Promise((res) => setTimeout(res, 250));
    try {
      const text = fs.readFileSync(out, 'utf8');
      if (/EXIT:\d+/.test(text)) {
        fs.unlinkSync(out);
        return { ok: /EXIT:0/.test(text), output: text.replace(/EXIT:\d+\n?/, '').trim() };
      }
    } catch {
      // not written yet
    }
  }
  return { ok: false, output: 'probe timed out' };
}

export async function sessionCount(socket = CCA_SOCKET): Promise<number> {
  const r = await run('tmux', withSocket(socket, ['list-sessions', '-F', '#{session_name}']));
  return r.code === 0 ? r.stdout.split('\n').filter(Boolean).length : 0;
}

export async function killServer(socket = CCA_SOCKET): Promise<void> {
  await run('tmux', withSocket(socket, ['kill-server']));
}
