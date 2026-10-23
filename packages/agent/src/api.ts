import http from 'node:http';
import path from 'node:path';
import type { Config } from './config.ts';
import type { ServerManager } from './servers.ts';
import { ApiError, type Projects } from './projects.ts';
import type { Jobs } from './jobs.ts';
import type { Supervisor } from './supervisor.ts';
import { health } from './health.ts';
import * as orchestrator from './orchestrator.ts';
import * as tmux from './tmux.ts';
import * as cc from './claudeCode.ts';
import * as permissions from './permissions.ts';
import * as github from './github.ts';
import { saveConfig } from './config.ts';
import { log } from './log.ts';

export interface Deps {
  cfg: Config;
  servers: ServerManager;
  projects: Projects;
  jobs: Jobs;
  supervisor: Supervisor;
}

interface Ctx {
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
}

type Handler = (ctx: Ctx) => Promise<unknown>;

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
}

function compile(method: string, pattern: string, handler: Handler): Route {
  const keys: string[] = [];
  const re = new RegExp(
    '^' + pattern.replace(/:([A-Za-z]+)/g, (_, k: string) => {
      keys.push(k);
      return '([^/]+)';
    }) + '/?$',
  );
  return { method, re, keys, handler };
}

function str(v: unknown, fallback: string | null = null): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

