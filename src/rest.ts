// REST v3: the GitHub API surface the suite exercises — repos, branches, refs,
// commits, contents, labels, issues, pull requests and merges. Every reply is
// JSON with a request id; every route needs the bearer token; a repo under
// another owner is 404, never 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Issue, Label, PullRequest, Repo, Store } from './store.ts';
import { globalId } from './store.ts';
import {
  branchTip,
  commitTree,
  diffCommits,
  lookupPath,
  makeBlob,
  makeCommit,
  mergeTrees,
  reachableCommits,
  refName,
  resolveRef,
  setPathInTree,
} from './vcs.ts';
import { b64decode, b64encode, SCENARIO_VIEWER } from './util.ts';
import { isRecord, parseJsonBody, queryParams, readBody, requestIds, requireAuth, sendError, sendJson } from './http.ts';
import { parseCommit } from './gitobj.ts';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

function userJson(login: string): Record<string, unknown> {
  return { login, id: SCENARIO_VIEWER.id, name: SCENARIO_VIEWER.name, email: SCENARIO_VIEWER.email, type: 'User' };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: new Date((1_735_689_600 + repo.createdSeq) * 1000).toISOString(),
    updated_at: new Date((1_735_689_600 + repo.createdSeq) * 1000).toISOString(),
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description };
}

function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', issue.repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userJson(SCENARIO_VIEWER.login),
    labels: issue.labels.map(labelJson),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

function commentJson(comment: { id: number; body: string; user: string; createdAt: string; updatedAt: string }, repo: Repo, number: number): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', repo.id, comment.id),
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${number}#issuecomment-${comment.id}`,
  };
}

