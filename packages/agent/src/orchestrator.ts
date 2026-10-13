import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { APP_DIR, REPO_ROOT, type Config } from './config.ts';
import { RESUME_WINDOW_MS } from './state.ts';
import type { ServerManager, ServerView } from './servers.ts';
import { log } from './log.ts';

/** The Orchestrator runs in its own folder, outside the projects root, so it never collides with a project. */
export const ORCH_DIR = path.join(APP_DIR, 'orchestrator');

export function orchestratorName(cfg: Config): string {
  return `CCA Orchestrator (${cfg.machineName})`;
}

/** Hash of the generated Orchestrator files; a running session that loaded different ones must restart. */
export let currentHash = '';

/** (Re)write the files that define the Orchestrator session. Safe to call on every agent start. */
export function ensureFiles(cfg: Config): string {
  fs.mkdirSync(path.join(ORCH_DIR, '.claude'), { recursive: true });

  const tmpl = fs.readFileSync(path.join(REPO_ROOT, 'orchestrator', 'CLAUDE.md.tmpl'), 'utf8');
  const claudeMd = tmpl
    .replaceAll('{{machine}}', cfg.machineName)
    .replaceAll('{{user}}', cfg.userName)
    .replaceAll('{{root}}', path.resolve(cfg.rootDir))
    .replaceAll('{{repo}}', REPO_ROOT);
  fs.writeFileSync(path.join(ORCH_DIR, 'CLAUDE.md'), claudeMd);

  const mcp = {
    mcpServers: {
      cca: {
        type: 'stdio',
        command: process.execPath,
        args: [path.join(REPO_ROOT, 'packages', 'cca-mcp', 'src', 'main.ts')],
        env: { CCA_PORT: String(cfg.port) },
      },
    },
  };
  fs.writeFileSync(path.join(ORCH_DIR, '.mcp.json'), JSON.stringify(mcp, null, 2) + '\n');

  const settings = {
    permissions: { allow: ['mcp__cca'] },
    enableAllProjectMcpServers: true,
  };
  fs.writeFileSync(path.join(ORCH_DIR, '.claude', 'settings.json'), JSON.stringify(settings, null, 2) + '\n');

  currentHash = createHash('sha256').update(claudeMd).update(JSON.stringify(mcp)).update(JSON.stringify(settings)).digest('hex').slice(0, 16);

  const readme = path.join(ORCH_DIR, 'README.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, '# Orchestrator\n\nThis folder is managed by Claude Code Anywhere. The Remote Control session that runs here is your control plane for projects on this Mac.\n');
  }
  return currentHash;
}

/** Make sure the Orchestrator server is up, preferring to resume the previous conversation. */
export async function ensureRunning(cfg: Config, servers: ServerManager): Promise<ServerView> {
  const running = await servers.running(ORCH_DIR);
  if (running) {
    if (servers.orchestratorHash === currentHash) return running;
    // Instructions or tools changed since this session started; restart so it reloads them.
    // The conversation comes back via --continue.
    log('info', 'orchestrator files changed; restarting it to reload CLAUDE.md and tools', { from: servers.orchestratorHash, to: currentHash });
    await servers.stop(ORCH_DIR);
  }

  const name = orchestratorName(cfg);
  const rec = servers.record(ORCH_DIR);
  const permissionMode = cfg.orchestrator.permissionMode;
  let view: ServerView | null = null;
  if (rec?.stoppedAt && Date.now() - rec.stoppedAt < RESUME_WINDOW_MS) {
    try {
      view = await servers.start(ORCH_DIR, { name, continue: true, continueOnRestart: true, permissionMode });
    } catch (e) {
      log('warn', 'orchestrator resume with --continue failed; starting a fresh session', e);
    }
  }
  view ??= await servers.start(ORCH_DIR, { name, spawn: 'session', continueOnRestart: true, permissionMode });
  servers.orchestratorHash = currentHash;
  return view;
}
