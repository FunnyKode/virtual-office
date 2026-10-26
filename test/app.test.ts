// Real HTTP server on an ephemeral port: routes, guard, hook intake and the SSE stream.
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStore, type Store } from '../src/domain/store.ts';
import { createApp, MAX_HOOK_BODY_BYTES, TOKEN_HEADER, type App } from '../src/server/app.ts';
import type { Logger } from '../src/server/logger.ts';

const TOKEN = 'a'.repeat(64);
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const THREE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'three');

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(port: number, options: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path, headers: { host: `127.0.0.1:${port}`, ...options.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

const postHook = (port: number, payload: unknown, headers: Record<string, string> = { [TOKEN_HEADER]: TOKEN }) =>
  request(port, { method: 'POST', path: '/api/hooks', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });

/** Opens the SSE stream and collects parsed events. */
function openStream(port: number) {
  const events: { event: string; data: unknown }[] = [];
  let buffer = '';
  let req: http.ClientRequest;
  const ready = new Promise<http.IncomingMessage>((resolve, reject) => {
    req = http.get({ host: '127.0.0.1', port, path: '/api/flux', headers: { host: `localhost:${port}` } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (event && data) events.push({ event, data: JSON.parse(data) });
        }
      });
      resolve(res);
    });
    req.on('error', reject);
  });
  const waitFor = async (count: number) => {
    for (let i = 0; i < 100 && events.length < count; i++) await new Promise((r) => setTimeout(r, 10));
    return events;
  };
  return { ready, waitFor, close: () => req.destroy() };
}

