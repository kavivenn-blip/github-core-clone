// The version-control operations the REST contents and pulls surfaces share:
// resolving a ref to a commit, reading and writing trees, creating commits,
// diffing two trees, and three-way merging a pull request. All of it works on
// the store's git objects, so anything it creates is visible to clone and fetch.

import { SCENARIO_VIEWER } from './util.ts';
import type { Repo, Store } from './store.ts';
import {
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTree,
  peelToCommit,
  type GitObject,
  type TreeEntry,
} from './gitobj.ts';
import { ZERO_OID, isOid } from './util.ts';

/** A ref as the REST surface names it, e.g. refs/heads/main. */
export function refName(branch: string): string {
  return `refs/heads/${branch}`;
}

/** The commit a branch name points at, or null. */
export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(refName(branch)) ?? null;
}

/** Resolve a ref argument (branch name, or a 40-hex commit id) to a commit oid. */
export function resolveRef(repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return branchTip(repo, repo.defaultBranch);
  const byBranch = branchTip(repo, ref);
  if (byBranch !== null) return byBranch;
  if (isOid(ref)) {
    const object = repo.objects.get(ref);
    if (object !== undefined && object.type === 'commit') return ref;
    if (object !== undefined && object.type === 'tag') return peelToCommit(ref, (oid) => repo.objects.get(oid));
  }
  return null;
}

