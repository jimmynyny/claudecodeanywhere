/**
 * Permission allow rules for the sessions CCA starts.
 *
 * Claude Code watches its settings files and applies `permissions` edits to running sessions,
 * so writing a rule into a folder's `.claude/settings.local.json` takes effect immediately for
 * every session in that folder, and a rule in `~/.claude/settings.json` for every session on
 * the Mac. Rules use Claude Code's own syntax, for example `Bash(git push:*)`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { run } from './exec.ts';
import { log } from './log.ts';

export interface ApplyResult {
  file: string;
  added: string[];
  already: string[];
  rules: string[];
}

const RULE_RE = /^[A-Za-z]+(\([^\n]*\))?$/;

export function validateRules(rules: unknown): string[] {
  if (!Array.isArray(rules)) throw new Error('rules must be an array of strings like "Bash(git push:*)"');
  const out: string[] = [];
  for (const r of rules) {
    if (typeof r !== 'string' || !RULE_RE.test(r.trim())) throw new Error(`"${String(r)}" is not a valid permission rule (expected e.g. Bash(git push:*))`);
    out.push(r.trim());
  }
  return out;
}

function mergeInto(file: string, rules: string[]): ApplyResult {
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      throw new Error(`${file} is not valid JSON; fix it by hand before adding rules`);
    }
  }
  const permissions = ((settings.permissions as Record<string, unknown> | undefined) ??= {});
  const allow = (permissions.allow as string[] | undefined) ?? [];
  const added: string[] = [];
  const already: string[] = [];
  for (const r of rules) (allow.includes(r) ? already : added).push(r);
  if (added.length) {
    permissions.allow = [...allow, ...added];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.cca-tmp';
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
    fs.renameSync(tmp, file);
  }
  return { file, added, already, rules: permissions.allow as string[] };
}

/** Where Claude Code reads `.claude/settings.local.json` for a folder: the git repo root if there is one. */
async function settingsRoot(folder: string): Promise<string> {
  const r = await run('git', ['-C', folder, 'rev-parse', '--show-toplevel']);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : folder;
}

/** Same thing Claude Code does the first time it writes a local settings file: keep it out of every repo. */
function ensureGlobalExclude(): void {
  const pattern = '**/.claude/settings.local.json';
  let file: string;
  try {
    const cfg = execFileSync('git', ['config', '--global', 'core.excludesFile'], { encoding: 'utf8' }).trim();
    file = cfg ? cfg.replace(/^~/, os.homedir()) : '';
  } catch {
    file = '';
  }
  if (!file) file = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'git', 'ignore');
  try {
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (existing.split('\n').some((l) => l.trim() === pattern)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, (existing && !existing.endsWith('\n') ? '\n' : '') + pattern + '\n');
    log('info', 'added local settings pattern to global git excludes', { file });
  } catch (e) {
    log('warn', 'could not update global git excludes', e);
  }
}

/** Add rules to a project folder's local settings; running sessions there pick them up at once. */
export async function applyToProject(folder: string, rules: string[]): Promise<ApplyResult> {
  if (!rules.length) return { file: '', added: [], already: [], rules: [] };
  const root = await settingsRoot(folder);
  const file = path.join(root, '.claude', 'settings.local.json');
  const existed = fs.existsSync(file);
  const result = mergeInto(file, rules);
  if (!existed && result.added.length) ensureGlobalExclude();
  if (result.added.length) log('info', 'allow rules added', { file, added: result.added });
  return result;
}

/** Add rules to ~/.claude/settings.json: every session on this Mac, running or future. */
export function applyToUser(rules: string[]): ApplyResult {
  const file = path.join(os.homedir(), '.claude', 'settings.json');
  const result = mergeInto(file, rules);
  if (result.added.length) log('info', 'user-level allow rules added', { added: result.added });
  return result;
}

export function userRules(): string[] {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')) as { permissions?: { allow?: string[] } };
    return s.permissions?.allow ?? [];
  } catch {
    return [];
  }
}

export async function projectRules(folder: string): Promise<string[]> {
  const file = path.join(await settingsRoot(folder), '.claude', 'settings.local.json');
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) as { permissions?: { allow?: string[] } };
    return s.permissions?.allow ?? [];
  } catch {
    return [];
  }
}
