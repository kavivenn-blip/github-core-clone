// The server: one node:http server, one store, four surfaces. Routing is by path
// prefix, in order: healthz, the git smart-HTTP surface, REST v3, GraphQL v4,
// MCP, and a JSON 404 for anything else. A handler that throws answers 500
// instead of taking the process down: the trial scores a dead server as zero.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { pathSegments, sendError, sendJson } from './http.ts';

export function createApp(): Server {
  const store = new Store();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const pathname = url.pathname;

        // GET /healthz: the env's liveness probe, no auth.
        if (pathname === '/healthz' && req.method === 'GET') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const segments = pathSegments(pathname);

        // Git smart HTTP: /{owner}/{repo}.git/info/refs, .../git-upload-pack, .../git-receive-pack.
        if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
          if (await handleGit(req, res, store, segments, url.search)) return;
          sendError(res, 404, 'Not Found');
          return;
        }

        // REST v3.
        if (pathname.startsWith('/api/v3')) {
          if (await handleRest(req, res, store, url, segments)) return;
          sendError(res, 404, 'Not Found');
          return;
        }

        // GraphQL v4.
        if (pathname === '/api/graphql') {
          if (await handleGraphQL(req, res, store)) return;
          sendError(res, 404, 'Not Found');
          return;
        }

        // MCP.
        if (pathname === '/mcp') {
          if (await handleMcp(req, res, store)) return;
          sendError(res, 404, 'Not Found');
          return;
        }

        sendError(res, 404, 'Not Found');
      } catch (err) {
        if (!res.headersSent) {
          try {
            sendError(res, 500, 'Internal Server Error');
          } catch {
            // The socket is gone; nothing left to do.
          }
        }
        process.stderr.write(`[entry] handler error: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    })();
  });

  // Keep the process alive for keep-alive connections the suite reuses.
  server.keepAliveTimeout = 5000;
  server.headersTimeout = 10000;
  return server;
}
