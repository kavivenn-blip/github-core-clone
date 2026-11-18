// Git objects, the packfile format and pkt-line framing, hand-rolled on node:zlib
// and node:crypto. No git binary, no vendored library: every byte the smart-HTTP
// surface sends or accepts is built here.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The SHA-1 of `<type> <size>\0<data>`. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// Object builders (the byte layouts the conformance client builds too).
// ---------------------------------------------------------------------------

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Sort key: a directory compares as if its name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object into its entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry has no name');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitInput {
  readonly tree: string;
  readonly parents?: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly timestamp: number;
  readonly message: string;
}

/** Build a commit object. The message is used as-is (callers end it with \n). */
export function buildCommit(input: CommitInput): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author} ${input.timestamp} +0000`);
  lines.push(`committer ${input.committer} ${input.timestamp} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}

export interface ParsedCommit {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TagInput {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly timestamp: number;
  readonly message: string;
}

/** Build an annotated tag object. */
export function buildTag(input: TagInput): Buffer {
  const lines = [
    `object ${input.object}`,
    `type ${input.type}`,
    `tag ${input.tag}`,
    `tagger ${input.tagger} ${input.timestamp} +0000`,
  ];
  return Buffer.from(`${lines.join('\n')}\n\n${input.message}`, 'utf8');
}

export interface ParsedTag {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------
// Reachability: the object ids a set of tips pulls in.
// ---------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** Walk commits, tags and trees from `tips`; throws on a missing object. */
export function collectReachable(
  tips: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...tips];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) {
      if (options.allowMissing === true) continue;
      throw new Error(`missing object ${oid}`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const parsed = parseCommit(object.data);
      queue.push(parsed.tree);
      for (const parent of parsed.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Peel an annotated tag to the commit it names (or return the oid unchanged). */
export function peelToCommit(oid: string, lookup: ObjectLookup): string | null {
  let current = oid;
  const guard = new Set<string>();
  for (;;) {
    if (guard.has(current)) return null;
    guard.add(current);
    const object = lookup(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
}

/** True when `ancestor` is reachable from `tip` (both peeled to commits first). */
export function isAncestor(ancestor: string, tip: string, lookup: ObjectLookup): boolean {
  const start = peelToCommit(tip, lookup);
  const want = peelToCommit(ancestor, lookup);
  if (start === null || want === null) return false;
  if (start === want) return true;
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === want) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Deltas (a client that sends deltas is rare; the format is still honoured).
// ---------------------------------------------------------------------------

function readDeltaVarint(data: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let at = offset;
  for (;;) {
    if (at >= data.length) throw new Error('delta varint is truncated');
    const byte = data[at] as number;
    at += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: at };
}

function readDeltaOffset(data: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let at = offset;
  for (;;) {
    if (at >= data.length) throw new Error('delta offset is truncated');
    const byte = data[at] as number;
    at += 1;
    value = ((value + 1) << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: at };
}

/** Apply a git delta to its base. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const source = readDeltaVarint(delta, 0);
  if (source.value !== base.length) throw new Error('delta source size does not match the base');
  const target = readDeltaVarint(delta, source.next);
  const out = Buffer.allocUnsafe(target.value);
  let write = 0;
  let read = target.next;
  while (read < delta.length) {
    const opcode = delta[read] as number;
    read += 1;
    if ((opcode & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((opcode & (1 << bit)) !== 0) {
          if (read >= delta.length) throw new Error('delta copy is truncated');
          copyOffset |= (delta[read] as number) << (bit * 8);
          read += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((opcode & (0x10 << bit)) !== 0) {
          if (read >= delta.length) throw new Error('delta copy is truncated');
          copySize |= (delta[read] as number) << (bit * 8);
          read += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length || write + copySize > out.length) throw new Error('delta copy is out of range');
      base.copy(out, write, copyOffset, copyOffset + copySize);
      write += copySize;
    } else if (opcode !== 0) {
      if (read + opcode > delta.length || write + opcode > out.length) throw new Error('delta insert is out of range');
      delta.copy(out, write, read, read + opcode);
      write += opcode;
      read += opcode;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (write !== target.value) throw new Error('delta did not produce its declared size');
  return out;
}

// ---------------------------------------------------------------------------
// Packfiles.
// ---------------------------------------------------------------------------

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas): PACK, version 2, count, entries, trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** The trailer checksum of a packfile (SHA-1 over everything before the last 20 bytes). */
export function packChecksum(pack: Uint8Array): string {
  return createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
}

function readVarintSize(buffer: Buffer, offset: number): { size: number; first: number; next: number } {
  if (offset >= buffer.length) throw new Error('pack entry header is truncated');
  const first = buffer[offset] as number;
  let size = first & 0x0f;
  let shift = 4;
  let at = offset + 1;
  while ((first & 0x80) !== 0 || (at > offset + 1 && (buffer[at - 1] as number) & 0x80) !== 0) {
    if (at >= buffer.length) throw new Error('pack entry size is truncated');
    const byte = buffer[at] as number;
    at += 1;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { size, first, next: at };
}

function inflateAt(buffer: Buffer, offset: number, limit: number): { data: Buffer; next: number } {
  // inflateSync with info:true returns { buffer, engine }; the engine's bytesWritten counts the
  // deflate-stream bytes it consumed, which is the input boundary of this entry.
  const result = inflateSync(buffer.subarray(offset, limit), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

export interface PackReadResult {
  readonly objects: Map<string, GitObject>;
  readonly deltaCount: number;
}

/**
 * Read a packfile (version 2 or 3), resolving OFS/REF deltas, verifying every
 * object's SHA-1 and the trailer checksum. `resolveBase` supplies a base a thin
 * pack leaves out.
 */
export function readPack(pack: Uint8Array, options: { resolveBase?: ObjectLookup } = {}): PackReadResult {
  // The request body already is a Buffer; copying it would double the work.
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 32) throw new Error('pack is too short');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  if (buffer.subarray(trailerStart).toString('hex') !== packChecksum(buffer)) {
    throw new Error('pack trailer does not match its bytes');
  }

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readDeltaOffset(buffer, offset);
      offset = base.next;
      if (base.value <= 0 || base.value > entryOffset) throw new Error('ofs-delta names an invalid base offset');
      entry.baseOffset = entryOffset - base.value;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer, offset, trailerStart);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  let deltaCount = 0;

  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    const cached = (entry as RawEntry & { resolved?: { type: GitObjectType; data: Buffer; oid: string } }).resolved;
    if (cached !== undefined) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (external === undefined) throw new Error('ref-delta base is neither in the pack nor supplied');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as GitObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const solved = { type, data, oid };
    (entry as RawEntry & { resolved?: unknown }).resolved = solved;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return solved;
  };

  for (const entry of raw) {
    const solved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(solved.oid)) objects.set(solved.oid, { type: solved.type, data: solved.data });
  }
  return { objects, deltaCount };
}

// ---------------------------------------------------------------------------
// Pkt-lines.
// ---------------------------------------------------------------------------

/** Encode one pkt-line: 4 hex length digits + payload (payload must end with \n for text lines). */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 65520) throw new Error('pkt-line is too long');
  const head = Buffer.allocUnsafe(4);
  head.write(length.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type PktPacket =
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' }
  | { kind: 'data'; payload: Buffer };

/** Decode a whole buffer of pkt-lines. Throws on a malformed line. */
export function decodePktLines(buffer: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('pkt-line header is truncated');
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('pkt-line header is not hex');
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line length is out of range');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

/** Encode a list of text lines (and 'flush'/'delim' markers) as pkt-lines. */
export function encodePktLines(lines: Array<string | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}