function pullJson(pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', pull.repo.id, pull.number),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userJson(SCENARIO_VIEWER.login),
    head: { ref: pull.headRef, sha: pull.headSha, label: `${pull.repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${pull.repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open',
    draft: false,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://example.invalid/${pull.repo.owner}/${pull.repo.name}/pull/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

interface PageParams {
  readonly perPage: number;
  readonly page: number;
}

function pageParams(params: Map<string, string>): PageParams {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(params.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  return { perPage, page };
}

function pageLinkHeader(req: IncomingMessage, params: Map<string, string>, total: number, perPage: number, page: number): string {
  const host = req.headers.host ?? '127.0.0.1';
  const path = req.url?.split('?')[0] ?? '/';
  const base = `http://${host}${path}`;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const links: string[] = [];
  const build = (pageNumber: number, rel: string): string => {
    const query = new URLSearchParams(params);
    query.set('per_page', String(perPage));
    query.set('page', String(pageNumber));
    return `<${base}?${query.toString()}>; rel="${rel}"`;
  };
  if (page < lastPage) links.push(build(page + 1, 'next'));
  if (lastPage > 1) links.push(build(lastPage, 'last'));
  if (page > 1) {
    links.push(build(1, 'first'));
    links.push(build(page - 1, 'prev'));
  }
  return links.join(', ');
}

function paginate<T>(items: readonly T[], page: PageParams): T[] {
  const start = (page.page - 1) * page.perPage;
  return items.slice(start, start + page.perPage);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The repo a request names, when it exists and belongs to the token's login. */
function ownedRepo(store: Store, owner: string, name: string): Repo | undefined {
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return undefined;
  if (owner !== store.viewer.login) return undefined;
  return repo;
}

/** Parse a JSON body; on failure answer 400 and return null. */
async function readJson(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null | undefined> {
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    sendError(res, 400, 'Bad Request');
    return undefined;
  }
  let value: unknown;
  try {
    value = parseJsonBody(body);
  } catch {
    sendError(res, 400, 'Bad Request');
    return undefined;
  }
  if (value !== null && !isRecord(value)) {
    sendError(res, 400, 'Bad Request');
    return undefined;
  }
  return value as Record<string, unknown> | null;
}

function parseAuthorLine(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <([^>]*)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: '' };
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(Number(match[3]) * 1000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** The REST v3 surface. Returns true when the request was handled here. */
export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  url: URL,
  segments: string[],
): Promise<boolean> {
  if (!requireAuth(req, res)) return true;

  const restSegments = segments.slice(2);
  const params = queryParams(url.search);
  const method = req.method ?? 'GET';
  const scopes = { 'x-oauth-scopes': 'repo, read:org' };

  // GET /api/v3/
  if (restSegments.length === 0) {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, {
      current_user_url: 'https://api.example.invalid/user',
      repository_url: 'https://api.example.invalid/repos/{owner}/{repo}',
      user_repositories_url: 'https://api.example.invalid/user/repos',
    }, scopes);
    return true;
  }

  // GET /api/v3/meta
  if (restSegments.length === 1 && restSegments[0] === 'meta') {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, { installed_version: '1.0.0' }, scopes);
    return true;
  }

  // GET /api/v3/user
  if (restSegments.length === 1 && restSegments[0] === 'user') {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, userJson(store.viewer.login), scopes);
    return true;
  }

  // /api/v3/user/repos
  if (restSegments.length === 2 && restSegments[0] === 'user' && restSegments[1] === 'repos') {
    if (method === 'GET') {
      const all = store.reposOf(store.viewer.login);
      const page = pageParams(params);
      const link = pageLinkHeader(req, params, all.length, page.perPage, page.page);
      sendJson(res, 200, paginate(all, page).map(repoJson), { ...scopes, ...(link === '' ? {} : { link }) });
      return true;
    }
    if (method === 'POST') {
      const body = await readJson(req, res);
      if (body === undefined) return true;
      const name = typeof body?.name === 'string' ? body.name.trim() : '';
      if (name === '' || name.includes('/') || name.includes(' ')) {
        sendError(res, 422, 'Validation Failed: name is invalid');
        return true;
      }
      if (store.getRepo(store.viewer.login, name) !== undefined) {
        sendError(res, 422, 'Validation Failed: name already exists on this account');
        return true;
      }
      const repo = store.createRepo(store.viewer.login, name, {
        description: typeof body?.description === 'string' ? body.description : undefined,
        private: body?.private === true,
      });
      sendJson(res, 201, repoJson(repo), scopes);
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // /api/v3/repos/{owner}/{repo}/...
  if (restSegments.length >= 3 && restSegments[0] === 'repos') {
    const owner = restSegments[1] as string;
    const repoName = restSegments[2] as string;
    const repo = ownedRepo(store, owner, repoName);
    if (repo === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const tail = restSegments.slice(3);
    return handleRepoRoutes(req, res, store, repo, tail, params, method, scopes);
  }

  sendError(res, 404, 'Not Found');
  return true;
}

async function handleRepoRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
  tail: string[],
  params: Map<string, string>,
  method: string,
  scopes: Record<string, string>,
): Promise<boolean> {
  // GET/PATCH/DELETE /repos/{owner}/{repo}
  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo), scopes);
      return true;
    }
    if (method === 'PATCH') {
      const body = await readJson(req, res);
      if (body === undefined) return true;
      if (typeof body?.description === 'string') repo.description = body.description;
      if (typeof body?.private === 'boolean') repo.private = body.private;
      sendJson(res, 200, repoJson(repo), scopes);
      return true;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      res.writeHead(204, { 'x-github-request-id': requestIds.next() });
      res.end();
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // GET /repos/{o}/{r}/branches[/{branch}]
  if (tail[0] === 'branches') {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const branches = [...repo.refs.keys()]
      .filter((name) => name.startsWith('refs/heads/'))
      .map((name) => name.slice('refs/heads/'.length))
      .sort()
      .map((name) => ({ name, commit: { sha: repo.refs.get(refName(name)) as string } }));
    if (tail.length === 1) {
      sendJson(res, 200, branches, scopes);
      return true;
    }
    const branch = tail[1] as string;
    const found = branches.find((item) => item.name === branch);
    if (found === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, found, scopes);
    return true;
  }

  // GET /repos/{o}/{r}/git/refs/heads/{branch}  and  POST /repos/{o}/{r}/git/refs
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (method === 'GET' && tail.length === 4 && tail[2] === 'heads') {
      const branch = tail[3] as string;
      const tip = branchTip(repo, branch);
      if (tip === null) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendJson(res, 200, { ref: refName(branch), object: { sha: tip, type: 'commit' } }, scopes);
      return true;
    }
    if (method === 'POST' && tail.length === 2) {
      const body = await readJson(req, res);
      if (body === undefined) return true;
      const ref = typeof body?.ref === 'string' ? body.ref : '';
      const sha = typeof body?.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/heads/') || ref.length <= 'refs/heads/'.length) {
        sendError(res, 422, 'Validation Failed: ref must name a branch');
        return true;
      }
      const object = repo.objects.get(sha);
      if (object === undefined || object.type !== 'commit') {
        sendError(res, 422, 'Validation Failed: sha does not name a commit');
        return true;
      }
      if (repo.refs.has(ref)) {
        sendError(res, 422, 'Validation Failed: Reference already exists');
        return true;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: 'commit' } }, scopes);
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // GET /repos/{o}/{r}/commits
  if (tail[0] === 'commits' && tail.length === 1) {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const tip = resolveRef(repo, params.get('sha'));
    if (tip === null) {
      sendJson(res, 200, [], scopes);
      return true;
    }
    const commits = reachableCommits(repo, tip).map((oid) => {
      const object = repo.objects.get(oid) as { type: 'commit'; data: Buffer };
      const parsed = parseCommit(object.data);
      const author = parseAuthorLine(parsed.author);
      const committer = parseAuthorLine(parsed.committer);
      return {
        sha: oid,
        commit: {
          // The API trims the trailing newline the object carries.
          message: parsed.message.replace(/\n+$/, ''),
          author: { name: author.name, email: author.email, date: author.date },
          committer: { name: committer.name, email: committer.email, date: committer.date },
          tree: { sha: parsed.tree },
        },
        author: { login: SCENARIO_VIEWER.login },
        committer: { login: SCENARIO_VIEWER.login },
        parents: parsed.parents.map((parent) => ({ sha: parent })),
      };
    });
    const page = pageParams(params);
    sendJson(res, 200, paginate(commits, page), scopes);
    return true;
  }

  // /repos/{o}/{r}/contents[/{path...}]
  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'GET') return getContents(req, res, repo, path, params, scopes);
    if (method === 'PUT') return putContents(req, res, store, repo, path, scopes);
    if (method === 'DELETE') return deleteContents(req, res, store, repo, path, scopes);
    sendError(res, 404, 'Not Found');
    return true;
  }

  // POST /repos/{o}/{r}/labels
  if (tail[0] === 'labels' && tail.length === 1) {
    if (method !== 'POST') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const body = await readJson(req, res);
    if (body === undefined) return true;
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (name === '') {
      sendError(res, 422, 'Validation Failed: name is required');
      return true;
    }
    if (repo.labels.has(name)) {
      sendError(res, 422, 'Validation Failed: label already exists');
      return true;
    }
    const color = typeof body?.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
    const label: Label = { name, color, description: typeof body?.description === 'string' ? body.description : '' };
    repo.labels.set(name, label);
    sendJson(res, 201, labelJson(label), scopes);
    return true;
  }

  // /repos/{o}/{r}/issues...
  if (tail[0] === 'issues') return handleIssueRoutes(req, res, store, repo, tail.slice(1), params, method, scopes);

  // /repos/{o}/{r}/pulls...
  if (tail[0] === 'pulls') return handlePullRoutes(req, res, store, repo, tail.slice(1), params, method, scopes);

  sendError(res, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

async function getContents(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  path: string,
  params: Map<string, string>,
  scopes: Record<string, string>,
): Promise<boolean> {
  const tip = resolveRef(repo, params.get('ref'));
  if (tip === null) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const treeOid = commitTree(repo, tip);
  if (treeOid === null) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  if (path === '') {
    const root = repo.objects.get(treeOid);
    if (root === undefined || root.type !== 'tree') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const entries = parseTree(root.data).map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: entry.name,
      sha: entry.oid,
    }));
    sendJson(res, 200, entries, scopes);
    return true;
  }
  const found = lookupPath(repo, treeOid, path);
  if (found === null) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  if (found.kind === 'dir') {
    const entries = found.entries.map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: `${path}/${entry.name}`,
      sha: entry.oid,
    }));
    sendJson(res, 200, entries, scopes);
    return true;
  }
  const blob = repo.objects.get(found.oid);
  if (blob === undefined || blob.type !== 'blob') {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const name = path.split('/').pop() as string;
  sendJson(res, 200, {
    type: 'file',
    encoding: 'base64',
    content: b64encode(blob.data),
    sha: found.oid,
    size: blob.data.length,
    name,
    path,
  }, scopes);
  return true;
}

