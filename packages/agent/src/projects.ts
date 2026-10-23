import fs from 'node:fs';
import path from 'node:path';
import { type Config, saveConfig } from './config.ts';
import { run, runOk } from './exec.ts';
import type { Job, Jobs } from './jobs.ts';
import { type HandoffSessionView, type ServerManager, type ServerView, slugOf } from './servers.ts';
import * as github from './github.ts';
import { log } from './log.ts';

export interface GitInfo {
  isGit: boolean;
  branch: string | null;
  remote: string | null;
  lastCommit: string | null;
}

export interface ProjectView extends GitInfo {
  slug: string;
  folder: string;
  pinned: boolean;
  server: ServerView | null;
}

export interface CreateProjectInput {
  name: string;
  github: boolean;
  private: boolean;
  description: string | null;
  start: boolean;
  /** Optional first task; when set, a handoff session is started with it after the server. */
  prompt: string | null;
}

export interface CreateProjectResult {
  folder: string;
  slug: string;
  repoUrl: string | null;
  server: ServerView | null;
  session: HandoffSessionView | null;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const GIT_CACHE_MS = 15_000;

export class Projects {
  private cfg: Config;
  private servers: ServerManager;
  private gitCache = new Map<string, { at: number; info: GitInfo }>();

  constructor(cfg: Config, servers: ServerManager) {
    this.cfg = cfg;
    this.servers = servers;
  }

  get root(): string {
    return path.resolve(this.cfg.rootDir);
  }

  /** Accepts a folder name or an absolute path; always returns an existing folder under the root. */
  resolve(input: string, allowRoot = false): string {
    const root = this.root;
    const candidate = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
    if (candidate === root || (allowRoot && input === path.basename(root))) {
      if (allowRoot) return root;
      throw new ApiError(400, 'The root folder itself cannot be a project');
    }
    if (!candidate.startsWith(root + path.sep)) throw new ApiError(400, `"${input}" is not under the root folder ${root}`);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
      throw new ApiError(404, `No project folder named "${input}" under ${root}`);
    }
    return candidate;
  }

