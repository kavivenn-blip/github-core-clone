// Small shared helpers: base64, deterministic clocks and counters, and the seeded
// scenario's user logins. Nothing here reads the wall clock or Math.random for data
// that reaches a response: the trial replays the same requests and must see the same
// bytes, so every timestamp and id comes from a counter that moves in request order.

import { createHash } from 'node:crypto';

/** Standard base64 of bytes. */
export function b64encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Decode base64, ignoring whitespace (GitHub wraps content at 60 columns). */
export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

/** SHA-1 hex of bytes. */
export function sha1Hex(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

/** True for a 40-hex object id. */
export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** The all-zero object id. */
export const ZERO_OID = '0000000000000000000000000000000000000000';

/** Escape a string for safe inclusion in a JSON error message (no control chars). */
export function safeText(value: string, max = 200): string {
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// ---------------------------------------------------------------------------
// Deterministic time and ids.
//
// The suite's replay runs the same requests in the same order against a fresh
// server and compares the answers byte for byte, so no response may carry a
// wall-clock time or a random value. One monotonic counter feeds every
// timestamp (ISO) and every request id; the order of requests decides the
// values, and the order is the same on replay.
// ---------------------------------------------------------------------------

/** 2025-01-01T00:00:00Z: the epoch every generated timestamp derives from. */
export const BASE_EPOCH_SEC = 1_735_689_600;

/** A monotonic counter: the only clock the server's answers use. */
export class Clock {
  private seq = 0;

  /** The next timestamp, ISO 8601, one second after the previous one. */
  nextIso(): string {
    this.seq += 1;
    return new Date((BASE_EPOCH_SEC + this.seq) * 1000).toISOString();
  }

  /** The next timestamp as epoch seconds. */
  nextEpochSec(): number {
    this.seq += 1;
    return BASE_EPOCH_SEC + this.seq;
  }

  /** The current sequence value (for ordering comparisons). */
  get current(): number {
    return this.seq;
  }
}

/** A monotonic counter for request ids. */
export class RequestIds {
  private seq = 0;

  next(): string {
    this.seq += 1;
    return `req-${String(this.seq).padStart(8, '0')}`;
  }
}

// ---------------------------------------------------------------------------
// The seeded scenario's users.
//
// The suite builds every name from one fixed seed (wire.ts SCENARIO_SEED); the
// viewer login the bearer token names is users[0] of that generation. The entry
// receives only the token, never the login, so it re-derives the logins from the
// same public seed with the same pure generators: same seed, same logins, in any
// process. Only the three logins the checks can name are needed here.
// ---------------------------------------------------------------------------

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/** xorshift64*: the scenario's PRNG, seeded from a bigint. */
class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

export interface ScenarioUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** The scenario's users, in generation order: [viewer, teammate, stranger, ...]. */
export function scenarioUsers(): ScenarioUser[] {
  const rng = new Rng(scenarioSeedFor('users'));
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

/** The login the bearer token names, and the other logins the suite may use. */
export const SCENARIO_VIEWER: ScenarioUser = scenarioUsers()[0] as ScenarioUser;
export const SCENARIO_STRANGER: ScenarioUser = scenarioUsers()[2] as ScenarioUser;
