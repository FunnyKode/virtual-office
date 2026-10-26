// HTTP routes. Every response is JSON in one envelope ({ ok, data } or { ok: false, error }),
// except the SSE stream and the static page.
import { readFile } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Store } from '../domain/store.ts';
import { parseHookPayload } from '../sources/claude-hooks.ts';
import { allowedHosts, rejectReason } from './guard.ts';
import type { Logger } from './logger.ts';
import { createSseHub, type SseHub } from './sse.ts';
import { tokenMatches } from './token.ts';

export const TOKEN_HEADER = 'x-virtual-office-token';
export const MAX_HOOK_BODY_BYTES = 1024 * 1024;

export interface AppOptions {
  readonly store: Store;
  readonly token: string;
  readonly silenceMs: number;
  readonly publicDir: string;
  readonly logger: Logger;
  readonly now?: () => number;
  readonly sse?: { heartbeatMs: number; maxClients: number; maxBufferedBytes: number };
}

export interface App {
  listen(port: number, host: string): Promise<AddressInfo>;
  close(): Promise<void>;
  readonly hub: SseHub;
}

const STATIC_FILES: Readonly<Record<string, { file: string; type: string }>> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
} as const;

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const ok = (res: ServerResponse, data: unknown, status = 200) => sendJson(res, status, { ok: true, data });
const fail = (res: ServerResponse, status: number, error: string) => sendJson(res, status, { ok: false, error });

function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      reject(new HttpError(415, 'content-type application/json attendu'));
      return;
    }
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > limit) {
      reject(new HttpError(413, 'corps trop volumineux'));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      if (size > limit) return; // already refused: drain without storing, so the 413 can be delivered
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        reject(new HttpError(413, 'corps trop volumineux'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'));
      } catch {
        reject(new HttpError(400, 'JSON invalide'));
      }
    });
  });
}

export function createApp(options: AppOptions): App {
  const now = options.now ?? Date.now;
  const hub = createSseHub(options.sse ?? { heartbeatMs: 15_000, maxClients: 32, maxBufferedBytes: 1024 * 1024 });
  let hosts: ReadonlySet<string> = new Set();

  const snapshot = () => ({ generatedAt: now(), silenceMs: options.silenceMs, agents: options.store.snapshot() });
  const unsubscribe = options.store.subscribe((changed) => hub.broadcast('agents', changed));

  async function receiveHook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!tokenMatches(req.headers[TOKEN_HEADER], options.token)) throw new HttpError(401, 'jeton absent ou invalide');
    const parsed = parseHookPayload(await readJsonBody(req, MAX_HOOK_BODY_BYTES), now());
    if (!parsed.ok) throw new HttpError(400, parsed.error);
    options.store.dispatch(parsed.events);
    ok(res, { accepted: parsed.events.length }, 202);
  }

  async function serveStatic(res: ServerResponse, entry: { file: string; type: string }): Promise<void> {
    const body = await readFile(path.join(options.publicDir, entry.file));
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': entry.type, 'content-security-policy': CSP });
    res.end(body);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const refusal = rejectReason(req, hosts);
    if (refusal) throw new HttpError(403, refusal);
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      throw new HttpError(400, 'adresse invalide');
    }
    const method = req.method ?? 'GET';

    if (pathname === '/api/hooks') {
      if (method !== 'POST') throw new HttpError(405, 'POST attendu');
      return receiveHook(req, res);
    }
    if (method !== 'GET') throw new HttpError(405, 'GET attendu');
    if (pathname === '/api/health') return ok(res, { status: 'up' });
    if (pathname === '/api/etat') return ok(res, snapshot());
    if (pathname === '/api/flux') {
      if (!hub.add(res, { event: 'snapshot', data: snapshot() })) throw new HttpError(503, 'trop de clients connectés');
      return;
    }
    const entry = STATIC_FILES[pathname];
    if (entry) return serveStatic(res, entry);
    throw new HttpError(404, 'introuvable');
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) return fail(res, error.status, error.message);
      options.logger.error('requête en échec', { url: req.url, error });
      if (!res.headersSent) fail(res, 500, 'erreur interne');
      else res.destroy();
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;

  return {
    hub,
    listen(port, host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          const address = server.address() as AddressInfo;
          hosts = allowedHosts(address.port);
          resolve(address);
        });
      });
    },
    close() {
      unsubscribe();
      hub.close();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
