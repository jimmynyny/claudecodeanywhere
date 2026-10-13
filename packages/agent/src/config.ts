import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const APP_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'ClaudeCodeAnywhere');
export const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'ClaudeCodeAnywhere');
export const CONFIG_PATH = path.join(APP_DIR, 'config.json');
/** The checked-out repo this agent runs from (packages/agent/src -> repo root). */
export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
export const AGENT_VERSION = '0.1.0';

export interface Config {
  /** Folder that contains all project folders. */
  rootDir: string;
  /** How the Orchestrator refers to you. */
  userName: string;
  /** Shown in the Orchestrator's name and status output. */
  machineName: string;
  port: number;
  /** GitHub owner for new repos; null means "whoever gh is logged in as". */
  githubOwner: string | null;
  defaultSpawn: 'same-dir' | 'worktree';
  /** Permission mode passed to project servers; null means Claude Code's default. */
  defaultPermissionMode: string | null;
  /** Permission mode for handoff sessions started with a first prompt (M4). */
  handoffPermissionMode: string | null;
  /** Project folder names whose server should always be running. */
  pinned: string[];
  orchestrator: {
    enabled: boolean;
    permissionMode: string | null;
  };
  /** Run `caffeinate -s` while the agent is up. */
  preventSleep: boolean;
}

function accountFullName(): string {
  try {
    const n = execFileSync('id', ['-F'], { encoding: 'utf8' }).trim();
    if (n) return n.split(' ')[0]!;
  } catch {
    // fall through
  }
  return os.userInfo().username;
}

export function defaultConfig(): Config {
  return {
    rootDir: process.env.CCA_ROOT ?? path.join(os.homedir(), 'Dropbox', 'Documents', '__SCRIPTS'),
    userName: accountFullName(),
    machineName: os.hostname().split('.')[0] || 'mac',
    port: Number(process.env.CCA_PORT ?? 7777),
    githubOwner: null,
    defaultSpawn: 'same-dir',
    defaultPermissionMode: null,
    handoffPermissionMode: 'auto',
    pinned: [],
    orchestrator: { enabled: true, permissionMode: null },
    preventSleep: false,
  };
}

export function loadConfig(): Config {
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const d = defaultConfig();
  if (!fs.existsSync(CONFIG_PATH)) {
    saveConfig(d);
    return d;
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<Config>;
  const merged: Config = {
    ...d,
    ...raw,
    orchestrator: { ...d.orchestrator, ...(raw.orchestrator ?? {}) },
    pinned: Array.isArray(raw.pinned) ? raw.pinned : d.pinned,
  };
  // Write back keys added by newer versions so the file on disk always shows the full config.
  if (JSON.stringify(merged) !== JSON.stringify({ ...raw, orchestrator: raw.orchestrator ?? {} })) saveConfig(merged);
  return merged;
}

export function saveConfig(c: Config): void {
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + '\n');
}
