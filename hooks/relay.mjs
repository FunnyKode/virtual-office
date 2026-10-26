#!/usr/bin/env node
// Claude Code hook: forwards the hook payload (stdin) to the local virtual office.
// It must never disturb Claude Code: no stdout (some hooks inject stdout into the context),
// always exit 0, short timeout. An office that is not running is a normal state and stays silent.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TIMEOUT_MS = 1500;
export const MAX_STRING = 2000;
const MAX_DEPTH = 4;
/** Tool outputs and file contents stay on the machine's disk; the office only needs metadata. */
const DROPPED_KEYS = new Set(['tool_response', 'content', 'new_string', 'old_string', 'edits']);

/**
 * Copy of the payload with bulky fields removed and long strings shortened.
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function slim(value, depth = 0) {
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (Array.isArray(value)) return depth >= MAX_DEPTH ? [] : value.slice(0, 50).map((item) => slim(item, depth + 1));
  if (value && typeof value === 'object') {
    if (depth >= MAX_DEPTH) return {};
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !DROPPED_KEYS.has(key))
        .map(([key, item]) => [key, slim(item, depth + 1)]),
    );
  }
  return value;
}

/** @param {Record<string, string | undefined>} env */
export function tokenFile(env) {
  if (env.VO_TOKEN_FILE) return env.VO_TOKEN_FILE;
  const configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configHome, 'virtual-office', 'token');
}

/**
 * Same address as the server (VO_HOST, VO_PORT), IPv6 in brackets.
 * @param {Record<string, string | undefined>} env
 */
export function serverUrl(env) {
  const host = env.VO_HOST || '127.0.0.1';
  return `http://${host.includes(':') ? `[${host}]` : host}:${env.VO_PORT || '4317'}`;
}

/** @param {any} error */
const isUnreachable = (error) => {
  const code = error?.cause?.code ?? error?.code;
  return code === 'ECONNREFUSED' || code === 'ENOENT' || error?.name === 'TimeoutError' || error?.name === 'AbortError';
};

/**
 * @param {{ input: string, env: Record<string, string | undefined>, fetchImpl?: typeof fetch }} options
 * @returns {Promise<string | null>} an error message worth reporting, or null
 */
export async function relay({ input, env, fetchImpl = fetch }) {
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return 'virtual-office : charge utile de hook illisible';
  }
  let token;
  try {
    token = readFileSync(tokenFile(env), 'utf8').trim();
  } catch (error) {
    return isUnreachable(error) ? null : `virtual-office : jeton illisible (${/** @type {Error} */ (error).message})`;
  }
  try {
    const response = await fetchImpl(`${serverUrl(env)}/api/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-virtual-office-token': token },
      body: JSON.stringify(slim(payload)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok) return null;
    const body = /** @type {{ error?: string }} */ (await response.json().catch(() => ({})));
    return `virtual-office : refusé (${response.status}) ${body.error ?? ''}`.trim();
  } catch (error) {
    return isUnreachable(error) ? null : `virtual-office : envoi en échec (${/** @type {Error} */ (error).message})`;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const problem = await relay({ input: await readStdin(), env: process.env });
    if (problem) process.stderr.write(`${problem}\n`);
  } catch (error) {
    process.stderr.write(`virtual-office : ${/** @type {Error} */ (error)?.message ?? error}\n`);
  }
  process.exit(0);
}
