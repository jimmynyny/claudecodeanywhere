/**
 * GitHub awareness: which repositories the Mac's `gh` login can reach, which of them are
 * already cloned under the root, and cloning one on demand. Uses the REST API through `gh api`
 * because fine-grained tokens reject some GraphQL fields that `gh repo list` needs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { run, runOk } from './exec.ts';
import { log } from './log.ts';

export interface Repo {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  archived: boolean;
  defaultBranch: string;
  pushedAt: string;
  description: string | null;
  url: string;
  sshUrl: string;
  cloneUrl: string;
  /** Folder name under the root that has this repo as its origin, if any. */
  local: string | null;
}

const CACHE_MS = 60_000;
let cache: { at: number; repos: Repo[] } | null = null;

export interface GhStatus {
  installed: boolean;
  loggedIn: boolean;
  login: string | null;
  /** Human instruction when something is missing; null when ready. */
  problem: string | null;
}

let ghCache: { at: number; status: GhStatus } | null = null;
const GH_CACHE_MS = 30_000;

/** Is the GitHub CLI installed and authenticated on this Mac? Cached briefly. */
export async function ghStatus(force = false): Promise<GhStatus> {
  if (!force && ghCache && Date.now() - ghCache.at < GH_CACHE_MS) return ghCache.status;
  const ver = await run('gh', ['--version']);
  let status: GhStatus;
  if (ver.code === 127 || /ENOENT|not found/i.test(ver.stderr)) {
    status = { installed: false, loggedIn: false, login: null, problem: 'The GitHub CLI (gh) is not installed on this Mac. Install it with `brew install gh`, then `gh auth login -h github.com -p ssh -w`, or rerun ./install.sh.' };
  } else {
    const auth = await run('gh', ['auth', 'status']);
    if (auth.code !== 0) {
      status = { installed: true, loggedIn: false, login: null, problem: 'gh is installed but not logged in on this Mac. Run `gh auth login -h github.com -p ssh -w` in a terminal there (it opens a browser once), or rerun ./install.sh.' };
    } else {
      const login = await run('gh', ['api', 'user', '--jq', '.login']);
      status = login.code === 0
        ? { installed: true, loggedIn: true, login: login.stdout.trim(), problem: null }
        : { installed: true, loggedIn: false, login: null, problem: `gh is logged in but GitHub rejected the token (${(login.stderr || login.stdout).trim().split('\n')[0]}). Re-run \`gh auth login\` on the Mac.` };
    }
  }
  ghCache = { at: Date.now(), status };
  return status;
}

export class GitHubUnavailable extends Error {
  status = 503;
  constructor(problem: string) {
    super(problem);
  }
}

/** Throw unless gh is installed and authenticated. Call before any GitHub operation. */
export async function requireGh(): Promise<GhStatus> {
  const s = await ghStatus();
  if (s.problem) throw new GitHubUnavailable(s.problem);
  return s;
}

interface ApiRepo {
  full_name: string;
  name: string;
  private: boolean;
  archived: boolean;
  default_branch: string;
  pushed_at: string;
  description: string | null;
  html_url: string;
  ssh_url: string;
  clone_url: string;
  owner: { login: string };
}

export async function ghLogin(): Promise<string | null> {
  return (await ghStatus()).login;
}

async function fetchRepos(): Promise<Repo[]> {
  await requireGh();
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.repos;
  const r = await run('gh', ['api', '--paginate', 'user/repos?per_page=100&affiliation=owner,collaborator,organization_member&sort=pushed'], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`gh could not list repositories: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}`);
  // --paginate concatenates JSON arrays; split them apart.
  const pages = r.stdout.trim().replace(/\]\s*\[/g, '],[');
  const parsed = JSON.parse(`[${pages}]`) as ApiRepo[][];
  const repos: Repo[] = parsed.flat().map((x) => ({
    fullName: x.full_name,
    owner: x.owner.login,
    name: x.name,
    private: x.private,
    archived: x.archived,
    defaultBranch: x.default_branch,
    pushedAt: x.pushed_at,
    description: x.description,
    url: x.html_url,
    sshUrl: x.ssh_url,
    cloneUrl: x.clone_url,
    local: null,
  }));
  repos.sort((a, b) => (a.pushedAt < b.pushedAt ? 1 : -1));
  cache = { at: Date.now(), repos };
  return repos;
}

/** Normalise an origin URL to owner/name for matching. */
export function remoteToFullName(remote: string | null): string | null {
  if (!remote) return null;
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(remote.trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** Repos reachable by gh, each annotated with the local folder that tracks it (if any). */
export async function listRepos(root: string, localRemotes: Map<string, string | null>, query?: string): Promise<Repo[]> {
  const repos = await fetchRepos();
  const byFullName = new Map<string, string>();
  for (const [folderName, remote] of localRemotes) {
    const fn = remoteToFullName(remote);
    if (fn) byFullName.set(fn, folderName);
  }
  const q = query?.trim().toLowerCase();
  return repos
    .map((r) => ({ ...r, local: byFullName.get(r.fullName.toLowerCase()) ?? (fs.existsSync(path.join(root, r.name)) ? r.name : null) }))
    .filter((r) => !q || r.name.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q));
}

/** Find one repo by `name` or `owner/name`, case-insensitively. */
export async function findRepo(nameOrFullName: string): Promise<Repo | null> {
  const repos = await fetchRepos();
  const n = nameOrFullName.trim().toLowerCase();
  const exact = repos.find((r) => r.fullName.toLowerCase() === n);
  if (exact) return exact;
  const byName = repos.filter((r) => r.name.toLowerCase() === n);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    // Prefer the one you own.
    const login = (await ghLogin())?.toLowerCase();
    return byName.find((r) => r.owner.toLowerCase() === login) ?? byName[0]!;
  }
  return null;
}

/** Clone a repo into <root>/<dirName or repo name>. Returns the folder. */
export async function cloneRepo(repo: Repo, root: string, dirName?: string): Promise<string> {
  await requireGh();
  const folder = path.join(root, dirName?.trim() || repo.name);
  if (fs.existsSync(folder)) throw new Error(`Folder already exists: ${folder}`);
  log('info', 'cloning repository', { repo: repo.fullName, folder });
  await runOk('gh', ['repo', 'clone', repo.fullName, folder], { timeoutMs: 10 * 60_000 });
  return folder;
}

export function invalidateRepoCache(): void {
  cache = null;
}