describe('HTTP app', () => {
  let store: Store;
  let app: App;
  let port: number;
  const logged: string[] = [];
  const logger: Logger = { info: (m) => logged.push(m), error: (m) => logged.push(m) };

  beforeEach(async () => {
    store = createStore({ silenceMs: 60_000, windowMs: 3_600_000 });
    app = createApp({ store, token: TOKEN, silenceMs: 60_000, publicDir: PUBLIC_DIR, threeDir: THREE_DIR, logger, sse: { heartbeatMs: 20, maxClients: 2, maxBufferedBytes: 1 << 20 } });
    port = (await app.listen(0, '127.0.0.1')).port;
  });
  afterEach(async () => {
    await app.close();
    logged.length = 0;
  });

  it('serves state in a uniform envelope with security headers', async () => {
    const health = await request(port, { path: '/api/health' });
    expect(JSON.parse(health.body)).toEqual({ ok: true, data: { status: 'up' } });
    const state = await request(port, { path: '/api/etat' });
    expect(state.headers['x-content-type-options']).toBe('nosniff');
    expect(state.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(state.body)).toMatchObject({ ok: true, data: { silenceMs: 60_000, agents: [] } });
  });

  it('serves the page with a strict CSP and 404s unknown paths', async () => {
    const page = await request(port, { path: '/' });
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.body).toContain('Bureau virtuel');
    expect((await request(port, { path: '/app.js' })).headers['content-type']).toContain('javascript');
    expect((await request(port, { path: '/../package.json' })).status).toBe(404);
    expect(JSON.parse((await request(port, { path: '/inconnu' })).body)).toEqual({ ok: false, error: 'introuvable' });
  });

  it('serves the 3D office with its import map allowed by hash, and the table page', async () => {
    const office = await request(port, { path: '/' });
    const importMap = /<script type="importmap">([\s\S]*?)<\/script>/.exec(office.body)?.[1] ?? '';
    const hash = createHash('sha256').update(importMap).digest('base64');
    expect(importMap).toContain('/vendor/three/');
    expect(office.headers['content-security-policy']).toContain(`script-src 'self' 'sha256-${hash}'`);
    expect(office.headers['content-security-policy']).not.toContain('unsafe-inline');
    const table = await request(port, { path: '/tableau' });
    expect(table.body).toContain('/app.js');
    expect(table.headers['content-security-policy']).toContain("script-src 'self';");
  });

  it('serves office modules and Three.js, nothing else from those folders', async () => {
    const module = await request(port, { path: '/office/office.js' });
    expect(module.status).toBe(200);
    expect(module.headers['cache-control']).toBe('no-store');
    const three = await request(port, { path: '/vendor/three/build/three.module.js' });
    expect(three.status).toBe(200);
    expect(three.headers['cache-control']).toBe('public, max-age=3600');
    expect((await request(port, { path: '/vendor/three/examples/jsm/controls/OrbitControls.js' })).status).toBe(200);
    for (const forbidden of ['/vendor/three/package.json', '/vendor/three/src/Three.js', '/office/..%2F..%2Fpackage.json', '/office/%2e%2e/%2e%2e/package.json', '/office/', '/office/logic/%E0%A4%A.js', '/app.html']) {
      expect((await request(port, { path: forbidden })).status, forbidden).toBe(404);
    }
  });

  it.each([
    ['a foreign Host (DNS rebinding)', { host: `evil.example:${PORT_PLACEHOLDER}` }, 'hôte refusé'],
    ['a foreign Origin', { origin: 'http://evil.example' }, 'origine refusée'],
    ['an https Origin', { origin: `https://127.0.0.1:${PORT_PLACEHOLDER}` }, 'origine refusée'],
    ['a malformed Origin', { origin: 'nimporte quoi' }, 'origine refusée'],
    ['a cross-site fetch', { 'sec-fetch-site': 'cross-site' }, 'requête inter-sites refusée'],
  ])('rejects reads with %s', async (_label, headers, error) => {
    const resolved = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, value.replace(PORT_PLACEHOLDER, String(port))]));
    const reply = await request(port, { path: '/api/etat', headers: resolved });
    expect(reply.status).toBe(403);
    expect(JSON.parse(reply.body)).toEqual({ ok: false, error });
  });

  it('accepts same-origin requests from the page', async () => {
    const reply = await request(port, { path: '/api/etat', headers: { origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' } });
    expect(reply.status).toBe(200);
  });

  it('applies hook events only with the right token and a valid body', async () => {
    expect((await postHook(port, { hook_event_name: 'Stop', session_id: 's1' }, {})).status).toBe(401);
    expect((await postHook(port, { hook_event_name: 'Stop', session_id: 's1' }, { [TOKEN_HEADER]: 'b'.repeat(64) })).status).toBe(401);
    expect((await request(port, { method: 'POST', path: '/api/hooks', headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect((await request(port, { method: 'POST', path: '/api/hooks', headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' }, body: '{' })).status).toBe(400);
    expect(JSON.parse((await postHook(port, { hook_event_name: 'Stop' })).body)).toEqual({ ok: false, error: 'session_id manquant ou invalide' });

    const accepted = await postHook(port, { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/repo', prompt: 'Lance les tests' });
    expect(accepted.status).toBe(202);
    expect(JSON.parse(accepted.body)).toEqual({ ok: true, data: { accepted: 2 } });
    expect(store.state().agents['s1']).toMatchObject({ status: 'working', cwd: '/repo', lastPrompt: 'Lance les tests' });
  });

  it('refuses oversized hook bodies and wrong methods', async () => {
    const big = JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', pad: 'x'.repeat(MAX_HOOK_BODY_BYTES) });
    expect((await request(port, { method: 'POST', path: '/api/hooks', headers: { [TOKEN_HEADER]: TOKEN, 'content-type': 'application/json' }, body: big })).status).toBe(413);
    expect((await request(port, { path: '/api/hooks' })).status).toBe(405);
    expect((await request(port, { method: 'DELETE', path: '/api/etat' })).status).toBe(405);
  });

  it('streams a snapshot, then live changes, with heartbeats', async () => {
    store.dispatch([{ at: Date.now(), agentId: 'avant', source: 'hook', type: 'prompt', text: 'déjà là' }]);
    const stream = openStream(port);
    const res = await stream.ready;
    expect(res.headers['content-type']).toContain('text/event-stream');
    await stream.waitFor(1);
    await postHook(port, { hook_event_name: 'PreToolUse', session_id: 's2', tool_name: 'Bash', tool_use_id: 'tu1', tool_input: { command: 'npm test' } });
    const events = await stream.waitFor(2);
    expect(events[0]).toMatchObject({ event: 'snapshot', data: { agents: [{ id: 'avant' }] } });
    expect(events[1]).toMatchObject({ event: 'agents', data: [{ id: 's2', status: 'working', currentTool: { summary: 'Bash npm test' } }] });
    stream.close();
  });

  it('caps the number of stream clients', async () => {
    const a = openStream(port);
    const b = openStream(port);
    await Promise.all([a.ready, b.ready]);
    await new Promise((r) => setTimeout(r, 30));
    expect(app.hub.size()).toBe(2);
    const refused = await request(port, { path: '/api/flux' });
    expect(refused.status).toBe(503);
    a.close();
    b.close();
  });

  it('answers 400, not 500, to a request line that is not a valid URL', async () => {
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.end(`GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
      let data = '';
      socket.on('data', (chunk) => (data += chunk));
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
    });
    expect(raw).toMatch(/^HTTP\/1\.1 400/);
    expect(logged).not.toContain('requête en échec');
  });

  it('hides internal errors behind a generic 500 and logs them', async () => {
    const broken = createApp({ store, token: TOKEN, silenceMs: 1, publicDir: '/nulle-part', threeDir: THREE_DIR, logger });
    const brokenPort = (await broken.listen(0, '127.0.0.1')).port;
    const reply = await request(brokenPort, { path: '/' });
    expect(reply.status).toBe(500);
    expect(JSON.parse(reply.body)).toEqual({ ok: false, error: 'erreur interne' });
    expect(logged).toContain('requête en échec');
    await broken.close();
  });
});

const PORT_PLACEHOLDER = '{port}';
