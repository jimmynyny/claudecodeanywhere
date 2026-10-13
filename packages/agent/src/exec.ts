import { execFile } from 'node:child_process';

/** launchd gives us almost no PATH, so always use a known-good one. */
export const PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', ...process.env, PATH, ...(opts.env ?? {}) },
      },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) {
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (e.killed) code = 124;
          else if (typeof e.code === 'number') code = e.code;
          else code = 127;
        }
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

export async function runOk(cmd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    const detail = (r.stderr || r.stdout).trim().split('\n').slice(-5).join('\n');
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${r.code}): ${detail}`);
  }
  return r.stdout;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
