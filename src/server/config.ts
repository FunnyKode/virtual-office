import os from 'node:os';
import path from 'node:path';

export interface Config {
  readonly host: string;
  readonly port: number;
  readonly projectsRoot: string;
  readonly tokenFile: string;
  readonly windowMs: number;
  readonly silenceMs: number;
  readonly scanIntervalMs: number;
  readonly maxInitialBytes: number;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** The server only listens on the loopback interface: transcripts never leave the machine. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

const HOUR = 3_600_000;
const MINUTE = 60_000;

export function defaultTokenFile(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config');
  return path.join(configHome, 'virtual-office', 'token');
}

function expandHome(value: string): string {
  return value.replace(/^~(?=\/|$)/, os.homedir());
}

function positiveNumber(env: NodeJS.ProcessEnv, key: string, fallback: number, { integer = false, max = Infinity } = {}): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > max || (integer && !Number.isInteger(value))) {
    throw new ConfigError(`${key} doit être un nombre positif${integer ? ' entier' : ''}${max < Infinity ? ` ≤ ${max}` : ''} (reçu « ${raw} »)`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env['VO_HOST'] || '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new ConfigError(`VO_HOST doit être une adresse locale (127.0.0.1, ::1, localhost), reçu « ${host} »`);
  }
  return {
    host,
    port: positiveNumber(env, 'VO_PORT', 4317, { integer: true, max: 65_535 }),
    projectsRoot: expandHome(env['VO_CLAUDE_PROJECTS'] || '~/.claude/projects'),
    tokenFile: expandHome(env['VO_TOKEN_FILE'] || defaultTokenFile(env)),
    windowMs: positiveNumber(env, 'VO_WINDOW_HOURS', 48) * HOUR,
    silenceMs: positiveNumber(env, 'VO_SILENCE_MINUTES', 15) * MINUTE,
    scanIntervalMs: positiveNumber(env, 'VO_SCAN_INTERVAL_MS', 1000, { integer: true }),
    maxInitialBytes: positiveNumber(env, 'VO_MAX_INITIAL_BYTES', 8 * 1024 * 1024, { integer: true }),
  };
}