async function putContents(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
  path: string,
  scopes: Record<string, string>,
): Promise<boolean> {
  if (path === '') {
    sendError(res, 422, 'Validation Failed: path is required');
    return true;
  }
  const body = await readJson(req, res);
  if (body === undefined) return true;
  const message = typeof body?.message === 'string' ? body.message : 'Update file';
  const content = typeof body?.content === 'string' ? body.content : '';
  if (content === '') {
    sendError(res, 422, 'Validation Failed: content is required');
    return true;
  }
  let contentBytes: Buffer;
  try {
    contentBytes = b64decode(content);
  } catch {
    sendError(res, 422, 'Validation Failed: content is not base64');
    return true;
  }
  const branch = typeof body?.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  // A branch that does not exist is created from the default branch tip (or
  // stays unborn when the repo has no commits yet).
  let tip = branchTip(repo, branch) ?? branchTip(repo, repo.defaultBranch);
  const treeOid = tip === null ? null : commitTree(repo, tip);
  const existing = treeOid === null ? null : lookupPath(repo, treeOid, path);
  if (existing !== null && existing.kind === 'dir') {
    sendError(res, 422, 'Validation Failed: path is a directory');
    return true;
  }
  const isUpdate = existing !== null;
  if (isUpdate) {
    const expectedSha = typeof body?.sha === 'string' ? body.sha : '';
    if (expectedSha === '') {
      sendError(res, 422, 'Validation Failed: sha is required to update a file');
      return true;
    }
    if (expectedSha !== existing.oid) {
      sendError(res, 409, 'Conflict: sha does not match the current file');
      return true;
    }
  }
  const blobOid = makeBlob(store, repo, contentBytes);
  const newTree = setPathInTree(store, repo, treeOid, path, blobOid);
  const parents = tip === null ? [] : [tip];
  const commitOid = makeCommit(store, repo, { tree: newTree, parents, message });
  repo.refs.set(refName(branch), commitOid);
  const name = path.split('/').pop() as string;
  sendJson(res, isUpdate ? 200 : 201, {
    content: { name, path, sha: blobOid, size: contentBytes.length, encoding: 'base64', type: 'file' },
    commit: { sha: commitOid, message },
  }, scopes);
  return true;
}

