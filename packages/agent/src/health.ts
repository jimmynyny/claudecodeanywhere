import fs from 'node:fs';
import { AGENT_VERSION, type Config } from './config.ts';
import { run } from './exec.ts';
import * as cc from './claudeCode.ts';
import type { Supervisor } from './supervisor.ts';
import { lastListPanes } from './tmux.ts';
import * as tmux from './tmux.ts';

/** The keychain probe spawns a tmux pane, so cache it. */
let keychainProbe: { at: number; ok: boolean; output: string } | null = null;
const PROBE_TTL_MS = 5 * 60_000;

export async function tmuxKeychain(force = false): Promise<{ ok: boolean; output: string; checkedAt: number }> {
  if (!force && keychainProbe && Date.now() - keychainProbe.at < PROBE_TTL_MS) return { ...keychainProbe, checkedAt: keychainProbe.at };
  const r = await tmux.probeKeychain();
  keychainProbe = { at: Date.now(), ...r };
  if (!r.ok && (await tmux.sessionCount()) === 0) {
    // Nothing is on the CCA server, so replace it with one started by this process (GUI session).
    await tmux.killServer();
    await tmux.ensureServer();
    const again = await tmux.probeKeychain();
    keychainProbe = { at: Date.now(), ...again };
  }
  return { ...keychainProbe, checkedAt: keychainProbe.at };
}

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
  /** Whether the agent's own process can use the login keychain. */
  keychainOk: boolean;
  /** Whether a pane spawned by CCA's tmux server can use it: this is what sessions actually get. */
  tmuxKeychainOk: boolean;
  tmuxKeychainDetail: string;
  codesigningIdentities: number | null;
  warnings: string[];
  supervisorProblems: ReturnType<Supervisor['problems']>;
}

export async function health(cfg: Config, supervisor: Supervisor): Promise<Health> {
  const [version, login, gh, tmuxV, pm, kc, ids] = await Promise.all([
    cc.claudeVersion(),
    cc.authStatus(),
    run('gh', ['auth', 'status']),
    run('tmux', ['-V']),
    run('pmset', ['-g', 'custom']),
    run('security', ['show-keychain-info', `${process.env.HOME}/Library/Keychains/login.keychain-db`]),
    run('security', ['find-identity', '-v', '-p', 'codesigning']),
  ]);
  const keychainOk = kc.code === 0;
  const tk = await tmuxKeychain();
  const idm = /(\d+) valid identities found/.exec(ids.stdout);
  const codesigningIdentities = idm ? Number(idm[1]) : null;

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
  if (!keychainOk) warnings.push('The login keychain is not reachable from the agent, so Xcode signing would fail in sessions. The agent must run from the GUI login session (install.sh does this); reinstall it with scripts/install-agent.sh.');
  else if (!tk.ok) warnings.push(`Sessions on the CCA tmux server cannot use the login keychain (${tk.output || 'no detail'}). The server was probably started by hand from SSH. Stop its sessions, run \`tmux -L cca kill-server\`, and the agent will recreate it in the GUI session.`);
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
    keychainOk,
    tmuxKeychainOk: tk.ok,
    tmuxKeychainDetail: tk.output,
    codesigningIdentities,
    warnings,
    supervisorProblems: supervisor.problems(),
  };
}