/** The tree oid of a commit. */
export function commitTree(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** All commits reachable from `tip`, newest first (creation order, then oid for ties). */
export function reachableCommits(repo: Repo, tip: string): string[] {
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return [...seen].sort((a, b) => {
    const sa = repo.commitSeq.get(a) ?? 0;
    const sb = repo.commitSeq.get(b) ?? 0;
    if (sa !== sb) return sb - sa;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** The merge base of two commits: the first common ancestor found walking both histories. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const fromA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const oid = queueA.pop() as string;
    if (fromA.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    fromA.add(oid);
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const oid = queueB.pop() as string;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (fromA.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

/** Flatten a tree into path -> {mode, oid} for files (blobs only; dirs implied). */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [sub, value] of flattenTree(repo, entry.oid, path)) out.set(sub, value);
    } else if (entry.mode !== '160000') {
      out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  }
  return out;
}

/**
 * Set one path in a tree (creating intermediate trees) or remove it, and store
 * every new tree object. Returns the new root tree oid.
 */
export function setPathInTree(
  store: Store,
  repo: Repo,
  treeOid: string | null,
  path: string,
  blobOid: string | null,
  mode = '100644',
): string {
  const parts = path.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0) throw new Error('path is empty');

  const setIn = (current: string | null, depth: number): string => {
    const entries: TreeEntry[] = current === null ? [] : parseTree(repo.objects.get(current)?.data ?? Buffer.alloc(0));
    const name = parts[depth] as string;
    const isLast = depth === parts.length - 1;
    const next: TreeEntry[] = [];
    let handled = false;
    for (const entry of entries) {
      if (entry.name !== name) {
        next.push(entry);
        continue;
      }
      handled = true;
      if (isLast) {
        if (blobOid !== null) next.push({ mode, name, oid: blobOid });
        // else: drop the entry (delete).
      } else {
        const child = entry.mode === '40000' ? entry.oid : null;
        const childOid = setIn(child, depth + 1);
        // Prune a directory a deletion emptied: git keeps no empty trees.
        if (blobOid === null) {
          const childObject = repo.objects.get(childOid);
          if (childObject !== undefined && childObject.type === 'tree' && parseTree(childObject.data).length === 0) {
            continue;
          }
        }
        next.push({ mode: '40000', name, oid: childOid });
      }
    }
    if (!handled) {
      if (isLast) {
        if (blobOid !== null) next.push({ mode, name, oid: blobOid });
      } else {
        next.push({ mode: '40000', name, oid: setIn(null, depth + 1) });
      }
    }
    const data = buildTree(next);
    const oid = hashObject('tree', data);
    store.putObject(repo, oid, 'tree', data);
    return oid;
  };

  return setIn(treeOid, 0);
}

/** Read one path from a tree: the blob entry, or the subtree's entries for a directory. */
export function lookupPath(
  repo: Repo,
  treeOid: string,
  path: string,
): { kind: 'file'; mode: string; oid: string } | { kind: 'dir'; entries: TreeEntry[] } | null {
  const parts = path.split('/').filter((part) => part !== '' && part !== '.');
  let current = treeOid;
  for (let depth = 0; depth < parts.length; depth += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entries = parseTree(object.data);
    const entry = entries.find((item) => item.name === parts[depth]);
    if (entry === undefined) return null;
    const isLast = depth === parts.length - 1;
    if (isLast) {
      if (entry.mode === '40000') {
        const dirObject = repo.objects.get(entry.oid);
        if (dirObject === undefined || dirObject.type !== 'tree') return null;
        return { kind: 'dir', entries: parseTree(dirObject.data) };
      }
      return { kind: 'file', mode: entry.mode, oid: entry.oid };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  const rootObject = repo.objects.get(current);
  if (rootObject === undefined || rootObject.type !== 'tree') return null;
  return { kind: 'dir', entries: parseTree(rootObject.data) };
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

/** The identity a commit made through the API carries: the token's login. */
export function apiIdentity(): string {
  const viewer = SCENARIO_VIEWER;
  return `${viewer.name} <${viewer.email}>`;
}

/** Create and store a commit object; returns its oid. */
export function makeCommit(
  store: Store,
  repo: Repo,
  options: { tree: string; parents: string[]; message: string },
): string {
  const timestamp = store.clock.nextEpochSec();
  const identity = apiIdentity();
  const data = buildCommit({
    tree: options.tree,
    parents: options.parents,
    author: identity,
    committer: identity,
    timestamp,
    message: options.message.endsWith('\n') ? options.message : `${options.message}\n`,
  });
  const oid = hashObject('commit', data);
  store.putObject(repo, oid, 'commit', data);
  return oid;
}

/** Store a blob object; returns its oid. */
export function makeBlob(store: Store, repo: Repo, content: Buffer): string {
  const oid = hashObject('blob', content);
  store.putObject(repo, oid, 'blob', content);
  return oid;
}

// ---------------------------------------------------------------------------
// Diffs and merges
// ---------------------------------------------------------------------------

export interface FileChange {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly oldOid: string | null;
  readonly newOid: string | null;
}

function countLines(content: Buffer | null): number {
  if (content === null) return 0;
  const text = content.toString('utf8');
  if (text === '') return 0;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** A rough line diff: common prefix + common suffix; the middle counts as changed. */
function lineDiff(oldContent: Buffer | null, newContent: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldContent === null ? [] : oldContent.toString('utf8').split('\n');
  const newLines = newContent === null ? [] : newContent.toString('utf8').split('\n');
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    additions: newLines.length - prefix - suffix,
    deletions: oldLines.length - prefix - suffix,
  };
}

/** Diff two trees: every file that differs, added, or removed, sorted by path. */
export function diffTrees(repo: Repo, oldTree: string | null, newTree: string | null): FileChange[] {
  const oldFiles = oldTree === null ? new Map() : flattenTree(repo, oldTree);
  const newFiles = newTree === null ? new Map() : flattenTree(repo, newTree);
  const paths = new Set([...oldFiles.keys(), ...newFiles.keys()]);
  const changes: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const oldEntry = oldFiles.get(path);
    const newEntry = newFiles.get(path);
    if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid === newEntry.oid) continue;
    const oldContent = oldEntry === undefined ? null : (repo.objects.get(oldEntry.oid)?.data ?? null);
    const newContent = newEntry === undefined ? null : (repo.objects.get(newEntry.oid)?.data ?? null);
    if (oldEntry === undefined) {
      changes.push({
        path,
        status: 'added',
        additions: countLines(newContent),
        deletions: 0,
        oldOid: null,
        newOid: newEntry.oid,
      });
    } else if (newEntry === undefined) {
      changes.push({
        path,
        status: 'removed',
        additions: 0,
        deletions: countLines(oldContent),
        oldOid: oldEntry.oid,
        newOid: null,
      });
    } else {
      const counts = lineDiff(oldContent, newContent);
      changes.push({
        path,
        status: 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        oldOid: oldEntry.oid,
        newOid: newEntry.oid,
      });
    }
  }
  return changes;
}

/** Diff two commits by their trees. */
export function diffCommits(repo: Repo, oldCommit: string, newCommit: string): FileChange[] {
  return diffTrees(repo, commitTree(repo, oldCommit), commitTree(repo, newCommit));
}

/**
 * True when a three-way merge of (base -> head) onto the current base tip would
 * conflict: a path changed on both sides with different resulting content.
 * Pure: it stores nothing.
 */
export function isConflicted(repo: Repo, baseCommit: string, headCommit: string, currentCommit: string): boolean {
  const baseTree = commitTree(repo, baseCommit);
  const headTree = commitTree(repo, headCommit);
  const currentTree = commitTree(repo, currentCommit);
  if (baseTree === null || headTree === null || currentTree === null) return true;
  const baseFiles = flattenTree(repo, baseTree);
  const headFiles = flattenTree(repo, headTree);
  const currentFiles = flattenTree(repo, currentTree);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...currentFiles.keys()]);
  for (const path of paths) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    const current = currentFiles.get(path);
    const headChanged = (head?.oid ?? null) !== (base?.oid ?? null);
    const currentChanged = (current?.oid ?? null) !== (base?.oid ?? null);
    if (headChanged && currentChanged && (head?.oid ?? null) !== (current?.oid ?? null)) return true;
  }
  return false;
}

