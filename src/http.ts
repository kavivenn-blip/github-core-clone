// HTTP plumbing for the one node:http server: reading a body, answering JSON,
// the bearer-token gate, and the request-id every REST reply carries.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { RequestIds } from './util.ts';

export const requestIds = new RequestIds();

/** Read the whole request body (bounded; the suite's largest pack is a few hundred KiB). */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a body as JSON; null when it is empty, throws on malformed JSON. */
export function parseJsonBody(body: Buffer): unknown {
  const text = body.toString('utf8').trim();
  if (text === '') return null;
  return JSON.parse(text) as unknown;
}

/** Is the value a plain JSON object (not an array, not null)? */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Send a JSON body with the standard headers. */
export function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'x-github-request-id': requestIds.next(),
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(body);
}

/** Send raw bytes with a content type. */
export function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': requestIds.next(),
  });
  res.end(body);
}

/** A JSON error body: {"message": "..."} — every error the suite sees has one. */
export function sendError(res: ServerResponse, status: number, message: string, extraHeaders: Record<string, string> = {}): void {
  sendJson(res, status, { message }, extraHeaders);
}

// ---------------------------------------------------------------------------
// Auth.
// ---------------------------------------------------------------------------

/** The token the env gave this entry; the only bearer that passes. */
export function expectedToken(): string | undefined {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  return token === undefined || token === '' ? undefined : token;
}

/**
 * True when the request carries the entry's bearer token. When the env gave no
 * token (local runs), any non-empty bearer passes so the suite can still be
 * exercised against a test token.
 */
export function isAuthorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented === '') return false;
  const expected = expectedToken();
  if (expected === undefined) return true;
  return presented === expected;
}

/** Answer 401 unless the request is authorized; returns true when it passed. */
export function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (isAuthorized(req)) return true;
  sendError(res, 401, 'Requires authentication');
  return false;
}

/** Split a URL path into its segments, decoding each. */
export function pathSegments(pathname: string): string[] {
  return pathname.split('/').filter((part) => part !== '').map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
}

/** A query string as a map (first value wins). */
export function queryParams(search: string): Map<string, string> {
  const params = new Map<string, string>();
  for (const [key, value] of new URLSearchParams(search)) {
    if (!params.has(key)) params.set(key, value);
  }
  return params;
}
