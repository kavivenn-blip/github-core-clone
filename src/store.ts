// The one in-memory store every surface reads and writes: git objects and refs,
// issues, pull requests, labels and comments. A repo is a namespace of all of
// those; the forge keeps no other state. Ids and timestamps come from the
// deterministic counters in util.ts, so a replay of the same requests produces
// the same store.

import { Clock, SCENARIO_VIEWER, b64decode, b64encode, type ScenarioUser } from './util.ts';
import type { GitObject, GitObjectType } from './gitobj.ts';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface Repo {
  /** Sequential database id, shared across all repos. */
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  readonly createdSeq: number;
  /** Git objects by oid. */
  readonly objects: Map<string, GitObject>;
  /** Refs by full name, e.g. refs/heads/main. */
  readonly refs: Map<string, string>;
  /** Labels by name. */
  readonly labels: Map<string, Label>;
  /** Issues and pull requests share one per-repo number counter. */
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, PullRequest>;
  nextNumber: number;
  /** Issue/PR ids are globally sequential; comments too. */
  nextCommentId: number;
  /** Creation sequence of every commit made here, for newest-first listing. */
  readonly commitSeq: Map<string, number>;
}

export interface Label {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  readonly repo: Repo;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly labels: Label[];
  readonly comments: Comment[];
  readonly createdSeq: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly user: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  readonly repo: Repo;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  readonly headSha: string;
  /** The base tip at creation: the merge base of every diff and merge. */
  readonly baseSha: string;
  readonly createdSeq: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Opaque global ids (GraphQL node ids). Typed and base64-encoded so a mutation
// can decode the kind, the repo and the number from the id alone.
// ---------------------------------------------------------------------------

export function globalId(kind: 'Repository' | 'Issue' | 'PullRequest' | 'IssueComment', repoId: number, number = 0): string {
  return b64encode(Buffer.from(`${kind}:${repoId}:${number}`, 'utf8'));
}

export function parseGlobalId(id: string): { kind: string; repoId: number; number: number } | null {
  try {
    const text = b64decode(id).toString('utf8');
    const parts = text.split(':');
    if (parts.length !== 3) return null;
    const kind = parts[0] as string;
    const repoId = Number(parts[1]);
    const number = Number(parts[2]);
    if (!Number.isInteger(repoId) || !Number.isInteger(number)) return null;
    return { kind, repoId, number };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The store.
// ---------------------------------------------------------------------------

export class Store {
  readonly clock = new Clock();
  readonly viewer: ScenarioUser = SCENARIO_VIEWER;
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(owner: string, name: string, options: { description?: string; private?: boolean }): Repo {
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: 'main',
      createdSeq: this.clock.current,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      commitSeq: new Map(),
    };
    this.nextRepoId += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** All repos owned by `owner`, in creation order. */
  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    return out;
  }

  nextGlobalIssueId(): number {
    const id = this.nextIssueId;
    this.nextIssueId += 1;
    return id;
  }

  nextGlobalCommentId(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const now = this.clock.nextIso();
    const issue: Issue = {
      id: this.nextGlobalIssueId(),
      number: repo.nextNumber,
      repo,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: this.clock.current,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createComment(repo: Repo, issue: Issue, body: string): Comment {
    const now = this.clock.nextIso();
    const comment: Comment = {
      id: this.nextGlobalCommentId(),
      body,
      user: this.viewer.login,
      createdAt: now,
      updatedAt: now,
    };
    void repo;
    issue.comments.push(comment);
    return comment;
  }

  createPullRequest(repo: Repo, title: string, body: string, headRef: string, baseRef: string, headSha: string, baseSha: string): PullRequest {
    const now = this.clock.nextIso();
    const pull: PullRequest = {
      id: this.nextGlobalIssueId(),
      number: repo.nextNumber,
      repo,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      createdSeq: this.clock.current,
      createdAt: now,
      updatedAt: now,
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** Record that a commit object entered this repo (for newest-first listing). */
  noteCommit(repo: Repo, oid: string): void {
    if (!repo.commitSeq.has(oid)) repo.commitSeq.set(oid, this.clock.current);
  }

  /** Store a git object, and note commits for listing order. */
  putObject(repo: Repo, oid: string, type: GitObjectType, data: Buffer): void {
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    if (type === 'commit') this.noteCommit(repo, oid);
  }
}
