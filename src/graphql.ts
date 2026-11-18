// GraphQL v4: a minimal parser and executor for exactly the documents the
// suite sends (the ones gh and github-mcp-server send). No GraphQL library is
// available, so the parser, the schema and the resolvers are all written here.
// Mutations write to the same store REST reads.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Issue, PullRequest, Repo, Store } from './store.ts';
import { globalId, parseGlobalId } from './store.ts';
import {
  branchTip,
  diffCommits,
  isConflicted,
  makeCommit,
  mergeTrees,
  refName,
} from './vcs.ts';
import { b64decode, b64encode, SCENARIO_VIEWER } from './util.ts';
import { isRecord, parseJsonBody, readBody, requireAuth, sendError, sendJson } from './http.ts';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  readonly alias: string | null;
  readonly name: string;
  readonly args: Array<{ name: string; value: Value }>;
  readonly selections: SelectionNode[] | null;
}

interface FragmentNode {
  readonly typeCondition: string | null;
  readonly selections: SelectionNode[];
}

type SelectionNode = { kind: 'field'; field: FieldNode } | { kind: 'fragment'; fragment: FragmentNode };

interface OperationNode {
  readonly kind: 'query' | 'mutation';
  readonly name: string | null;
  readonly variables: Array<{ name: string; defaultValue: Value | null }>;
  readonly selections: SelectionNode[];
}

interface DocumentNode {
  readonly operations: OperationNode[];
  readonly fragments: Map<string, FragmentNode>;
}

class ParseError extends Error {}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '{' || ch === '}' || ch === '(' || ch === ')' || ch === ':' || ch === '!' || ch === '$' || ch === '=' || ch === '@' || ch === '[' || ch === ']') {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const escaped = source[j + 1] as string;
          out += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          j += 2;
        } else {
          out += source[j] as string;
          j += 1;
        }
      }
      if (j >= source.length) throw new ParseError('unterminated string');
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new ParseError('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new ParseError(`expected ${token} but got ${got}`);
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === 'query' || token === 'mutation') {
        operations.push(this.parseOperation());
      } else if (token === '{') {
        operations.push({ kind: 'query', name: null, variables: [], selections: this.parseSelectionSet() });
      } else if (token === 'fragment') {
        this.next();
        const name = this.next();
        this.expect('on');
        const typeCondition = this.next();
        fragments.set(name, { typeCondition, selections: this.parseSelectionSet() });
      } else {
        throw new ParseError(`unexpected token ${JSON.stringify(token)}`);
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    const kind = this.next() as 'query' | 'mutation';
    let name: string | null = null;
    const next = this.peek();
    if (next !== undefined && next !== '(' && next !== '{' && /^[A-Za-z_]/.test(next)) name = this.next();
    const variables: Array<{ name: string; defaultValue: Value | null }> = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        this.expect('$');
        const varName = this.next();
        this.expect(':');
        this.parseTypeName();
        let defaultValue: Value | null = null;
        if (this.peek() === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variables.push({ name: varName, defaultValue });
        if (this.peek() === ',') this.next();
      }
      this.expect(')');
    }
    return { kind, name, variables, selections: this.parseSelectionSet() };
  }

  private parseTypeName(): void {
    let token = this.next();
    if (token === '[') {
      this.parseTypeName();
      this.expect(']');
      token = this.peek() as string;
    }
    if (this.peek() === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === undefined) throw new ParseError('unterminated selection set');
      if (this.peek() === '...') {
        this.next();
        const next = this.peek();
        if (next === 'on') {
          this.next();
          const typeCondition = this.next();
          selections.push({ kind: 'fragment', fragment: { typeCondition, selections: this.parseSelectionSet() } });
        } else {
          const name = this.next();
          selections.push({ kind: 'fragment', fragment: { typeCondition: null, selections: [] } });
          void name;
        }
      } else {
        selections.push({ kind: 'field', field: this.parseField() });
      }
    }
    this.expect('}');
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Array<{ name: string; value: Value }> = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
        if (this.peek() === ',') this.next();
      }
      this.expect(')');
    }
    // Directives (e.g. @include) are accepted and ignored.
    while (this.peek() === '@') {
      this.next();
      this.next();
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') this.next();
        this.expect(')');
      }
    }
    const selections = this.peek() === '{' ? this.parseSelectionSet() : null;
    return { alias, name, args, selections };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const values: Value[] = [];
      while (this.peek() !== ']') {
        values.push(this.parseValue());
        if (this.peek() === ',') this.next();
      }
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
        if (this.peek() === ',') this.next();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(token)) return { kind: 'float', value: Number.parseFloat(token) };
    return { kind: 'enum', value: token };
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