  /** Folder names under the root with their git origin (null when not a git repo or no origin). */
  async localRemotes(): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return out;
    }
    const names = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map((e) => e.name);
    await Promise.all(names.map(async (n) => out.set(n, (await this.gitInfo(path.join(this.root, n))).remote)));
    return out;
  }

  /**
   * Like resolve(), but when the folder is missing and a GitHub repo with that name is reachable,
   * clone it into the root first. Returns the folder and whether a clone happened.
   */
  async resolveOrClone(input: string, allowClone = true): Promise<{ folder: string; cloned: github.Repo | null }> {
    try {
      return { folder: this.resolve(input), cloned: null };
    } catch (e) {
      if (!allowClone || !(e instanceof ApiError) || e.status !== 404 || path.isAbsolute(input)) throw e;
      const gh = await github.ghStatus();
      if (gh.problem) throw new ApiError(404, `No project folder named "${input}" under ${this.root}, and GitHub cannot be checked: ${gh.problem}`);
      const repo = await github.findRepo(input).catch((err) => {
        log('warn', 'GitHub lookup failed', err);
        return null;
      });
      if (!repo) throw new ApiError(404, `No project folder named "${input}" under ${this.root}, and no GitHub repository by that name is reachable as ${gh.login}. Try list_repos to see what is available.`);
      const folder = await github.cloneRepo(repo, this.root);
      this.gitCache.delete(folder);
      return { folder, cloned: repo };
    }
  }

  async list(query?: string): Promise<ProjectView[]> {
    const root = this.root;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      throw new ApiError(500, `Root folder ${root} is not readable`);
    }
    const q = query?.trim().toLowerCase();
    const names = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name)
      .filter((n) => !q || n.toLowerCase().includes(q))
      .sort((a, b) => a.localeCompare(b));
    const snap = await this.servers.snapshot();
    const pinned = new Set(this.cfg.pinned);
    return Promise.all(
      names.map(async (name) => {
        const folder = path.join(root, name);
        const info = await this.gitInfo(folder);
        return {
          slug: slugOf(folder),
          folder,
          pinned: pinned.has(name),
          server: snap.servers.find((s) => s.folder === folder) ?? null,
          ...info,
        };
      }),
    );
  }

  async gitInfo(folder: string): Promise<GitInfo> {
    const cached = this.gitCache.get(folder);
    if (cached && Date.now() - cached.at < GIT_CACHE_MS) return cached.info;
    let info: GitInfo = { isGit: false, branch: null, remote: null, lastCommit: null };
    if (fs.existsSync(path.join(folder, '.git'))) {
      const [branch, remote, last] = await Promise.all([
        run('git', ['-C', folder, 'symbolic-ref', '--short', 'HEAD']),
        run('git', ['-C', folder, 'remote', 'get-url', 'origin']),
        run('git', ['-C', folder, 'log', '-1', '--format=%cs %s']),
      ]);
      info = {
        isGit: true,
        branch: branch.code === 0 ? branch.stdout.trim() : null,
        remote: remote.code === 0 ? remote.stdout.trim() : null,
        lastCommit: last.code === 0 ? last.stdout.trim().slice(0, 120) : null,
      };
    }
    this.gitCache.set(folder, { at: Date.now(), info });
    return info;
  }

  setPinned(folder: string, pinned: boolean): string[] {
    const name = path.basename(folder);
    const set = new Set(this.cfg.pinned);
    if (pinned) set.add(name);
    else set.delete(name);
    this.cfg.pinned = [...set].sort();
    saveConfig(this.cfg);
    return this.cfg.pinned;
  }

  async create(input: CreateProjectInput, jobs: Jobs, job: Job): Promise<CreateProjectResult> {
    const name = input.name.trim();
    if (!NAME_RE.test(name) || name.includes('..')) {
      throw new ApiError(400, 'Project name must be letters, digits, dots, dashes or underscores (max 100 chars)');
    }
    const folder = path.join(this.root, name);
    if (fs.existsSync(folder)) throw new ApiError(409, `A folder named "${name}" already exists under ${this.root}`);
    if (input.github) {
      // Verified before anything is created on disk, so a missing gh never leaves a half-made project.
      const gh = await github.ghStatus();
      if (gh.problem) throw new ApiError(503, `Cannot create a GitHub repository: ${gh.problem} (Or pass github: false to create the project locally only.)`);
      const existing = await github.findRepo(name).catch(() => null);
      if (existing) throw new ApiError(409, `A GitHub repository ${existing.fullName} already exists. Use clone_repo (or start_server, which clones on demand) instead of creating a new one.`);
    }

    await jobs.step(job, 'Create folder', async () => fs.mkdirSync(folder));
    await jobs.step(job, 'git init', () => runOk('git', ['init', '-b', 'main'], { cwd: folder }));
    await jobs.step(job, 'Write README and first commit', async () => {
      const body = `# ${name}\n${input.description ? `\n${input.description}\n` : ''}`;
      fs.writeFileSync(path.join(folder, 'README.md'), body);
      fs.writeFileSync(path.join(folder, '.gitignore'), 'node_modules/\n.DS_Store\n.env\n');
      await runOk('git', ['add', '-A'], { cwd: folder });
      await runOk('git', ['commit', '-q', '-m', 'Initial commit'], { cwd: folder });
    });

    let repoUrl: string | null = null;
    if (input.github) {
      const owner = this.cfg.githubOwner ?? (await runOk('gh', ['api', 'user', '--jq', '.login'])).trim();
      repoUrl = await jobs.step(job, `Create GitHub repo ${owner}/${name} and push`, async () => {
        const args = ['repo', 'create', `${owner}/${name}`, input.private ? '--private' : '--public', '--source', folder, '--remote', 'origin', '--push'];
        if (input.description) args.push('--description', input.description);
        await runOk('gh', args, { cwd: folder, timeoutMs: 120_000 });
        github.invalidateRepoCache();
        return `https://github.com/${owner}/${name}`;
      });
      this.gitCache.delete(folder);
    }

    // With a first prompt, start only the handoff session: a folder server would add a second,
    // idle pre-created session to the user's list for nothing. The server can be started later.
    let server: ServerView | null = null;
    let session: HandoffSessionView | null = null;
    if (input.prompt) {
      session = await jobs.step(job, 'Start session with the first prompt', () => this.servers.startSession(folder, { prompt: input.prompt! }), (s) => s.link);
    } else if (input.start) {
      server = await jobs.step(job, 'Start Remote Control server', () => this.servers.start(folder, { name }), (s) => s.link ?? '');
    }
    return { folder, slug: slugOf(folder), repoUrl, server, session };
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
