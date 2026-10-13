import { run, runOk } from './exec.ts';

export interface Pane {
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

export async function listPanes(): Promise<Pane[]> {
  const r = await run('tmux', [
    'list-panes',
    '-a',
    '-F',
    // A printable separator: under launchd (no UTF-8 locale) tmux rewrites control characters like tabs.
    `#{session_name}${SEP}#{window_id}${SEP}#{pane_id}${SEP}#{pane_pid}${SEP}#{pane_current_path}`,
  ]);
  lastListPanes.code = r.code;
  lastListPanes.stderr = r.stderr.trim().slice(0, 300);
  lastListPanes.at = Date.now();
  lastListPanes.panes = r.code === 0 ? r.stdout.split('\n').filter(Boolean).length : 0;
  if (r.code !== 0) return []; // no tmux server running
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [session = '', windowId = '', paneId = '', pid = '0', cwd = ''] = line.split(SEP);
      return { session, windowId, paneId, panePid: Number(pid), cwd, target: `${session}:${windowId}.${paneId}` };
    });
}

export async function hasSession(name: string): Promise<boolean> {
  return (await run('tmux', ['has-session', '-t', exact(name)])).code === 0;
}

export async function newSession(name: string, cwd: string): Promise<void> {
  await runOk('tmux', ['new-session', '-d', '-s', name, '-c', cwd, '-x', '220', '-y', '50']);
}

export async function sendKeys(target: string, keys: string[]): Promise<void> {
  await runOk('tmux', ['send-keys', '-t', target, ...keys]);
}

/** Type text exactly as given (no key-name interpretation), without pressing Enter. */
export async function sendLiteral(target: string, text: string): Promise<void> {
  await runOk('tmux', ['send-keys', '-t', target, '-l', text]);
}

export async function capturePane(target: string, lines = 200): Promise<string> {
  const r = await run('tmux', ['capture-pane', '-p', '-J', '-t', target, '-S', `-${lines}`]);
  return r.code === 0 ? r.stdout : '';
}

export async function killSession(name: string): Promise<void> {
  await run('tmux', ['kill-session', '-t', exact(name)]);
}

/**
 * Pane-command target for a session: `=name:` means "exactly this session, its current window,
 * its active pane". Plain `=name` is only valid for session commands like has-session.
 */
export const sessionTarget = (name: string): string => `=${name}:`;
