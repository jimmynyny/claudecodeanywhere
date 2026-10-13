import { spawn, type ChildProcess } from 'node:child_process';
import { loadConfig, CONFIG_PATH, AGENT_VERSION } from './config.ts';
import { ServerManager } from './servers.ts';
import { Projects } from './projects.ts';
import { Jobs } from './jobs.ts';
import { Supervisor } from './supervisor.ts';
import { createApi } from './api.ts';
import * as orchestrator from './orchestrator.ts';
import { log } from './log.ts';

const cfg = loadConfig();
log('info', `Claude Code Anywhere agent ${AGENT_VERSION} starting`, { config: CONFIG_PATH, root: cfg.rootDir, port: cfg.port, machine: cfg.machineName });

orchestrator.ensureFiles(cfg);

const servers = new ServerManager(cfg);
const projects = new Projects(cfg, servers);
const jobs = new Jobs();
const supervisor = new Supervisor(cfg, servers, projects);
const api = createApi({ cfg, servers, projects, jobs, supervisor });

api.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EADDRINUSE') log('error', `port ${cfg.port} is already in use; is another agent running?`);
  else log('error', 'http server error', e);
  process.exit(1);
});

api.listen(cfg.port, '127.0.0.1', () => {
  log('info', `listening on http://127.0.0.1:${cfg.port}`);
  supervisor.start();
});

let caffeinate: ChildProcess | null = null;
if (cfg.preventSleep) {
  caffeinate = spawn('caffeinate', ['-s'], { stdio: 'ignore' });
  log('info', 'caffeinate -s running to prevent sleep');
}

function shutdown(signal: string): void {
  log('info', `received ${signal}; agent exiting (tmux servers keep running)`);
  supervisor.stop();
  caffeinate?.kill();
  api.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => log('error', 'unhandled rejection', e));
