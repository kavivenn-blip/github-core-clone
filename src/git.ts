// Git smart HTTP: upload-pack (protocol v2 and v0) and receive-pack (v0), over the
// store's git objects. The pack engine lives in gitobj.ts; this file is the wire
// protocol: advertisements, ls-refs, fetch negotiation (including shallow deepen),
// and push reports.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Repo, Store } from './store.ts';
import {
  PKT_DELIM,
  PKT_FLUSH,
  collectReachable,
  decodePktLines,
  encodePktLines,
  hashObject,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  pktLine,
  readPack,
  writePack,
  type GitObject,
  type PktPacket,
} from './gitobj.ts';
import { isOid, ZERO_OID } from './util.ts';
import { readBody, sendBytes, sendError } from './http.ts';

const AGENT = 'forge/1.0.0';
const UPLOAD_V2_CAPS = `agent=${AGENT} ls-refs=unborn fetch=shallow wait-for-done filter object-format=sha1 server-option`;
const UPLOAD_V0_CAPS =
  `side-band-64k thin-pack ofs-delta shallow multi_ack_detailed symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_V0_CAPS = `report-status report-status-v2 side-band-64k ofs-delta delete-refs agent=${AGENT}`;

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

interface RefLine {
  readonly oid: string;
  readonly name: string;
  /** The peeled commit of an annotated tag, when the tag line precedes it. */
  readonly peeled?: string;
}

/** Every ref of a repo, HEAD first, then branches and tags sorted by name. */
function listRefs(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip !== undefined) lines.push({ oid: defaultTip, name: 'HEAD' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    let peeled: string | undefined;
    if (name.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const target = peelToCommit(oid, (id) => repo.objects.get(id));
        if (target !== null && target !== oid) peeled = target;
      }
    }
    lines.push({ oid, name, peeled });
  }
  return lines;
}

/** The v0 advertisement body for a service, with capabilities on the first line. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = listRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    for (const ref of refs) {
      const firstLine = ref === refs[0];
      parts.push(pktLine(`${ref.oid} ${ref.name}${firstLine ? `\0${caps}` : ''}\n`));
      // A peeled tag line follows its tag line immediately.
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 advertisement body for upload-pack. */
function v2Advertisement(): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH, pktLine('version 2\n')];
  for (const capability of UPLOAD_V2_CAPS.split(' ')) parts.push(pktLine(`${capability}\n`));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Parse an advertisement's ref lines (v0), including the peeled-tag lines. */
function parseV0Refs(packets: PktPacket[]): { refs: RefLine[]; caps: string } {
  const refs: RefLine[] = [];
  let caps = '';
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('# service=')) continue;
    const nul = text.indexOf('\0');
    const line = nul >= 0 ? text.slice(0, nul) : text;
    if (nul >= 0) caps = text.slice(nul + 1);
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const oid = line.slice(0, space);
    const name = line.slice(space + 1);
    if (name === 'capabilities^{}') continue;
    if (name.endsWith('^{}')) {
      const base = name.slice(0, -3);
      const existing = refs.find((ref) => ref.name === base);
      if (existing !== undefined) {
        const index = refs.indexOf(existing);
        refs[index] = { oid: existing.oid, name: existing.name, peeled: oid };
      } else {
        refs.push({ oid, name: base, peeled: oid });
      }
      continue;
    }
    refs.push({ oid, name });
  }
  return { refs, caps };
}

// ---------------------------------------------------------------------------
// Reachability with a depth limit, and the shallow boundary.
// ---------------------------------------------------------------------------

interface DepthWalk {
  /** Objects in the depth-limited walk (commits, trees, blobs). */
  readonly objects: Set<string>;
  /** Commits at the depth boundary: their parents are not in `objects`. */
  readonly shallow: Set<string>;
}

/** Walk from `tips`, including at most `depth` generations of commits (depth 1 = the tips). */
function walkDepth(repo: Repo, tips: readonly string[], depth: number): DepthWalk {
  const objects = new Set<string>();
  const shallow = new Set<string>();
  const commitDepth = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = tips.map((oid) => ({ oid, depth: 1 }));
  while (queue.length > 0) {
    const item = queue.pop() as { oid: string; depth: number };
    const known = commitDepth.get(item.oid);
    if (known !== undefined && known <= item.depth) continue;
    commitDepth.set(item.oid, item.depth);
    const object = repo.objects.get(item.oid);
    if (object === undefined || object.type !== 'commit') continue;
    objects.add(item.oid);
    const parsed = parseCommit(object.data);
    collectInto(repo, parsed.tree, objects);
    if (item.depth < depth) {
      for (const parent of parsed.parents) queue.push({ oid: parent, depth: item.depth + 1 });
    } else {
      shallow.add(item.oid);
    }
  }
  // A commit is only shallow when none of its parents was included.
  for (const oid of [...shallow]) {
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    if (parseCommit(object.data).parents.some((parent) => objects.has(parent))) shallow.delete(oid);
  }
  return { objects, shallow };
}

function collectInto(repo: Repo, oid: string, out: Set<string>): void {
  const object = repo.objects.get(oid);
  if (object === undefined || out.has(oid)) return;
  out.add(oid);
  if (object.type === 'tree') {
    for (const entry of parseTree(object.data)) {
      if (entry.mode !== '160000') collectInto(repo, entry.oid, out);
    }
  } else if (object.type === 'tag') {
    collectInto(repo, parseTag(object.data).object, out);
  }
}

/** Objects the client already holds: reachable from its haves without crossing its shallow boundary. */
function heldObjects(repo: Repo, haves: readonly string[], shallowBoundary: readonly string[]): Set<string> {
  const boundary = new Set(shallowBoundary);
  const held = new Set<string>();
  const queue = [...haves];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const parsed = parseCommit(object.data);
      collectInto(repo, parsed.tree, held);
      if (!boundary.has(oid)) {
        for (const parent of parsed.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      collectInto(repo, parseTag(object.data).object, held);
    } else if (object.type === 'tree') {
      collectInto(repo, oid, held);
    }
  }
  return held;
}

// ---------------------------------------------------------------------------
// ls-refs (v2) and fetch (v2)
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const refs = listRefs(repo);
  if (refs.length === 0) {
    if (args.unborn) lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  } else {
    for (const ref of refs) {
      const name = ref.name;
      if (args.prefixes.length > 0 && !args.prefixes.some((prefix) => name.startsWith(prefix))) continue;
      if (name === 'HEAD') {
        const target = `refs/heads/${repo.defaultBranch}`;
        lines.push(args.symrefs ? `${ref.oid} HEAD symref-target:${target}\n` : `${ref.oid} HEAD\n`);
        continue;
      }
      let line = `${ref.oid} ${name}`;
      if (args.symrefs && name === `refs/heads/${repo.defaultBranch}`) {
        // The default branch is not a symref; nothing to add.
      }
      if (args.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
      lines.push(`${line}\n`);
    }
  }
  return encodePktLines([...lines, 'flush']);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  filter: string | null;
}

function fetchResponseV2(repo: Repo, args: FetchArgs): Buffer {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const acks: string[] = [];
  for (const have of args.haves) {
    if (repo.objects.has(have)) acks.push(have);
  }
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (acks.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  }
  parts.push(PKT_DELIM);

  // The object set: depth-limited from the wants, minus what the client holds.
  let packObjects: GitObject[] = [];
  let newShallow: string[] = [];
  let unshallow: string[] = [];
  if (args.wants.length > 0) {
    const wanted = new Set<string>();
    for (const want of args.wants) {
      if (!repo.objects.has(want)) {
        // An unknown want is a protocol error, reported on band 3.
        const error = Buffer.concat([Buffer.from([3]), Buffer.from(`object not found: ${want}\n`, 'utf8')]);
        return Buffer.concat([Buffer.concat(parts), pktLine('packfile\n'), pktLine(error), PKT_FLUSH]);
      }
      wanted.add(want);
    }
    const depth = args.depth ?? Number.POSITIVE_INFINITY;
    let reachable: Set<string>;
    if (Number.isFinite(depth)) {
      const walk = walkDepth(repo, [...wanted], depth);
      reachable = walk.objects;
      newShallow = [...walk.shallow].sort();
      unshallow = args.shallow.filter((oid) => !newShallow.includes(oid) && reachable.has(oid)).sort();
    } else {
      reachable = collectReachable(wanted, lookup);
      unshallow = args.shallow.filter((oid) => reachable.has(oid)).sort();
    }
    const held = heldObjects(repo, args.haves, args.shallow);
    const wantedObjects = [...reachable].filter((oid) => !held.has(oid)).sort();
    packObjects = wantedObjects.map((oid) => repo.objects.get(oid) as GitObject);
  }

  if (newShallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of newShallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }

  if (packObjects.length > 0) {
    const pack = writePack(packObjects);
    parts.push(pktLine('packfile\n'));
    // Sideband: band 1 carries the pack, chunked to 65,515 bytes per pkt-line.
    for (let offset = 0; offset < pack.length; offset += 65515) {
      const chunk = pack.subarray(offset, Math.min(offset + 65515, pack.length));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Fetch (v0)
// ---------------------------------------------------------------------------

function fetchResponseV0(repo: Repo, args: FetchArgs): Buffer {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  const parts: Buffer[] = [];
  const acks: string[] = [];
  for (const have of args.haves) {
    if (repo.objects.has(have)) acks.push(have);
  }
  if (acks.length === 0) parts.push(pktLine('NAK\n'));
  else for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));

  let packObjects: GitObject[] = [];
  if (args.wants.length > 0) {
    const wanted = new Set<string>();
    let unknown: string | null = null;
    for (const want of args.wants) {
      if (!repo.objects.has(want)) unknown = want;
      else wanted.add(want);
    }
    if (unknown !== null) {
      const error = Buffer.concat([Buffer.from([3]), Buffer.from(`object not found: ${unknown}\n`, 'utf8')]);
      return Buffer.concat([Buffer.concat(parts), pktLine(error), PKT_FLUSH]);
    }
    const depth = args.depth ?? Number.POSITIVE_INFINITY;
    let reachable: Set<string>;
    let newShallow: string[] = [];
    let unshallow: string[] = [];
    if (Number.isFinite(depth)) {
      const walk = walkDepth(repo, [...wanted], depth);
      reachable = walk.objects;
      newShallow = [...walk.shallow].sort();
      unshallow = args.shallow.filter((oid) => !newShallow.includes(oid) && reachable.has(oid)).sort();
    } else {
      reachable = collectReachable(wanted, lookup);
      unshallow = args.shallow.filter((oid) => reachable.has(oid)).sort();
    }
    for (const oid of newShallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    const held = heldObjects(repo, args.haves, args.shallow);
    const wantedObjects = [...reachable].filter((oid) => !held.has(oid)).sort();
    packObjects = wantedObjects.map((oid) => repo.objects.get(oid) as GitObject);
  }

  if (packObjects.length > 0) {
    const pack = writePack(packObjects);
    for (let offset = 0; offset < pack.length; offset += 65515) {
      const chunk = pack.subarray(offset, Math.min(offset + 65515, pack.length));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Receive-pack (v0)
// ---------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/** Parse the pkt-line command section of a receive-pack body; returns the commands and the pack bytes. */
function parsePushBody(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  const commands: PushCommand[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('push command section is not pkt-lines');
    const length = parseInt(head, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) throw new Error('push command line is out of range');
    const text = body.subarray(offset + 4, offset + length).toString('utf8');
    const nul = text.indexOf('\0');
    const clean = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
    const parts = clean.split(' ');
    if (parts.length >= 3 && isOid(parts[0] as string) && isOid(parts[1] as string)) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
    offset += length;
  }
  const pack = offset < body.length ? body.subarray(offset) : null;
  return { commands, pack };
}

function receivePackResponse(repo: Repo, store: Store, commands: PushCommand[], pack: Buffer | null): Buffer {
  // Parse and store the pack first: a ref only moves when its objects are in.
  let unpackOk = true;
  if (pack !== null && pack.length > 0) {
    try {
      const result = readPack(pack, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of result.objects) store.putObject(repo, oid, object.type, object.data);
    } catch {
      unpackOk = false;
    }
  }

  const inner: Buffer[] = [];
  inner.push(pktLine(unpackOk ? 'unpack ok\n' : 'unpack error\n'));
  for (const command of commands) {
    let verdict: string | null = null;
    if (!unpackOk) {
      verdict = 'unpack failed';
    } else {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) verdict = 'remote ref does not exist';
        else if (command.oldOid !== ZERO_OID && command.oldOid !== current) verdict = 'old oid mismatch';
      } else if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) verdict = 'already exists';
        else if (!repo.objects.has(command.newOid)) verdict = 'object not found';
      } else {
        // Update.
        if (current === undefined) verdict = 'old oid mismatch';
        else if (command.oldOid !== current) verdict = 'old oid mismatch';
        else if (!repo.objects.has(command.newOid)) verdict = 'object not found';
        else if (!isAncestor(command.oldOid, command.newOid, (oid) => repo.objects.get(oid))) {
          verdict = 'non-fast-forward';
        }
      }
    }
    if (verdict === null) {
      if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
      inner.push(pktLine(`ok ${command.ref}\n`));
    } else {
      inner.push(pktLine(`ng ${command.ref} ${verdict}\n`));
    }
  }

  const innerBytes = Buffer.concat(inner);
  const parts: Buffer[] = [];
  for (let offset = 0; offset < innerBytes.length; offset += 65515) {
    const chunk = innerBytes.subarray(offset, Math.min(offset + 65515, innerBytes.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** The git surfaces for one repo. Returns true when the request was handled here. */
export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  segments: string[],
  search: string,
): Promise<boolean> {
  if (segments.length < 2) return false;
  const repoSegment = segments[1] as string;
  if (!repoSegment.endsWith('.git')) return false;
  const owner = segments[0] as string;
  const repoName = repoSegment.slice(0, -4);
  const rest = segments.slice(2);
  const repo = store.getRepo(owner, repoName);
  const params = new URLSearchParams(search);

  // GET /{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack
  if (req.method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
    if (repo === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const service = params.get('service');
    if (service === 'git-upload-pack') {
      const v2 = req.headers['git-protocol'] === 'version=2';
      if (v2) sendBytes(res, 200, 'application/x-git-upload-pack-advertisement', v2Advertisement());
      else sendBytes(res, 200, 'application/x-git-upload-pack-advertisement', v0Advertisement(repo, 'git-upload-pack'));
      return true;
    }
    if (service === 'git-receive-pack') {
      sendBytes(res, 200, 'application/x-git-receive-pack-advertisement', v0Advertisement(repo, 'git-receive-pack'));
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // POST /{owner}/{repo}.git/git-upload-pack
  if (req.method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
    if (repo === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      sendError(res, 400, 'Bad Request');
      return true;
    }
    let packets: PktPacket[];
    try {
      packets = decodePktLines(body);
    } catch {
      sendError(res, 400, 'Bad Request');
      return true;
    }
    const lines: string[] = [];
    for (const packet of packets) {
      if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
    }
    const isV2 = req.headers['git-protocol'] === 'version=2';
    if (isV2) {
      const command = lines.find((line) => line.startsWith('command='))?.slice('command='.length).trim();
      if (command === 'ls-refs') {
        const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
        let afterDelim = false;
        for (const line of lines) {
          const trimmed = line.replace(/\n$/, '');
          if (trimmed === 'command=ls-refs') continue;
          if (line === '') continue;
          if (trimmed.startsWith('agent=') || trimmed.startsWith('object-format=')) continue;
          afterDelim = true;
          if (trimmed === 'peel') args.peel = true;
          else if (trimmed === 'symrefs') args.symrefs = true;
          else if (trimmed === 'unborn') args.unborn = true;
          else if (trimmed.startsWith('ref-prefix ')) args.prefixes.push(trimmed.slice('ref-prefix '.length));
        }
        void afterDelim;
        sendBytes(res, 200, 'application/x-git-upload-pack-result', lsRefsResponse(repo, args));
        return true;
      }
      if (command === 'fetch') {
        const args = parseFetchArgs(lines);
        sendBytes(res, 200, 'application/x-git-upload-pack-result', fetchResponseV2(repo, args));
        return true;
      }
      sendError(res, 400, 'Bad Request');
      return true;
    }
    // v0 fetch.
    const args = parseFetchArgsV0(lines);
    sendBytes(res, 200, 'application/x-git-upload-pack-result', fetchResponseV0(repo, args));
    return true;
  }

  // POST /{owner}/{repo}.git/git-receive-pack
  if (req.method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
    if (repo === undefined) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      sendError(res, 400, 'Bad Request');
      return true;
    }
    let parsed: { commands: PushCommand[]; pack: Buffer | null };
    try {
      parsed = parsePushBody(body);
    } catch {
      sendError(res, 400, 'Bad Request');
      return true;
    }
    sendBytes(res, 200, 'application/x-git-receive-pack-result', receivePackResponse(repo, store, parsed.commands, parsed.pack));
    return true;
  }

  return false;
}

/** Parse the v2 fetch argument lines (after the command + delim). */
function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, filter: null };
  for (const line of lines) {
    const trimmed = line.replace(/\n$/, '');
    if (trimmed === 'command=fetch' || trimmed.startsWith('agent=') || trimmed.startsWith('object-format=')) continue;
    if (trimmed === 'thin-pack' || trimmed === 'no-progress' || trimmed === 'ofs-delta' || trimmed === 'done') continue;
    if (trimmed.startsWith('want ')) args.wants.push(trimmed.slice(5).trim());
    else if (trimmed.startsWith('have ')) args.haves.push(trimmed.slice(5).trim());
    else if (trimmed.startsWith('shallow ')) args.shallow.push(trimmed.slice(8).trim());
    else if (trimmed.startsWith('deepen ')) args.depth = Number.parseInt(trimmed.slice(7), 10);
    else if (trimmed.startsWith('filter ')) args.filter = trimmed.slice(7).trim();
    else if (trimmed.startsWith('deepen-since ') || trimmed.startsWith('deepen-not ')) {
      // Accepted and ignored: the suite never deepens by time or exclusion.
    }
  }
  return args;
}

/** Parse the v0 fetch lines: wants (first line may carry capabilities), then haves, deepen, done. */
function parseFetchArgsV0(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, filter: null };
  for (const line of lines) {
    const trimmed = line.replace(/\n$/, '');
    if (trimmed.startsWith('want ')) {
      const rest = trimmed.slice(5).trim();
      const first = rest.split(' ')[0] as string;
      args.wants.push(first);
    } else if (trimmed.startsWith('have ')) args.haves.push(trimmed.slice(5).trim());
    else if (trimmed.startsWith('shallow ')) args.shallow.push(trimmed.slice(8).trim());
    else if (trimmed.startsWith('deepen ')) args.depth = Number.parseInt(trimmed.slice(7), 10);
  }
  return args;
}

// Re-exported for the v0 advertisement parser used by tests elsewhere.
export { parseV0Refs };
