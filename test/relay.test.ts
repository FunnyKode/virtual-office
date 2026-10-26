import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { MAX_STRING, relay, serverUrl, slim, tokenFile } from '../hooks/relay.mjs';
import { withTempDir } from './helpers.ts';

const RELAY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'relay.mjs');
const TOKEN = 'd'.repeat(64);

function run(input: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RELAY, '--virtual-office'], { env: { PATH: process.env['PATH'] ?? '', ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

describe('slim', () => {
  it('drops tool outputs and file contents, shortens long strings, bounds depth', () => {
    const payload = {
      hook_event_name: 'PostToolUse',
      tool_input: { file_path: '/a.ts', content: 'secret', new_string: 'x', command: 'y'.repeat(MAX_STRING + 10) },
      tool_response: { stdout: 'énorme' },
      deep: { a: { b: { c: { d: { e: 1 } } } } },
      list: Array.from({ length: 80 }, (_, i) => i),
    };
    const result = slim(payload) as Record<string, any>;
    expect(result['tool_response']).toBeUndefined();
    expect(result['tool_input']).toEqual({ file_path: '/a.ts', command: `${'y'.repeat(MAX_STRING)}…` });
    expect(result['deep']).toEqual({ a: { b: { c: {} } } });
    expect(result['list']).toHaveLength(50);
    expect(payload.tool_input.content).toBe('secret');
  });
});

describe('relay', () => {
  it('posts the slimmed payload with the token, and stays silent on success', () =>
    withTempDir(async (dir) => {
      const file = path.join(dir, 'token');
      await writeFile(file, `${TOKEN}\n`);
      const fetchImpl = vi.fn(async () => new Response('{"ok":true}', { status: 202 }));
      const problem = await relay({ input: JSON.stringify({ hook_event_name: 'Stop', session_id: 's' }), env: { VO_TOKEN_FILE: file, VO_PORT: '9999' }, fetchImpl });
      expect(problem).toBeNull();
      const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('http://127.0.0.1:9999/api/hooks');
      expect(init.headers).toMatchObject({ 'x-virtual-office-token': TOKEN });
      expect(JSON.parse(String(init.body))).toEqual({ hook_event_name: 'Stop', session_id: 's' });
    }));

  it('reports refusals and bad input, but not an office that is simply off', () =>
    withTempDir(async (dir) => {
      const file = path.join(dir, 'token');
      await writeFile(file, TOKEN);
      const env = { VO_TOKEN_FILE: file };
      const input = '{"hook_event_name":"Stop","session_id":"s"}';
      expect(await relay({ input: '{', env })).toMatch(/illisible/);
      expect(await relay({ input, env: { VO_TOKEN_FILE: path.join(dir, 'absent') } })).toBeNull();
      expect(await relay({ input, env: { VO_TOKEN_FILE: dir } })).toMatch(/jeton illisible/);
      const refused = vi.fn(async () => new Response('{"ok":false,"error":"jeton absent ou invalide"}', { status: 401 }));
      expect(await relay({ input, env, fetchImpl: refused })).toBe('virtual-office : refusé (401) jeton absent ou invalide');
      const garbled = vi.fn(async () => new Response('<html>', { status: 500 }));
      expect(await relay({ input, env, fetchImpl: garbled })).toBe('virtual-office : refusé (500)');
      const off = vi.fn(async () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })));
      expect(await relay({ input, env, fetchImpl: off })).toBeNull();
      const odd = vi.fn(async () => Promise.reject(new Error('socket hang up')));
      expect(await relay({ input, env, fetchImpl: odd })).toMatch(/envoi en échec/);
    }));

  it('targets the same address as the server, IPv6 included', () => {
    expect(serverUrl({})).toBe('http://127.0.0.1:4317');
    expect(serverUrl({ VO_HOST: '::1', VO_PORT: '5000' })).toBe('http://[::1]:5000');
    expect(serverUrl({ VO_HOST: 'localhost' })).toBe('http://localhost:4317');
  });

  it('finds the token under XDG_CONFIG_HOME by default', () => {
    expect(tokenFile({ XDG_CONFIG_HOME: '/cfg' })).toBe('/cfg/virtual-office/token');
    expect(tokenFile({ VO_TOKEN_FILE: '/t' })).toBe('/t');
  });

  it('as a process: delivers the event, prints nothing on stdout and exits 0', () =>
    withTempDir(async (dir) => {
      const file = path.join(dir, 'token');
      await writeFile(file, TOKEN);
      const received: string[] = [];
      const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          received.push(`${req.headers['x-virtual-office-token']} ${body}`);
          res.writeHead(202).end('{"ok":true}');
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      try {
        const result = await run('{"hook_event_name":"Stop","session_id":"s"}', { VO_TOKEN_FILE: file, VO_PORT: String(port) });
        expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
        expect(received).toEqual([`${TOKEN} {"hook_event_name":"Stop","session_id":"s"}`]);
        const closed = http.createServer();
        await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
        const freePort = (closed.address() as AddressInfo).port;
        await new Promise((resolve) => closed.close(resolve));
        const down = await run('{"hook_event_name":"Stop","session_id":"s"}', { VO_TOKEN_FILE: file, VO_PORT: String(freePort) });
        expect(down).toEqual({ code: 0, stdout: '', stderr: '' });
        const bad = await run('pas du json', { VO_TOKEN_FILE: file, VO_PORT: String(port) });
        expect(bad.code).toBe(0);
        expect(bad.stderr).toMatch(/illisible/);
      } finally {
        server.close();
      }
    }));
});
