// MCP: JSON-RPC 2.0 over Streamable HTTP, pre-discover era. The client probes
// server/discover first; this server answers "method not found" for it, and the
// client falls back to the initialize handshake. The six tools work on the same
// store REST and GraphQL use.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Repo, Store } from './store.ts';
import { branchTip, makeCommit, mergeTrees, refName } from './vcs.ts';
import { isRecord, parseJsonBody, readBody, requireAuth, sendJson } from './http.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

/** The revisions the initialize handshake may settle on. */
const SUPPORTED_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, { type: string; description: string }>;
    readonly required: string[];
  };
}

/** The tool list is a constant: two tools/list calls answer byte-identical lists. */
const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

interface ToolResult {
  readonly content: Array<{ type: 'text'; text: string }>;
  readonly structuredContent: unknown;
  readonly isError?: boolean;
}

function okResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

/** The repo a tool names, when it exists and belongs to the token's login. */
function ownedRepo(store: Store, owner: unknown, name: unknown): Repo | null {
  if (typeof owner !== 'string' || typeof name !== 'string') return null;
  const repo = store.getRepo(owner, name);
  if (repo === undefined || repo.owner !== store.viewer.login) return null;
  return repo;
}

function missingArg(tool: ToolDef, args: Record<string, unknown>): string | null {
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') return required;
  }
  return null;
}

function runTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  const tool = TOOLS.find((item) => item.name === name);
  if (tool === undefined) return errorResult(`Unknown tool: ${name}`);
  const missing = missingArg(tool, args);
  if (missing !== null) return errorResult(`Missing required argument: ${missing}`);

  switch (name) {
    case 'create_repo': {
      const repoName = args['name'] as string;
      if (store.getRepo(store.viewer.login, repoName) !== undefined) {
        return errorResult(`Repository ${store.viewer.login}/${repoName} already exists`);
      }
      const repo = store.createRepo(store.viewer.login, repoName, {
        description: typeof args['description'] === 'string' ? args.description : undefined,
        private: args['private'] === true,
      });
      return okResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = ownedRepo(store, args['owner'], args['repo']);
      if (repo === null) return errorResult('Repository not found');
      return okResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = ownedRepo(store, args['owner'], args['repo']);
      if (repo === null) return errorResult('Repository not found');
      const issue = store.createIssue(repo, args['title'] as string, typeof args['body'] === 'string' ? args.body : '', []);
      return okResult(issueJson(issue));
    }
    case 'list_issues': {
      const repo = ownedRepo(store, args['owner'], args['repo']);
      if (repo === null) return errorResult('Repository not found');
      const state = typeof args['state'] === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => b.createdSeq - a.createdSeq);
      const value = { issues: issues.map(issueJson) };
      return okResult(value);
    }
    case 'create_pull_request': {
      const repo = ownedRepo(store, args['owner'], args['repo']);
      if (repo === null) return errorResult('Repository not found');
      const head = args['head'] as string;
      const base = args['base'] as string;
      const headSha = branchTip(repo, head);
      const baseSha = branchTip(repo, base);
      if (headSha === null || baseSha === null) return errorResult('Head or base branch does not exist');
      const duplicate = [...repo.pulls.values()].some(
        (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
      );
      if (duplicate) return errorResult('A pull request already exists for this head and base');
      const pull = store.createPullRequest(
        repo,
        args['title'] as string,
        typeof args['body'] === 'string' ? args.body : '',
        head,
        base,
        headSha,
        baseSha,
      );
      return okResult(pullJson(pull));
    }
    case 'merge_pull_request': {
      const repo = ownedRepo(store, args['owner'], args['repo']);
      if (repo === null) return errorResult('Repository not found');
      const number = typeof args['pull_number'] === 'number' ? args.pull_number : Number.parseInt(String(args['pull_number']), 10);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return errorResult('Pull request not found');
      if (pull.state !== 'open') return errorResult('Pull request is already closed');
      const currentBaseTip = branchTip(repo, pull.baseRef);
      if (currentBaseTip === null) return errorResult('Base branch does not exist');
      const mergedTree = mergeTrees(store, repo, pull.baseSha, pull.headSha, currentBaseTip);
      if (mergedTree === null) return errorResult('Pull request is conflicted');
      const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
      const mergeSha = makeCommit(store, repo, { tree: mergedTree, parents: [currentBaseTip], message });
      repo.refs.set(refName(pull.baseRef), mergeSha);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = store.clock.nextIso();
      pull.mergeCommitSha = mergeSha;
      pull.updatedAt = store.clock.nextIso();
      return okResult({ sha: mergeSha, merged: true, message, pull_number: pull.number, state: 'closed' });
    }
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** POST /mcp (and the 405 for GET/DELETE). Returns true when handled here. */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  if (req.method === 'GET' || req.method === 'DELETE') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not allowed' } }));
    return true;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not allowed' } }));
    return true;
  }
  if (!requireAuth(req, res)) return true;

  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  let message: unknown;
  try {
    message = parseJsonBody(raw);
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (!isRecord(message) || typeof message['method'] !== 'string') {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }
  const id = 'id' in message ? message['id'] : undefined;
  const isNotification = id === undefined;
  const method = message['method'] as string;
  const params = isRecord(message['params']) ? (message['params'] as Record<string, unknown>) : {};

  // Notifications carry no id and get a bare 202.
  if (isNotification) {
    res.writeHead(202);
    res.end();
    return true;
  }

  if (method === 'server/discover') {
    // Pre-discover revision: answer "method not found" and the client falls back
    // to the initialize handshake.
    sendJson(res, 200, rpcError(id, -32601, 'Method not found'));
    return true;
  }

  if (method === 'ping') {
    sendJson(res, 200, rpcResult(id, {}));
    return true;
  }

  if (method === 'initialize') {
    const offered = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '';
    if (!SUPPORTED_REVISIONS.includes(offered)) {
      sendJson(res, 200, rpcError(id, -32602, `Unsupported protocol version: ${offered}`));
      return true;
    }
    sendJson(res, 200, rpcResult(id, {
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: '1.0.0' },
    }));
    return true;
  }

  if (method === 'tools/list') {
    sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
    return true;
  }

  if (method === 'tools/call') {
    const toolName = typeof params['name'] === 'string' ? params['name'] : '';
    const args = isRecord(params['arguments']) ? (params['arguments'] as Record<string, unknown>) : {};
    if (toolName === '' || TOOLS.every((tool) => tool.name !== toolName)) {
      sendJson(res, 200, rpcError(id, -32602, `Unknown tool: ${toolName}`));
      return true;
    }
    const result = runTool(store, toolName, args);
    sendJson(res, 200, rpcResult(id, result));
    return true;
  }

  sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
  return true;
}
