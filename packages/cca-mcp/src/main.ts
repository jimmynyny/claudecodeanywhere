/**
 * `cca` MCP server: a thin stdio shim that forwards every tool call to the local agent.
 * It holds no logic of its own, so the agent stays the single source of truth.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = `http://127.0.0.1:${process.env.CCA_PORT ?? '7777'}`;

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

async function call(method: string, p: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(BASE + p, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`The Claude Code Anywhere agent is not reachable at ${BASE} (${(e as Error).message}). On the Mac, check: launchctl print gui/$(id -u)/com.claudecodeanywhere.agent`);
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = (data as { error?: string }).error ?? `HTTP ${res.status}`;
    throw new Error(err);
  }
  return data;
}

async function wrap(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const data = await fn();
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 1) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `cca error: ${(e as Error).message}` }] };
  }
}

const server = new McpServer({ name: 'cca', version: '0.1.0' });

server.registerTool(
  'list_status',
  {
    title: 'Agent and machine status',
    description: 'Health of this Mac: Claude Code login, gh auth, Orchestrator link, counts of running servers and sessions, and any warnings. Call this first when something seems off.',
    inputSchema: {},
  },
  () => wrap(() => call('GET', '/api/status')),
);

server.registerTool(
  'list_projects',
  {
    title: 'List project folders',
    description: 'Folders directly under the projects root, with git branch, remote, last commit, whether pinned, and the state of their Remote Control server if any. Optional query filters by name.',
    inputSchema: { query: z.string().optional().describe('Case-insensitive substring to filter folder names') },
  },
  ({ query }) => wrap(() => call('GET', `/api/projects${query ? `?query=${encodeURIComponent(query)}` : ''}`)),
);

server.registerTool(
  'list_repos',
  {
    title: 'List GitHub repositories this Mac can reach',
    description: 'Requires the GitHub CLI (gh) installed and logged in on this Mac; otherwise the error says what to do. Every repository the Mac\'s gh login can access (owned, collaborator, organization), newest push first, with `local` set to the folder name under the root that already tracks it, or null when it is not cloned here. Use it when a project is not in list_projects, or when the user asks what repos exist. Optional query filters by name or description.',
    inputSchema: { query: z.string().optional().describe('Case-insensitive substring of the repo name or description') },
  },
  ({ query }) => wrap(() => call('GET', `/api/repos${query ? `?query=${encodeURIComponent(query)}` : ''}`)),
);

server.registerTool(
  'clone_repo',
  {
    title: 'Clone a GitHub repository into the projects root',
    description: 'Clones a reachable repository (by name or owner/name) into <root>/<name> so it can be worked on here. start_server and start_session already do this on demand when a project folder is missing, so call this only when the user wants the clone without starting anything, or wants a different folder name.',
    inputSchema: { repo: z.string().describe('Repository name or owner/name'), name: z.string().optional().describe('Folder name under the root (default: the repo name)') },
  },
  ({ repo, name }) => wrap(() => call('POST', `/api/repos/${encodeURIComponent(repo)}/clone`, { name })),
);

server.registerTool(
  'list_sessions',
  {
    title: 'List Remote Control servers and sessions',
    description: 'Three independent lists: `servers` (multi-session claude remote-control servers per folder, with the sessions they host), `handoffSessions` (single sessions CCA started with a task; each is its own process and is NOT hosted by, or affected by, the folder server), and `standaloneSessions` (plain claude sessions someone started in a terminal). Each entry has idle/busy/waiting status and a link.',
    inputSchema: {},
  },
  () => wrap(() => call('GET', '/api/sessions')),
);

server.registerTool(
  'start_server',
  {
    title: 'Start or resume a Remote Control server for a project',
    description: 'Starts `claude remote-control` in the project folder (inside tmux) and returns its link. Idempotent: if a server is already running for that folder, returns it. If one was stopped less than 4 hours ago, its sessions are resumed. If the folder does not exist but a GitHub repository with that name is reachable, it is cloned into the root first (the result then has `cloned`). Open the returned link in the Claude app or claude.ai/code to create or pick a session there.',
    inputSchema: {
      project: z.string().describe('Project folder name under the root (or its absolute path)'),
      name: z.string().optional().describe('Display name for the session list; defaults to the folder name'),
      spawn: z.enum(['same-dir', 'worktree']).optional().describe('How new sessions are created in this folder; default from config (same-dir)'),
      permission_mode: z.string().optional().describe('Claude Code permission mode for sessions, e.g. acceptEdits, plan, default'),
    },
  },
  ({ project, name, spawn, permission_mode }) =>
    wrap(() => call('POST', `/api/projects/${encodeURIComponent(project)}/server`, { name, spawn, permissionMode: permission_mode })),
);

server.registerTool(
  'stop_server',
  {
    title: 'Stop a project\'s Remote Control server',
    description: 'Stops the server for a project folder (also works for a server someone started by hand, including one in the root folder itself). Its sessions go offline but stay resumable for about 4 hours via start_server. Refuses to stop the Orchestrator itself.',
    inputSchema: { project: z.string().describe('Project folder name under the root') },
  },
  ({ project }) => wrap(() => call('DELETE', `/api/projects/${encodeURIComponent(project)}/server`)),
);

server.registerTool(
  'create_project',
  {
    title: 'Create a new project folder, git repo, GitHub repo, and server',
    description: 'ONE call does everything: creates <root>/<name>, runs git init on branch main with a README and first commit, optionally creates a GitHub repo (private by default) and pushes, then starts either a Remote Control server (no prompt) or one handoff session (with prompt) and returns the link. When the user also says what to build, pass it as `prompt` here; do NOT call create_project and then start_session, that produces two entries in the user\'s session list. Takes 5 to 20 seconds. On failure the response names the step that failed; the folder is left in place so the problem can be fixed and start_server used afterwards.',
    inputSchema: {
      name: z.string().describe('Folder and repo name: letters, digits, dots, dashes, underscores'),
      github: z.boolean().optional().describe('Create a GitHub repo and push (default true)'),
      private: z.boolean().optional().describe('Make the GitHub repo private (default true)'),
      description: z.string().optional().describe('One line for the README and the GitHub repo description'),
      start: z.boolean().optional().describe('Start the folder\'s Remote Control server when done (default true). Ignored when prompt is given.'),
      prompt: z.string().optional().describe('A first task. When given, exactly one session is started in the new project with this prompt and begins working immediately; its link is returned as `session.link`. No folder server is started, so the user sees one entry, not two; start_server can add the server later.'),
    },
  },
  (input) => wrap(() => call('POST', '/api/projects', input)),
);

server.registerTool(
  'start_session',
  {
    title: 'Start a session in a project with a first prompt (handoff)',
    description: 'Starts one interactive Claude Code session in the project folder, connected to Remote Control, and gives it the prompt so it starts working right away. Returns the session link. If the folder does not exist but a GitHub repository with that name is reachable, it is cloned into the root first (the result then has `cloned`). Use this when the user wants something done, not just a server. Permission mode defaults to the configured handoff mode (auto).',
    inputSchema: {
      project: z.string().describe('Project folder name under the root'),
      prompt: z.string().describe('The task, written as you would brief a capable engineer: what to build or do, and any constraints'),
      name: z.string().optional().describe('Short title for the session list; defaults to the first words of the prompt'),
      permission_mode: z.string().optional().describe('Override the permission mode, e.g. acceptEdits, auto, plan'),
    },
  },
  ({ project, prompt, name, permission_mode }) =>
    wrap(() => call('POST', `/api/projects/${encodeURIComponent(project)}/sessions`, { prompt, name, permissionMode: permission_mode })),
);

server.registerTool(
  'stop_session',
  {
    title: 'Stop a session',
    description: 'Stops any session: a handoff session (by tmux session cca-<project>-sN or display name), a session hosted by a server, or a standalone session someone started by hand in a terminal. Identify it by the session name, session id, or pid from list_sessions. Conversations stay resumable. Confirm with the user before stopping a session CCA did not start.',
    inputSchema: { session: z.string().describe('Session name, session id, pid, tmux session, or display name') },
  },
  ({ session }) => wrap(() => call('DELETE', `/api/sessions/${encodeURIComponent(session)}`)),
);

server.registerTool(
  'move_session',
  {
    title: 'Move a session onto the CCA tmux server (keychain access), keeping its conversation',
    description: 'For a session that was started by hand or by an older CCA (it shows tmuxSocket "default" or none in list_sessions) and therefore cannot use the login keychain for Xcode signing. Stops it and resumes the same conversation with claude --resume inside CCA\'s tmux server, with Remote Control reattached. Shell commands running in the old session are lost; the transcript and the claude.ai session are kept. Confirm with the user first if the session is busy.',
    inputSchema: { session: z.string().describe('Session name, session id, pid, tmux session, or display name from list_sessions') },
  },
  ({ session }) => wrap(() => call('POST', `/api/sessions/${encodeURIComponent(session)}/move`)),
);

server.registerTool(
  'allow_rules',
  {
    title: 'Pre-approve commands for sessions (permission allow rules)',
    description: 'Adds Claude Code permission allow rules, in Claude Code\'s own syntax such as "Bash(git push:*)", so matching commands run without a prompt. scope "project" writes the project\'s .claude/settings.local.json and takes effect immediately in every session running in that folder; scope "user" writes ~/.claude/settings.json and applies to every session on this Mac, running or future. With no rules given, applies the configured defaults (git push by default). remember=true also adds the rules to the defaults applied to every folder CCA starts from now on. Call with no arguments beyond scope/project to see what is set via list_status.allowRules.',
    inputSchema: {
      scope: z.enum(['project', 'user']).optional().describe('"project" (default) for one folder, "user" for every session on this Mac'),
      project: z.string().optional().describe('Project folder name; required for scope "project"'),
      rules: z.array(z.string()).optional().describe('Rules like "Bash(git push:*)", "Bash(npm test:*)"; default: the configured defaults'),
      remember: z.boolean().optional().describe('Also add these rules to the defaults for all future CCA sessions'),
    },
  },
  ({ scope, project, rules, remember }) => wrap(() => call('POST', '/api/permissions', { scope, project, rules, remember })),
);

server.registerTool(
  'pin_project',
  {
    title: 'Pin or unpin a project',
    description: 'A pinned project\'s server is kept running by the agent at all times, including after reboots. Unpinning does not stop a running server.',
    inputSchema: { project: z.string().describe('Project folder name under the root'), pinned: z.boolean().describe('true to pin, false to unpin') },
  },
  ({ project, pinned }) => wrap(() => call('POST', `/api/projects/${encodeURIComponent(project)}/pin`, { pinned })),
);

await server.connect(new StdioServerTransport());