export function createApi(d: Deps): http.Server {
  const routes: Route[] = [
    compile('GET', '/api/status', async () => {
      const [h, snap] = await Promise.all([health(d.cfg, d.supervisor), d.servers.snapshot()]);
      const orch = snap.servers.find((s) => s.folder === orchestrator.ORCH_DIR && s.state === 'running') ?? null;
      return {
        ...h,
        orchestrator: orch ? { link: orch.link, sessions: orch.sessions.length, name: orch.name } : null,
        runningServers: snap.servers.filter((s) => s.state === 'running').length,
        handoffSessions: snap.handoffSessions.length,
        sessions: snap.servers.reduce((n, s) => n + s.sessions.length, 0) + snap.handoffSessions.length + snap.standaloneSessions.length,
        pinned: d.cfg.pinned,
        allowRules: d.cfg.allowRules,
      };
    }),
    compile('GET', '/api/config', async () => d.cfg),
    compile('GET', '/api/debug', async () => {
      const [table, panes] = await Promise.all([cc.listProcesses(), tmux.listPanes()]);
      return {
        panes,
        processes: table.all.size,
        claude: table.claude
          .filter((p) => p.kind !== 'other')
          .map((p) => ({ pid: p.pid, ppid: p.ppid, kind: p.kind, name: p.name, ancestors: cc.ancestors(table, p.pid).map((a) => ({ pid: a, command: table.all.get(a)?.command.slice(0, 60) })) })),
      };
    }),
    compile('GET', '/api/sessions', async () => d.servers.snapshot()),
    compile('GET', '/api/orchestrator', async () => (await d.servers.running(orchestrator.ORCH_DIR)) ?? null),
    compile('GET', '/api/projects', async ({ query }) => d.projects.list(query.get('query') ?? undefined)),
    compile('POST', '/api/projects', async ({ body }) => {
      const name = str(body.name);
      if (!name) throw new ApiError(400, 'name is required');
      const job = d.jobs.create('create_project');
      try {
        const result = await d.projects.create(
          { name, github: bool(body.github, true), private: bool(body.private, true), description: str(body.description), start: bool(body.start, true), prompt: str(body.prompt) },
          d.jobs,
          job,
        );
        d.jobs.finish(job, result);
        return { job, result };
      } catch (e) {
        d.jobs.fail(job, e);
        const status = e instanceof ApiError ? e.status : 500;
        throw new ApiError(status, `${job.error} (job ${job.id}: ${job.steps.map((s) => `${s.name}=${s.status}`).join(', ')})`);
      }
    }),
    compile('GET', '/api/repos', async ({ query }) => {
      await github.requireGh();
      const remotes = await d.projects.localRemotes();
      const repos = await github.listRepos(d.projects.root, remotes, query.get('query') ?? undefined);
      return { login: await github.ghLogin(), count: repos.length, repos: repos.map((r) => ({ ...r, cloneUrl: undefined, sshUrl: undefined })) };
    }),
    compile('POST', '/api/repos/:name/clone', async ({ params, body }) => {
      await github.requireGh();
      const repo = await github.findRepo(decodeURIComponent(params.name!));
      if (!repo) throw new ApiError(404, `No reachable GitHub repository named "${params.name}"`);
      const folder = await github.cloneRepo(repo, d.projects.root, str(body.name) ?? undefined);
      return { repo: repo.fullName, folder, slug: path.basename(folder) };
    }),
    compile('POST', '/api/projects/:slug/server', async ({ params, body }) => {
      const { folder, cloned } = await d.projects.resolveOrClone(decodeURIComponent(params.slug!), bool(body.clone, true));
      const view = await d.servers.start(folder, {
        name: str(body.name) ?? undefined,
        spawn: str(body.spawn) ?? undefined,
        permissionMode: body.permissionMode === undefined ? undefined : str(body.permissionMode),
      });
      return cloned ? { ...view, cloned: cloned.fullName } : view;
    }),
    compile('DELETE', '/api/projects/:slug/server', async ({ params }) => {
      const folder = d.projects.resolve(decodeURIComponent(params.slug!), true);
      if (folder === orchestrator.ORCH_DIR) throw new ApiError(403, 'The Orchestrator does not stop itself');
      return d.servers.stop(folder);
    }),
    compile('POST', '/api/projects/:slug/sessions', async ({ params, body }) => {
      const prompt = str(body.prompt);
      if (!prompt) throw new ApiError(400, 'prompt is required');
      const { folder, cloned } = await d.projects.resolveOrClone(decodeURIComponent(params.slug!), bool(body.clone, true));
      const view = await d.servers.startSession(folder, {
        prompt,
        name: str(body.name) ?? undefined,
        permissionMode: body.permissionMode === undefined ? undefined : str(body.permissionMode),
      });
      return cloned ? { ...view, cloned: cloned.fullName } : view;
    }),
    compile('DELETE', '/api/sessions/:id', async ({ params }) => d.servers.stopSession(decodeURIComponent(params.id!))),
    compile('POST', '/api/sessions/:id/move', async ({ params }) => d.servers.moveSession(decodeURIComponent(params.id!))),
    compile('POST', '/api/projects/:slug/pin', async ({ params, body }) => {
      const folder = d.projects.resolve(decodeURIComponent(params.slug!));
      return { pinned: d.projects.setPinned(folder, bool(body.pinned, true)) };
    }),
    compile('GET', '/api/permissions', async ({ query }) => {
      const project = query.get('project');
      return {
        defaultRules: d.cfg.allowRules,
        userRules: permissions.userRules(),
        projectRules: project ? await permissions.projectRules(d.projects.resolve(project, true)) : null,
      };
    }),
    compile('POST', '/api/permissions', async ({ body }) => {
      const scope = body.scope === 'user' ? 'user' : 'project';
      const rules = body.rules === undefined ? d.cfg.allowRules : permissions.validateRules(body.rules);
      if (!rules.length) throw new ApiError(400, 'no rules given and no default rules configured');
      if (bool(body.remember, false)) {
        const set = new Set([...d.cfg.allowRules, ...rules]);
        d.cfg.allowRules = [...set];
        saveConfig(d.cfg);
      }
      if (scope === 'user') return { scope, ...permissions.applyToUser(rules), remembered: bool(body.remember, false), note: 'Applies to every Claude Code session on this Mac, running ones included.' };
      const project = str(body.project);
      if (!project) throw new ApiError(400, 'project is required for scope "project"');
      const folder = d.projects.resolve(project, true);
      return { scope, project, ...(await permissions.applyToProject(folder, rules)), remembered: bool(body.remember, false), note: 'Applies to every session in this folder, running ones included.' };
    }),
    compile('GET', '/api/jobs/:id', async ({ params }) => {
      const job = d.jobs.get(params.id!);
      if (!job) throw new ApiError(404, 'no such job');
      return job;
    }),
  ];

  return http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
      log(status >= 500 ? 'error' : 'info', `${method} ${url.pathname} ${status} ${Date.now() - started}ms`);
    };
    try {
      const route = routes.find((r) => r.method === method && r.re.test(url.pathname));
      if (!route) return send(404, { error: `no route for ${method} ${url.pathname}` });
      const m = route.re.exec(url.pathname)!;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => (params[k] = m[i + 1]!));
      const body = await readJson(req);
      const result = await route.handler({ params, query: url.searchParams, body });
      send(200, result ?? {});
    } catch (e) {
      const status = e instanceof ApiError || e instanceof github.GitHubUnavailable ? e.status : 500;
      const message = e instanceof Error ? e.message : String(e);
      if (status >= 500) log('error', `${method} ${url.pathname} failed`, e);
      send(status, { error: message });
    }
  });
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) reject(new ApiError(413, 'body too large'));
      else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const v = JSON.parse(text);
        resolve(v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
      } catch {
        reject(new ApiError(400, 'body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}
