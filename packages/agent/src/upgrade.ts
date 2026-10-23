/**
 * Self-upgrade: pull the repo this agent runs from, refresh dependencies, restart the agent.
 * The Orchestrator reloads itself afterwards whenever its generated files changed.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, AGENT_VERSION } from './config.ts';
import { run, runOk } from './exec.ts';
import { log } from './log.ts';

export interface VersionInfo {
  agentVersion: string;
  commit: string | null;
  commitDate: string | null;
  branch: string | null;
  dirty: boolean;
  behind: number | null;
  latestCommit: string | null;
  repo: string;
}

let versionCache: { at: number; info: VersionInfo } | null = null;

export async function versionInfo(force = false): Promise<VersionInfo> {
  if (!force && versionCache && Date.now() - versionCache.at < 5 * 60_000) return versionCache.info;
  const g = (args: string[]) => run('git', ['-C', REPO_ROOT, ...args], { timeoutMs: 60_000 });
  const [commit, date, branch, status] = await Promise.all([
    g(['rev-parse', '--short=10', 'HEAD']),
    g(['log', '-1', '--format=%cs']),
    g(['symbolic-ref', '--short', 'HEAD']),
    g(['status', '--porcelain']),
  ]);
  let behind: number | null = null;
  let latest: string | null = null;
  const fetched = await g(['fetch', '-q', 'origin']);
  if (fetched.code === 0) {
    const b = await g(['rev-list', '--count', 'HEAD..@{upstream}']);
    if (b.code === 0) behind = Number(b.stdout.trim());
    const l = await g(['rev-parse', '--short=10', '@{upstream}']);
    if (l.code === 0) latest = l.stdout.trim();
  }
  const info: VersionInfo = {
    agentVersion: AGENT_VERSION,
    commit: commit.code === 0 ? commit.stdout.trim() : null,
    commitDate: date.code === 0 ? date.stdout.trim() : null,
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    dirty: status.code === 0 && status.stdout.trim().length > 0,
    behind,
    latestCommit: latest,
    repo: REPO_ROOT,
  };
  versionCache = { at: Date.now(), info };
  return info;
}

export interface UpgradeResult {
  from: string | null;
  to: string | null;
  pulled: boolean;
  dependenciesInstalled: boolean;
  restarting: boolean;
  note: string;
}

export async function upgrade(opts: { restart?: boolean } = {}): Promise<UpgradeResult> {
  const before = await versionInfo(true);
  if (before.dirty) {
    return { from: before.commit, to: before.commit, pulled: false, dependenciesInstalled: false, restarting: false, note: `The checkout at ${REPO_ROOT} has local changes, so it was not pulled. Commit or stash them on the Mac, then upgrade again.` };
  }
  if (before.behind === 0) {
    return { from: before.commit, to: before.commit, pulled: false, dependenciesInstalled: false, restarting: false, note: `Already current at ${before.commit}.` };
  }
  const lockBefore = fs.statSync(path.join(REPO_ROOT, 'package-lock.json')).mtimeMs;
  await runOk('git', ['-C', REPO_ROOT, 'pull', '--ff-only', '-q'], { timeoutMs: 120_000 });
  const after = await versionInfo(true);
  let deps = false;
  if (fs.statSync(path.join(REPO_ROOT, 'package-lock.json')).mtimeMs !== lockBefore || !fs.existsSync(path.join(REPO_ROOT, 'node_modules'))) {
    await runOk('npm', ['install', '--omit=dev', '--no-fund', '--no-audit'], { cwd: REPO_ROOT, timeoutMs: 5 * 60_000 });
    deps = true;
  }
  const restart = opts.restart !== false;
  if (restart) scheduleRestart();
  log('info', 'upgraded', { from: before.commit, to: after.commit, deps, restart });
  return {
    from: before.commit, to: after.commit, pulled: true, dependenciesInstalled: deps, restarting: restart,
    note: restart
      ? `Updated ${before.commit} → ${after.commit}. The agent restarts in a moment; the Orchestrator reloads itself if its instructions or tools changed (its conversation is kept). Running servers and sessions are untouched.`
      : `Updated ${before.commit} → ${after.commit}. Restart the agent to run it: launchctl kickstart -k gui/$(id -u)/com.claudecodeanywhere.agent`,
  };
}

/** Restart this launchd job after the current HTTP response has gone out. */
function scheduleRestart(): void {
  const label = 'com.claudecodeanywhere.agent';
  const uid = process.getuid?.() ?? 501;
  const child = spawn('/bin/sh', ['-c', `sleep 2; /bin/launchctl kickstart -k gui/${uid}/${label}`], { detached: true, stdio: 'ignore' });
  child.unref();
}