interface TypeDef {
  readonly kind: 'OBJECT' | 'ENUM' | 'SCALAR';
  readonly fields?: readonly string[];
  readonly values?: readonly string[];
}

const SCHEMA: Record<string, TypeDef> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url', 'description', 'private', 'createdAt', 'updatedAt'],
  },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'closedAt', 'repository', 'comments', 'url'] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'merged', 'mergedAt', 'files', 'author', 'createdAt', 'updatedAt', 'closedAt', 'repository', 'url'],
  },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'author', 'createdAt', 'updatedAt'] },
  Ref: { kind: 'OBJECT', fields: ['name'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueCommentConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestChangedFileEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes', 'ofType'] },
  __Field: { kind: 'OBJECT', fields: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name', 'description', 'isDeprecated', 'deprecationReason'] },
  __InputValue: { kind: 'OBJECT', fields: ['name', 'description', 'type', 'defaultValue'] },
  __Schema: { kind: 'OBJECT', fields: ['queryType', 'mutationType', 'types', 'directives'] },
  SearchType: { kind: 'ENUM', values: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'LABEL', 'CODE', 'PACKAGE'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'clientMutationId'] },
  IssueState: { kind: 'ENUM', values: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', values: ['OPEN', 'CLOSED', 'MERGED'] },
  PullRequestMergeableState: { kind: 'ENUM', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  OrderDirection: { kind: 'ENUM', values: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface GraphValue {
  readonly __typename: string;
  readonly [key: string]: unknown;
}

interface ExecContext {
  readonly store: Store;
  readonly errors: Array<{ message: string }>;
}

type Variables = Record<string, unknown>;

function resolveValue(value: Value, variables: Variables): unknown {
  switch (value.kind) {
    case 'variable': {
      return variables[value.name] ?? null;
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function argValue(field: FieldNode, name: string, variables: Variables): unknown {
  const arg = field.args.find((item) => item.name === name);
  if (arg === undefined) return undefined;
  return resolveValue(arg.value, variables);
}

function cursorFor(number: number): string {
  return b64encode(Buffer.from(`cursor:${number}`, 'utf8'));
}

function numberFromCursor(cursor: string | null | undefined): number | null {
  if (cursor === null || cursor === undefined || cursor === '') return null;
  try {
    const text = b64decode(cursor).toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const number = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isInteger(number) ? number : null;
  } catch {
    return null;
  }
}

/** A connection over an already-ordered list, with first/after pagination. */
function paginateConnection(
  items: readonly { number: number; value: GraphValue }[],
  field: FieldNode,
  variables: Variables,
  typename: string,
): GraphValue {
  const first = argValue(field, 'first', variables);
  const after = argValue(field, 'after', variables);
  const afterNumber = typeof after === 'string' ? numberFromCursor(after) : null;
  const orderBy = argValue(field, 'orderBy', variables);
  const ascending = isRecord(orderBy) && orderBy['direction'] === 'ASC';
  let filtered = items;
  if (afterNumber !== null) {
    filtered = ascending ? items.filter((item) => item.number > afterNumber) : items.filter((item) => item.number < afterNumber);
  }
  const take = typeof first === 'number' ? first : filtered.length;
  const page = filtered.slice(0, take);
  const hasNextPage = filtered.length > page.length;
  const endCursor = page.length === 0 ? null : cursorFor(page[page.length - 1]?.number as number);
  return {
    __typename: typename,
    nodes: page.map((item) => item.value),
    edges: page.map((item) => ({ __typename: typename.replace('Connection', 'Edge'), node: item.value, cursor: cursorFor(item.number) })),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: afterNumber !== null,
      startCursor: page.length === 0 ? null : cursorFor(page[0]?.number as number),
      endCursor,
    },
    totalCount: items.length,
  };
}

function userValue(login: string): GraphValue {
  return {
    __typename: 'User',
    id: b64encode(Buffer.from(`User:${SCENARIO_VIEWER.id}:0`, 'utf8')),
    login,
    name: SCENARIO_VIEWER.name,
    email: SCENARIO_VIEWER.email,
  };
}

function repoValue(repo: Repo): GraphValue {
  return { __typename: 'Repository', repo };
}

function issueValue(repo: Repo, issue: Issue): GraphValue {
  return { __typename: 'Issue', repo, issue };
}

function pullValue(repo: Repo, pull: PullRequest): GraphValue {
  return { __typename: 'PullRequest', repo, pull };
}

function orderIssues(issues: Issue[], orderBy: unknown): Issue[] {
  const sorted = [...issues].sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
  if (isRecord(orderBy)) {
    const direction = orderBy['direction'];
    if (direction === 'ASC') sorted.reverse();
  }
  return sorted;
}

function orderPulls(pulls: PullRequest[], orderBy: unknown): PullRequest[] {
  const sorted = [...pulls].sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
  if (isRecord(orderBy)) {
    const direction = orderBy['direction'];
    if (direction === 'ASC') sorted.reverse();
  }
  return sorted;
}

/** Resolve one field of a value. Returns undefined when the field is unknown (error recorded). */
function resolveField(ctx: ExecContext, value: GraphValue, field: FieldNode, variables: Variables): unknown {
  const typename = value.__typename;
  const name = field.name;

  // Introspection meta-fields are available on every type.
  if (name === '__typename') return typename;

  if (typename === 'Query') {
    if (name === 'viewer') return userValue(ctx.store.viewer.login);
    if (name === 'repository') {
      const owner = argValue(field, 'owner', variables);
      const repoName = argValue(field, 'name', variables);
      if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
      const repo = ctx.store.getRepo(owner, repoName);
      if (repo === undefined || repo.owner !== ctx.store.viewer.login) return null;
      return repoValue(repo);
    }
    if (name === 'node') {
      const id = argValue(field, 'id', variables);
      if (typeof id !== 'string') return null;
      const parsed = parseGlobalId(id);
      if (parsed === null) return null;
      const repo = [...ctx.store.repos.values()].find((item) => item.id === parsed.repoId);
      if (repo === undefined) return null;
      if (parsed.kind === 'Repository') return repoValue(repo);
      if (parsed.kind === 'Issue') {
        const issue = repo.issues.get(parsed.number);
        return issue === undefined ? null : issueValue(repo, issue);
      }
      if (parsed.kind === 'PullRequest') {
        const pull = repo.pulls.get(parsed.number);
        return pull === undefined ? null : pullValue(repo, pull);
      }
      return null;
    }
    if (name === '__type') {
      const typeName = argValue(field, 'name', variables);
      if (typeof typeName !== 'string') return null;
      const def = SCHEMA[typeName];
      if (def === undefined) return null;
      return introspectionType(typeName, def);
    }
    if (name === '__schema') {
      return {
        __typename: '__Schema',
        queryType: { __typename: '__Type', name: 'Query', kind: 'OBJECT' },
        mutationType: { __typename: '__Type', name: 'Mutation', kind: 'OBJECT' },
        types: Object.keys(SCHEMA).map((typeName) => introspectionType(typeName, SCHEMA[typeName] as TypeDef)),
        directives: [],
      };
    }
    return undefined;
  }

  if (typename === 'Mutation') {
    return resolveMutation(ctx, field, variables);
  }

  if (typename === 'User') {
    if (name === 'id') return value['id'] as string;
    if (name === 'login') return value['login'] as string;
    if (name === 'name') return value['name'] as string;
    if (name === 'email') return value['email'] as string;
    return undefined;
  }

  if (typename === 'Repository') {
    const repo = value['repo'] as Repo;
    switch (name) {
      case 'id': return globalId('Repository', repo.id);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
      case 'owner': return userValue(repo.owner);
      case 'defaultBranchRef': {
        const tip = branchTip(repo, repo.defaultBranch);
        if (tip === null) return null;
        return { __typename: 'Ref', name: repo.defaultBranch };
      }
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'url': return `https://example.invalid/${repo.owner}/${repo.name}`;
      case 'description': return repo.description;
      case 'private': return repo.private;
      case 'createdAt': return new Date((1_735_689_600 + repo.createdSeq) * 1000).toISOString();
      case 'updatedAt': return new Date((1_735_689_600 + repo.createdSeq) * 1000).toISOString();
      case 'issue': {
        const number = argValue(field, 'number', variables);
        if (typeof number !== 'number') return null;
        const issue = repo.issues.get(number);
        return issue === undefined ? null : issueValue(repo, issue);
      }
      case 'issues': {
        let issues = [...repo.issues.values()];
        const states = argValue(field, 'states', variables);
        if (Array.isArray(states)) {
          const wanted = new Set(states.map((state) => String(state)));
          issues = issues.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
        }
        const ordered = orderIssues(issues, argValue(field, 'orderBy', variables));
        return paginateConnection(
          ordered.map((issue) => ({ number: issue.number, value: issueValue(repo, issue) })),
          field,
          variables,
          'IssueConnection',
        );
      }
      case 'pullRequest': {
        const number = argValue(field, 'number', variables);
        if (typeof number !== 'number') return null;
        const pull = repo.pulls.get(number);
        return pull === undefined ? null : pullValue(repo, pull);
      }
      case 'pullRequests': {
        let pulls = [...repo.pulls.values()];
        const states = argValue(field, 'states', variables);
        if (Array.isArray(states)) {
          const wanted = new Set(states.map((state) => String(state)));
          pulls = pulls.filter((pull) => {
            const state = pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
            return wanted.has(state);
          });
        }
        const ordered = orderPulls(pulls, argValue(field, 'orderBy', variables));
        return paginateConnection(
          ordered.map((pull) => ({ number: pull.number, value: pullValue(repo, pull) })),
          field,
          variables,
          'PullRequestConnection',
        );
      }
      default: return undefined;
    }
  }

  if (typename === 'Issue') {
    const repo = value['repo'] as Repo;
    const issue = value['issue'] as Issue;
    switch (name) {
      case 'id': return globalId('Issue', repo.id, issue.number);
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'body': return issue.body;
      case 'author': return userValue(SCENARIO_VIEWER.login);
      case 'createdAt': return issue.createdAt;
      case 'updatedAt': return issue.updatedAt;
      case 'closedAt': return issue.closedAt;
      case 'repository': return repoValue(repo);
      case 'url': return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'comments': {
        const comments = issue.comments.map((comment) => ({
          __typename: 'IssueComment',
          id: globalId('IssueComment', repo.id, comment.id),
          body: comment.body,
          author: userValue(comment.user),
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
        }));
        return {
          __typename: 'IssueCommentConnection',
          nodes: comments,
          edges: comments.map((node) => ({ __typename: 'IssueCommentEdge', node, cursor: cursorFor(commentIdNumber(node)) })),
          pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
          totalCount: comments.length,
        };
      }
      default: return undefined;
    }
  }

  if (typename === 'PullRequest') {
    const repo = value['repo'] as Repo;
    const pull = value['pull'] as PullRequest;
    switch (name) {
      case 'id': return globalId('PullRequest', repo.id, pull.number);
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'state': return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'body': return pull.body;
      case 'headRefName': return pull.headRef;
      case 'baseRefName': return pull.baseRef;
      case 'headRefOid': return pull.headSha;
      case 'baseRefOid': return pull.baseSha;
      case 'mergeable': {
        if (pull.state !== 'open') return 'UNKNOWN';
        const currentBaseTip = branchTip(repo, pull.baseRef);
        if (currentBaseTip === null) return 'UNKNOWN';
        return isConflicted(repo, pull.baseSha, pull.headSha, currentBaseTip) ? 'CONFLICTING' : 'MERGEABLE';
      }
      case 'merged': return pull.merged;
      case 'mergedAt': return pull.mergedAt;
      case 'author': return userValue(SCENARIO_VIEWER.login);
      case 'createdAt': return pull.createdAt;
      case 'updatedAt': return pull.updatedAt;
      case 'closedAt': return pull.state === 'closed' ? pull.updatedAt : null;
      case 'repository': return repoValue(repo);
      case 'url': return `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'files': {
        const changes = diffCommits(repo, pull.baseSha, pull.headSha);
        const nodes = changes.map((change) => ({
          __typename: 'PullRequestChangedFile',
          path: change.path,
          additions: change.additions,
          deletions: change.deletions,
          changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'REMOVED' : 'MODIFIED',
        }));
        return {
          __typename: 'PullRequestChangedFileConnection',
          nodes,
          edges: nodes.map((node, index) => ({ __typename: 'PullRequestChangedFileEdge', node, cursor: cursorFor(index + 1) })),
          pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
          totalCount: nodes.length,
        };
      }
      default: return undefined;
    }
  }

  if (typename === 'IssueComment') {
    if (name === 'id') return value['id'] as string;
    if (name === 'body') return value['body'] as string;
    if (name === 'author') return value['author'] as GraphValue;
    if (name === 'createdAt') return value['createdAt'] as string;
    if (name === 'updatedAt') return value['updatedAt'] as string;
    return undefined;
  }

  if (typename === 'Ref') {
    if (name === 'name') return value['name'] as string;
    return undefined;
  }

  if (typename.endsWith('Connection')) {
    if (name === 'nodes') return value['nodes'] as unknown[];
    if (name === 'edges') return value['edges'] as unknown[];
    if (name === 'pageInfo') return value['pageInfo'] as GraphValue;
    if (name === 'totalCount') return value['totalCount'] as number;
    return undefined;
  }

  if (typename.endsWith('Edge')) {
    if (name === 'node') return value['node'] as GraphValue;
    if (name === 'cursor') return value['cursor'] as string;
    return undefined;
  }

  if (typename === 'PageInfo') {
    if (name === 'hasNextPage') return value['hasNextPage'] as boolean;
    if (name === 'hasPreviousPage') return value['hasPreviousPage'] as boolean;
    if (name === 'startCursor') return value['startCursor'] as string | null;
    if (name === 'endCursor') return value['endCursor'] as string | null;
    return undefined;
  }

  if (typename === '__Type') {
    if (name === 'name') return value['name'] as string;
    if (name === 'kind') return value['kind'] as string;
    if (name === 'description') return value['description'] as string | null;
    if (name === 'fields') {
      const fields = value['fields'] as GraphValue[] | null;
      return fields;
    }
    if (name === 'enumValues') return value['enumValues'] as GraphValue[] | null;
    if (name === 'inputFields') return null;
    if (name === 'interfaces') return [];
    if (name === 'possibleTypes') return null;
    if (name === 'ofType') return null;
    return undefined;
  }

  if (typename === '__Field') {
    if (name === 'name') return value['name'] as string;
    if (name === 'description') return null;
    if (name === 'args') return [];
    if (name === 'type') return { __typename: '__Type', name: 'String', kind: 'SCALAR' };
    if (name === 'isDeprecated') return false;
    if (name === 'deprecationReason') return null;
    return undefined;
  }

  if (typename === '__EnumValue') {
    if (name === 'name') return value['name'] as string;
    if (name === 'description') return null;
    if (name === 'isDeprecated') return false;
    if (name === 'deprecationReason') return null;
    return undefined;
  }

  if (typename === '__Schema') {
    if (name === 'queryType') return value['queryType'] as GraphValue;
    if (name === 'mutationType') return value['mutationType'] as GraphValue;
    if (name === 'types') return value['types'] as GraphValue[];
    if (name === 'directives') return [];
    return undefined;
  }

  if (typename === 'PullRequestChangedFile') {
    if (name === 'path') return value['path'] as string;
    if (name === 'additions') return value['additions'] as number;
    if (name === 'deletions') return value['deletions'] as number;
    if (name === 'changeType') return value['changeType'] as string;
    return undefined;
  }

  // Mutation payloads carry the created object under a field of the same name.
  if (typename.endsWith('Payload')) {
    if (name in value) return value[name];
    return undefined;
  }

  return undefined;
}

function commentIdNumber(node: GraphValue): number {
  const id = node['id'] as string;
  const parsed = parseGlobalId(id);
  return parsed === null ? 0 : parsed.number;
}

function introspectionType(typeName: string, def: TypeDef): GraphValue {
  const fields = def.fields === undefined ? null : def.fields.map((name) => ({
    __typename: '__Field',
    name,
  }));
  const enumValues = def.values === undefined ? null : def.values.map((name) => ({
    __typename: '__EnumValue',
    name,
  }));
  return {
    __typename: '__Type',
    name: typeName,
    kind: def.kind,
    description: null,
    fields,
    enumValues,
  };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function resolveMutation(ctx: ExecContext, field: FieldNode, variables: Variables): unknown {
  const input = argValue(field, 'input', variables);
  if (!isRecord(input)) {
    ctx.errors.push({ message: `Mutation ${field.name} requires an input object.` });
    return null;
  }
  const store = ctx.store;

  if (field.name === 'createIssue') {
    const repositoryId = input['repositoryId'];
    const title = input['title'];
    if (typeof repositoryId !== 'string' || typeof title !== 'string' || title === '') {
      ctx.errors.push({ message: 'createIssue requires repositoryId and title.' });
      return null;
    }
    const parsed = parseGlobalId(repositoryId);
    const repo = parsed === null ? undefined : [...store.repos.values()].find((item) => item.id === parsed.repoId);
    if (repo === undefined) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
      return null;
    }
    const issue = store.createIssue(repo, title, typeof input['body'] === 'string' ? input['body'] : '', []);
    return { __typename: 'CreateIssuePayload', issue: issueValue(repo, issue), clientMutationId: null };
  }

  if (field.name === 'closeIssue') {
    const issueId = input['issueId'];
    if (typeof issueId !== 'string') {
      ctx.errors.push({ message: 'closeIssue requires issueId.' });
      return null;
    }
    const parsed = parseGlobalId(issueId);
    const repo = parsed === null ? undefined : [...store.repos.values()].find((item) => item.id === parsed.repoId);
    const issue = repo === undefined ? undefined : repo.issues.get(parsed?.number ?? -1);
    if (issue === undefined) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
      return null;
    }
    issue.state = 'closed';
    issue.closedAt = store.clock.nextIso();
    issue.updatedAt = store.clock.nextIso();
    return { __typename: 'CloseIssuePayload', issue: issueValue(repo, issue), clientMutationId: null };
  }

  if (field.name === 'createPullRequest') {
    const repositoryId = input['repositoryId'];
    const baseRefName = input['baseRefName'];
    const headRefName = input['headRefName'];
    const title = input['title'];
    if (typeof repositoryId !== 'string' || typeof baseRefName !== 'string' || typeof headRefName !== 'string' || typeof title !== 'string') {
      ctx.errors.push({ message: 'createPullRequest requires repositoryId, baseRefName, headRefName and title.' });
      return null;
    }
    const parsed = parseGlobalId(repositoryId);
    const repo = parsed === null ? undefined : [...store.repos.values()].find((item) => item.id === parsed.repoId);
    if (repo === undefined) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
      return null;
    }
    const headSha = branchTip(repo, headRefName);
    const baseSha = branchTip(repo, baseRefName);
    if (headSha === null || baseSha === null) {
      ctx.errors.push({ message: 'Head or base branch does not exist.' });
      return null;
    }
    const duplicate = [...repo.pulls.values()].some(
      (pull) => pull.state === 'open' && pull.headRef === headRefName && pull.baseRef === baseRefName,
    );
    if (duplicate) {
      ctx.errors.push({ message: 'A pull request already exists for this head and base.' });
      return null;
    }
    const pull = store.createPullRequest(repo, title, '', headRefName, baseRefName, headSha, baseSha);
    return { __typename: 'CreatePullRequestPayload', pullRequest: pullValue(repo, pull), clientMutationId: null };
  }

  if (field.name === 'mergePullRequest') {
    const pullRequestId = input['pullRequestId'];
    if (typeof pullRequestId !== 'string') {
      ctx.errors.push({ message: 'mergePullRequest requires pullRequestId.' });
      return null;
    }
    const parsed = parseGlobalId(pullRequestId);
    const repo = parsed === null ? undefined : [...store.repos.values()].find((item) => item.id === parsed.repoId);
    const pull = repo === undefined ? undefined : repo.pulls.get(parsed?.number ?? -1);
    if (pull === undefined || repo === undefined) {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest with the provided id.' });
      return null;
    }
    if (pull.state !== 'open') {
      ctx.errors.push({ message: 'Pull request is already closed.' });
      return null;
    }
    const currentBaseTip = branchTip(repo, pull.baseRef);
    if (currentBaseTip === null) {
      ctx.errors.push({ message: 'Base branch does not exist.' });
      return null;
    }
    const mergedTree = mergeTrees(store, repo, pull.baseSha, pull.headSha, currentBaseTip);
    if (mergedTree === null) {
      ctx.errors.push({ message: 'Pull request is conflicted.' });
      return null;
    }
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    const mergeSha = makeCommit(store, repo, { tree: mergedTree, parents: [currentBaseTip], message });
    repo.refs.set(refName(pull.baseRef), mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = store.clock.nextIso();
    pull.mergeCommitSha = mergeSha;
    pull.updatedAt = store.clock.nextIso();
    return { __typename: 'MergePullRequestPayload', pullRequest: pullValue(repo, pull), clientMutationId: null };
  }

  if (field.name === 'addComment') {
    const subjectId = input['subjectId'];
    const body = input['body'];
    if (typeof subjectId !== 'string' || typeof body !== 'string') {
      ctx.errors.push({ message: 'addComment requires subjectId and body.' });
      return null;
    }
    const parsed = parseGlobalId(subjectId);
    const repo = parsed === null ? undefined : [...store.repos.values()].find((item) => item.id === parsed.repoId);
    const issue = repo === undefined ? undefined : repo.issues.get(parsed?.number ?? -1);
    if (issue === undefined || repo === undefined) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
      return null;
    }
    const comment = store.createComment(repo, issue, body);
    const node: GraphValue = {
      __typename: 'IssueComment',
      id: globalId('IssueComment', repo.id, comment.id),
      body: comment.body,
      author: userValue(comment.user),
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    };
    return {
      __typename: 'AddCommentPayload',
      commentEdge: { __typename: 'IssueCommentEdge', node, cursor: cursorFor(comment.id) },
      clientMutationId: null,
    };
  }

  return undefined;
}

/** Execute a selection set against a value, collecting field errors. */
function executeSelections(
  ctx: ExecContext,
  value: GraphValue,
  selections: SelectionNode[],
  variables: Variables,
  document: DocumentNode,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      const fragment = selection.fragment;
      if (fragment.typeCondition !== null && fragment.typeCondition !== value.__typename) continue;
      const nested = executeSelections(ctx, value, fragment.selections, variables, document);
      Object.assign(out, nested);
      continue;
    }
    const field = selection.field;
    const responseKey = field.alias ?? field.name;
    const resolved = resolveField(ctx, value, field, variables);
    if (resolved === undefined) {
      // Unknown field on this type.
      const known = SCHEMA[value.__typename]?.fields ?? [];
      if (!known.includes(field.name) && field.name !== '__typename') {
        ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${value.__typename}".` });
        return out;
      }
      continue;
    }
    if (field.selections === null) {
      out[responseKey] = resolved;
    } else if (resolved === null) {
      out[responseKey] = null;
    } else if (Array.isArray(resolved)) {
      out[responseKey] = resolved.map((item) => {
        if (item !== null && typeof item === 'object' && '__typename' in (item as Record<string, unknown>)) {
          return executeSelections(ctx, item as GraphValue, field.selections as SelectionNode[], variables, document);
        }
        return item;
      });
    } else if (typeof resolved === 'object') {
      const resolvedValue = resolved as GraphValue;
      if ('__typename' in resolvedValue) {
        out[responseKey] = executeSelections(ctx, resolvedValue, field.selections, variables, document);
      } else {
        out[responseKey] = resolved;
      }
    } else {
      out[responseKey] = resolved;
    }
  }
  return out;
}

/** Execute one operation document against the store. */
function executeOperation(ctx: ExecContext, document: DocumentNode, operation: OperationNode, variables: Variables): Record<string, unknown> {
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: GraphValue = { __typename: rootType };
  const data = executeSelections(ctx, root, operation.selections, variables, document);
  if (ctx.errors.length > 0) {
    // A validation error (unknown field) nulls the data, per the spec.
    const hasFieldError = ctx.errors.some((error) => error.message.startsWith('Cannot query field'));
    if (hasFieldError) return { data: null, errors: ctx.errors };
  }
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result['errors'] = ctx.errors;
  return result;
}

/** Execute a whole GraphQL request body (one operation, or an array of them). */
export function executeGraphQL(store: Store, body: unknown): unknown {
  const run = (single: Record<string, unknown>): Record<string, unknown> => {
    const query = typeof single['query'] === 'string' ? single.query : '';
    const variables = isRecord(single['variables']) ? (single['variables'] as Variables) : {};
    const operationName = typeof single['operationName'] === 'string' ? single.operationName : null;
    let document: DocumentNode;
    try {
      document = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax Error' }] };
    }
    if (document.operations.length === 0) {
      return { data: null, errors: [{ message: 'Must provide an operation.' }] };
    }
    let operation = document.operations[0] as OperationNode;
    if (operationName !== null) {
      const named = document.operations.find((item) => item.name === operationName);
      if (named !== undefined) operation = named;
    }
    const ctx: ExecContext = { store, errors: [] };
    // Operation-level variable defaults.
    const mergedVariables: Variables = { ...variables };
    for (const variable of operation.variables) {
      if (mergedVariables[variable.name] === undefined && variable.defaultValue !== null) {
        mergedVariables[variable.name] = resolveValue(variable.defaultValue, mergedVariables);
      }
    }
    return executeOperation(ctx, document, operation, mergedVariables);
  };

  if (Array.isArray(body)) {
    return body.map((item) => (isRecord(item) ? run(item) : { data: null, errors: [{ message: 'Invalid operation.' }] }));
  }
  if (isRecord(body)) return run(body);
  return { data: null, errors: [{ message: 'Request body must be a JSON object.' }] };
}

// ---------------------------------------------------------------------------
// HTTP entry point
// ---------------------------------------------------------------------------

/** POST /api/graphql. Returns true when the request was handled here. */
export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  if (!requireAuth(req, res)) return true;
  if (req.method !== 'POST') {
    sendError(res, 404, 'Not Found');
    return true;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendError(res, 400, 'Bad Request');
    return true;
  }
  let body: unknown;
  try {
    body = parseJsonBody(raw);
  } catch {
    sendError(res, 400, 'Bad Request');
    return true;
  }
  const result = executeGraphQL(store, body);
  sendJson(res, 200, result);
  return true;
}
