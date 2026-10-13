import fs from 'node:fs';
import { AGENT_VERSION, type Config } from './config.ts';
import { run } from './exec.ts';
import * as cc from './claudeCode.ts';
import type { Supervisor } from './supervisor.ts';
import { lastListPanes } from './tmux.ts';

export interface Health {
  machine: string;
  agentVersion: string;
  agentUptimeSec: number;
  claudeVersion: string | null;
  login: cc.AuthStatus;
  ghOk: boolean;
  tmuxOk: boolean;
  tmuxPanes: typeof lastListPanes;
  rootDir: string;
  rootExists: boolean;
  sleepMinutesOnAC: number | null;
  warnings: string[];
  supervisorProblems: ReturnType<Supervisor['problems']>;
}

export async function health(cfg: Config, supervisor: Supervisor): Promise<Health> {
  const [version, login, gh, tmuxV, pm] = await Promise.all([
    cc.claudeVersion(),
    cc.authStatus(),
    run('gh', ['auth', 'status']),
    run('tmux', ['-V']),
    run('pmset', ['-g', 'custom']),
  ]);

  let sleepMinutesOnAC: number | null = null;
  const ac = pm.stdout.split('AC Power:')[1];
  if (ac) {
    const m = /^\s*sleep\s+(\d+)/m.exec(ac);
    if (m) sleepMinutesOnAC = Number(m[1]);
  }
  const rootExists = fs.existsSync(cfg.rootDir);

  const warnings: string[] = [];
  if (!login.loggedIn) warnings.push('Claude Code is not logged in on this Mac. Someone must run `claude auth login` in a terminal there; Remote Control cannot start until then.');
  if (gh.code !== 0) warnings.push('gh is not authenticated on this Mac, so creating GitHub repos will fail. Run `gh auth login` there.');
  if (tmuxV.code !== 0) warnings.push('tmux is not installed; the agent cannot start servers.');
  if (!rootExists) warnings.push(`Root folder ${cfg.rootDir} does not exist.`);
  if (sleepMinutesOnAC !== null && sleepMinutesOnAC > 0) warnings.push(`This Mac is set to sleep after ${sleepMinutesOnAC} minutes on AC power; sessions will go offline when it does.`);
  for (const p of supervisor.problems()) warnings.push(`${p.key} failed to start ${p.failures}x: ${p.lastError}`);

  return {
    machine: cfg.machineName,
    agentVersion: AGENT_VERSION,
    agentUptimeSec: Math.round(process.uptime()),
    claudeVersion: version,
    login,
    ghOk: gh.code === 0,
    tmuxOk: tmuxV.code === 0,
    tmuxPanes: { ...lastListPanes },
    rootDir: cfg.rootDir,
    rootExists,
    sleepMinutesOnAC,
    warnings,
    supervisorProblems: supervisor.problems(),
  };
}