async function deleteContents(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
  path: string,
  scopes: Record<string, string>,
): Promise<boolean> {
  if (path === '') {
    sendError(res, 422, 'Validation Failed: path is required');
    return true;
  }
  const body = await readJson(req, res);
  if (body === undefined) return true;
  const message = typeof body?.message === 'string' ? body.message : 'Delete file';
  const branch = typeof body?.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const tip = branchTip(repo, branch);
  if (tip === null) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const treeOid = commitTree(repo, tip);
  if (treeOid === null) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const existing = lookupPath(repo, treeOid, path);
  if (existing === null || existing.kind !== 'file') {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const expectedSha = typeof body?.sha === 'string' ? body.sha : '';
  if (expectedSha !== '' && expectedSha !== existing.oid) {
    sendError(res, 409, 'Conflict: sha does not match the current file');
    return true;
  }
  const newTree = setPathInTree(store, repo, treeOid, path, null);
  const commitOid = makeCommit(store, repo, { tree: newTree, parents: [tip], message });
  repo.refs.set(refName(branch), commitOid);
  sendJson(res, 200, { commit: { sha: commitOid, message } }, scopes);
  return true;
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

async function handleIssueRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
  tail: string[],
  params: Map<string, string>,
  method: string,
  scopes: Record<string, string>,
): Promise<boolean> {
  // GET/POST /issues
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = params.get('state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      else if (state !== 'all') {
        sendError(res, 422, 'Validation Failed: state is invalid');
        return true;
      }
      const direction = params.get('direction') ?? 'desc';
      const sort = params.get('sort') ?? 'created';
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      const page = pageParams(params);
      const link = pageLinkHeader(req, params, issues.length, page.perPage, page.page);
      sendJson(res, 200, paginate(issues, page).map(issueJson), { ...scopes, ...(link === '' ? {} : { link }) });
      return true;
    }
    if (method === 'POST') {
      const body = await readJson(req, res);
      if (body === undefined) return true;
      const title = typeof body?.title === 'string' ? body.title.trim() : '';
      if (title === '') {
        sendError(res, 422, 'Validation Failed: title is required');
        return true;
      }
      const labelNames = Array.isArray(body?.labels) ? (body.labels as unknown[]) : [];
      const labels: Label[] = [];
      for (const raw of labelNames) {
        const name = typeof raw === 'string' ? raw : typeof raw === 'object' && raw !== null ? String((raw as Record<string, unknown>).name ?? '') : '';
        const label = repo.labels.get(name);
        if (label === undefined) {
          sendError(res, 422, `Validation Failed: label "${name}" does not exist`);
          return true;
        }
        labels.push(label);
      }
      const issue = store.createIssue(repo, title, typeof body?.body === 'string' ? body.body : '', labels);
      sendJson(res, 201, issueJson(issue), scopes);
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  const number = Number.parseInt(tail[0] as string, 10);
  if (!Number.isInteger(number)) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const issue = repo.issues.get(number);
  if (issue === undefined) {
    sendError(res, 404, 'Not Found');
    return true;
  }

  // GET/PATCH /issues/{n}
  if (tail.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, issueJson(issue), scopes);
      return true;
    }
    if (method === 'PATCH') {
      const body = await readJson(req, res);
      if (body === undefined) return true;
      if (typeof body?.title === 'string') issue.title = body.title;
      if (typeof body?.body === 'string') issue.body = body.body;
      if (body?.state === 'open' || body?.state === 'closed') {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? store.clock.nextIso() : null;
      }
      issue.updatedAt = store.clock.nextIso();
      sendJson(res, 200, issueJson(issue), scopes);
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // GET/POST /issues/{n}/comments
  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((comment) => commentJson(comment, repo, issue.number)), scopes);
      return true;
    }
    if (method === 'POST') {
      const body = await readJson(req, res);
      if (body === undefined) return true;
      const text = typeof body?.body === 'string' ? body.body : '';
      if (text === '') {
        sendError(res, 422, 'Validation Failed: body is required');
        return true;
      }
      const comment = store.createComment(repo, issue, text);
      sendJson(res, 201, commentJson(comment, repo, issue.number), scopes);
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  sendError(res, 404, 'Not Found');
  return true;
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

async function handlePullRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
  tail: string[],
  params: Map<string, string>,
  method: string,
  scopes: Record<string, string>,
): Promise<boolean> {
  // GET/POST /pulls
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = params.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      else if (state !== 'all') {
        sendError(res, 422, 'Validation Failed: state is invalid');
        return true;
      }
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);
      const page = pageParams(params);
      sendJson(res, 200, paginate(pulls, page).map(pullJson), scopes);
      return true;
    }
    if (method === 'POST') {
      const body = await readJson(req, res);
      if (body === undefined) return true;
      const title = typeof body?.title === 'string' ? body.title.trim() : '';
      const head = typeof body?.head === 'string' ? body.head : '';
      const base = typeof body?.base === 'string' ? body.base : '';
      if (title === '' || head === '' || base === '') {
        sendError(res, 422, 'Validation Failed: title, head and base are required');
        return true;
      }
      const headSha = branchTip(repo, head);
      const baseSha = branchTip(repo, base);
      if (headSha === null || baseSha === null) {
        sendError(res, 422, 'Validation Failed: head or base branch does not exist');
        return true;
      }
      const duplicate = [...repo.pulls.values()].some(
        (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
      );
      if (duplicate) {
        sendError(res, 422, 'Validation Failed: a pull request already exists for this head and base');
        return true;
      }
      const pull = store.createPullRequest(
        repo,
        title,
        typeof body?.body === 'string' ? body.body : '',
        head,
        base,
        headSha,
        baseSha,
      );
      sendJson(res, 201, pullJson(pull), scopes);
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  const number = Number.parseInt(tail[0] as string, 10);
  if (!Number.isInteger(number)) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  const pull = repo.pulls.get(number);
  if (pull === undefined) {
    sendError(res, 404, 'Not Found');
    return true;
  }

  // GET /pulls/{n}
  if (tail.length === 1) {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, pullJson(pull), scopes);
    return true;
  }

  // GET /pulls/{n}/files
  if (tail.length === 2 && tail[1] === 'files') {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const changes = diffCommits(repo, pull.baseSha, pull.headSha);
    sendJson(res, 200, changes.map((change) => ({
      filename: change.path,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
    })), scopes);
    return true;
  }

  // PUT /pulls/{n}/merge
  if (tail.length === 2 && tail[1] === 'merge') {
    if (method !== 'PUT') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const body = await readJson(req, res);
    if (body === undefined) return true;
    if (pull.state !== 'open') {
      sendError(res, 405, 'Method Not Allowed: pull request is already closed');
      return true;
    }
    const currentBaseTip = branchTip(repo, pull.baseRef);
    if (currentBaseTip === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const mergedTree = mergeTrees(store, repo, pull.baseSha, pull.headSha, currentBaseTip);
    if (mergedTree === null) {
      sendError(res, 405, 'Method Not Allowed: pull request is conflicted');
      return true;
    }
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    const mergeSha = makeCommit(store, repo, { tree: mergedTree, parents: [currentBaseTip], message });
    repo.refs.set(refName(pull.baseRef), mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = store.clock.nextIso();
    pull.mergeCommitSha = mergeSha;
    pull.updatedAt = store.clock.nextIso();
    sendJson(res, 200, { sha: mergeSha, merged: true, message }, scopes);
    return true;
  }

  sendError(res, 404, 'Not Found');
  return true;
}

// Re-exported for GraphQL/MCP, which share the same shapes.
export { issueJson, pullJson, repoJson, userJson, commentJson };
