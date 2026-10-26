import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, defaultTokenFile, loadConfig } from '../src/server/config.ts';
import { createLogger } from '../src/server/logger.ts';
import { ensureToken, tokenMatches } from '../src/server/token.ts';
import { withTempDir } from './helpers.ts';

describe('config', () => {
  it('has safe defaults', () => {
    expect(loadConfig({})).toEqual({
      host: '127.0.0.1',
      port: 4317,
      projectsRoot: path.join(os.homedir(), '.claude', 'projects'),
      tokenFile: path.join(os.homedir(), '.config', 'virtual-office', 'token'),
      windowMs: 48 * 3_600_000,
      silenceMs: 15 * 60_000,
      scanIntervalMs: 1000,
      maxInitialBytes: 8 * 1024 * 1024,
    });
  });

  it('reads overrides and expands ~', () => {
    const config = loadConfig({ VO_HOST: '::1', VO_PORT: '5000', VO_CLAUDE_PROJECTS: '~/ailleurs', VO_WINDOW_HOURS: '0.5', XDG_CONFIG_HOME: '/cfg' });
    expect(config).toMatchObject({ host: '::1', port: 5000, projectsRoot: path.join(os.homedir(), 'ailleurs'), windowMs: 1_800_000, tokenFile: '/cfg/virtual-office/token' });
    expect(defaultTokenFile({ XDG_CONFIG_HOME: '/x' })).toBe('/x/virtual-office/token');
  });

  it.each([
    [{ VO_HOST: '0.0.0.0' }, /adresse locale/],
    [{ VO_PORT: '70000' }, /VO_PORT/],
    [{ VO_PORT: '12.5' }, /entier/],
    [{ VO_SILENCE_MINUTES: '-1' }, /VO_SILENCE_MINUTES/],
    [{ VO_SCAN_INTERVAL_MS: 'vite' }, /VO_SCAN_INTERVAL_MS/],
  ])('rejects %j with a clear message', (env, message) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(message);
  });
});

describe('token', () => {
  it('creates a private token once, then reuses it', () =>
    withTempDir(async (dir) => {
      const file = path.join(dir, 'sous', 'token');
      const first = await ensureToken(file);
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect(await ensureToken(file)).toBe(first);
      const [a, b] = await Promise.all([ensureToken(path.join(dir, 'course')), ensureToken(path.join(dir, 'course'))]);
      expect(a).toBe(b);
      expect((await readFile(path.join(dir, 'course'), 'utf8')).trim()).toBe(a);
    }));

  it('refuses a token file readable by other users', () =>
    withTempDir(async (dir) => {
      const file = path.join(dir, 'token');
      await writeFile(file, 'e'.repeat(64), { mode: 0o644 });
      await chmod(file, 0o644);
      await expect(ensureToken(file)).rejects.toThrow(/chmod 600/);
    }));

  it('waits for a token file that another process is still writing', () =>
    withTempDir(async (dir) => {
      const file = path.join(dir, 'token');
      await writeFile(file, '', { mode: 0o600 });
      setTimeout(() => void writeFile(file, 'f'.repeat(64)), 30);
      await expect(ensureToken(file)).resolves.toBe('f'.repeat(64));
    }));

  it('refuses a corrupted token file', () =>
    withTempDir(async (dir) => {
      const file = path.join(dir, 'token');
      await writeFile(file, 'trop-court');
      await expect(ensureToken(file)).rejects.toThrow(/jeton illisible/);
    }));

  it('compares tokens in constant time and rejects non-strings', () => {
    const token = 'c'.repeat(64);
    expect(tokenMatches(token, token)).toBe(true);
    expect(tokenMatches('c'.repeat(63), token)).toBe(false);
    expect(tokenMatches(['x'], token)).toBe(false);
    expect(tokenMatches(undefined, token)).toBe(false);
  });
});

describe('logger', () => {
  it('writes one JSON object per line and serialises errors', () => {
    const lines: string[] = [];
    const logger = createLogger((line) => lines.push(line));
    logger.info('prêt', { port: 1 });
    logger.error('échec', { error: new Error('disque plein') });
    const [info, error] = lines.map((line) => JSON.parse(line));
    expect(info).toMatchObject({ level: 'info', message: 'prêt', port: 1 });
    expect(error).toMatchObject({ level: 'error', error: { name: 'Error', message: 'disque plein' } });
    expect(lines.every((line) => line.endsWith('\n'))).toBe(true);
  });
});