/**
 * A three-way merge: apply the diff (base -> head) onto the current base tree.
 * Returns the merged tree oid, or null when a path changed on both sides with
 * different resulting content.
 */
export function mergeTrees(store: Store, repo: Repo, baseCommit: string, headCommit: string, currentCommit: string): string | null {
  const baseTree = commitTree(repo, baseCommit);
  const headTree = commitTree(repo, headCommit);
  const currentTree = commitTree(repo, currentCommit);
  if (baseTree === null || headTree === null || currentTree === null) return null;
  const baseFiles = flattenTree(repo, baseTree);
  const headFiles = flattenTree(repo, headTree);
  const currentFiles = flattenTree(repo, currentTree);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...currentFiles.keys()]);

  const merged = new Map<string, { mode: string; oid: string }>();
  for (const [path, entry] of currentFiles) merged.set(path, entry);
  for (const path of paths) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    const current = currentFiles.get(path);
    const headChanged = (head?.oid ?? null) !== (base?.oid ?? null);
    const currentChanged = (current?.oid ?? null) !== (base?.oid ?? null);
    if (!headChanged) continue;
    if (!currentChanged) {
      if (head === undefined) merged.delete(path);
      else merged.set(path, { mode: head.mode, oid: head.oid });
      continue;
    }
    // Both sides changed the path: conflict unless they agree.
    if ((head?.oid ?? null) === (current?.oid ?? null)) continue;
    return null;
  }

  // Rebuild the tree from the merged file set, bottom-up.
  const byDir = new Map<string, Map<string, TreeEntry>>();
  const ensureDir = (dir: string): Map<string, TreeEntry> => {
    let map = byDir.get(dir);
    if (map === undefined) {
      map = new Map();
      byDir.set(dir, map);
    }
    return map;
  };
  for (const [path, entry] of [...merged.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const parts = path.split('/');
    const fileName = parts[parts.length - 1] as string;
    const dir = parts.slice(0, -1).join('/');
    ensureDir(dir).set(fileName, { mode: entry.mode, name: fileName, oid: entry.oid });
  }
  const buildDir = (dir: string): string => {
    const entries: TreeEntry[] = [...(byDir.get(dir)?.values() ?? [])];
    // Attach subdirectories (they are built depth-first).
    const subdirs = new Set<string>();
    for (const [path] of merged) {
      if (path.startsWith(dir === '' ? '' : `${dir}/`)) {
        const rest = dir === '' ? path : path.slice(dir.length + 1);
        const slash = rest.indexOf('/');
        if (slash >= 0) subdirs.add(rest.slice(0, slash));
      }
    }
    for (const sub of [...subdirs].sort()) {
      const subPath = dir === '' ? sub : `${dir}/${sub}`;
      entries.push({ mode: '40000', name: sub, oid: buildDir(subPath) });
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    store.putObject(repo, oid, 'tree', data);
    return oid;
  };
  void ZERO_OID;
  return buildDir('');
}
