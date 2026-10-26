import { spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyHookInstall } from '../scripts/install-hooks.ts';
import { MARKER, OTHER_EVENTS, TOOL_EVENTS, installRelay, relayCommand, removeRelay } from '../src/install/hook-settings.ts';
import { deepFreeze, withTempDir } from './helpers.ts';

const RELAY = '/opt/virtual office/hooks/relay.mjs';
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'install-hooks.ts');
const cli = (args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
const foreign = { type: 'command', command: 'node lint.js' };

describe('hook settings', () => {
  it('adds the relay to every event, keeping other settings and hooks', () => {
    const settings = deepFreeze({ model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [foreign] }] } });
    const result = installRelay(settings, RELAY) as { model: string; hooks: Record<string, any[]> };
    expect(result.model).toBe('opus');
    expect(Object.keys(result.hooks).sort()).toEqual([...TOOL_EVENTS, ...OTHER_EVENTS].sort());
    expect(result.hooks['PreToolUse']).toEqual([
      { matcher: 'Bash', hooks: [foreign] },
      { matcher: '*', hooks: [{ type: 'command', command: relayCommand(RELAY), timeout: 5 }] },
    ]);
    expect(result.hooks['Stop']).toEqual([{ hooks: [{ type: 'command', command: relayCommand(RELAY), timeout: 5 }] }]);
    expect(relayCommand(RELAY)).toBe(`node "/opt/virtual office/hooks/relay.mjs" ${MARKER}`);
  });

  it('is idempotent and replaces a relay installed from another path', () => {
    const once = installRelay({}, '/ancien/relay.mjs');
    const twice = installRelay(installRelay(once, RELAY), RELAY);
    expect(twice).toEqual(installRelay({}, RELAY));
  });

  it('removes only its own entries', () => {
    const installed = installRelay({ hooks: { Stop: [{ hooks: [foreign] }], Bizarre: 'pas une liste' } }, RELAY);
    expect(removeRelay(installed)).toEqual({ hooks: { Stop: [{ hooks: [foreign] }] } });
    expect(removeRelay(installRelay({ theme: 'dark' }, RELAY))).toEqual({ theme: 'dark' });
    expect(() => installRelay({ hooks: [] }, RELAY)).toThrow(/n’est pas un objet/);
  });
});

describe('install script', () => {
  it('writes atomically with a backup, and reports when nothing changes', () =>
    withTempDir(async (dir) => {
      const file = path.join(dir, 'settings.json');
      await writeFile(file, JSON.stringify({ theme: 'dark' }));
      const now = () => new Date('2026-10-26T12:00:00.000Z');
      const first = await applyHookInstall({ settingsFile: file, relayPath: RELAY, uninstall: false, dryRun: false, now });
      expect(first.changed).toBe(true);
      expect(first.backup).toBe(`${file}.bak-2026-10-26T12-00-00-000Z`);
      expect(JSON.parse(await readFile(first.backup!, 'utf8'))).toEqual({ theme: 'dark' });
      expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ theme: 'dark', hooks: { Stop: expect.any(Array) } });

      const again = await applyHookInstall({ settingsFile: file, relayPath: RELAY, uninstall: false, dryRun: false });
      expect(again).toMatchObject({ changed: false, backup: null });

      await applyHookInstall({ settingsFile: file, relayPath: RELAY, uninstall: true, dryRun: false, now: () => new Date(1) });
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ theme: 'dark' });
      expect((await readdir(dir)).filter((name) => name.includes('.tmp-'))).toEqual([]);
    }));

  it('simulates without touching the disk, and creates a missing file without backup', () =>
    withTempDir(async (dir) => {
      const file = path.join(dir, 'settings.json');
      const dry = await applyHookInstall({ settingsFile: file, relayPath: RELAY, uninstall: false, dryRun: true });
      expect(dry.changed).toBe(true);
      expect(await readdir(dir)).toEqual([]);
      const real = await applyHookInstall({ settingsFile: file, relayPath: RELAY, uninstall: false, dryRun: false });
      expect(real.backup).toBeNull();
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(JSON.parse(dry.content));
    }));

  it('runs as a command: simulation, install, reinstall, uninstall, error', () =>
    withTempDir(async (dir) => {
      const file = path.join(dir, 'settings.json');
      const dry = cli(['--settings', file, '--dry-run']);
      expect(dry.status).toBe(0);
      expect(JSON.parse(dry.stdout).hooks.Stop[0].hooks[0].command).toMatch(/hooks\/relay\.mjs" --virtual-office$/);
      expect(dry.stderr).toMatch(/Simulation/);
      expect(cli(['--settings', file]).stderr).toMatch(/Hooks installés dans/);
      expect(cli(['--settings', file]).stderr).toMatch(/Rien à changer/);
      expect(cli(['--settings', file, '--uninstall']).stderr).toMatch(/retirés de .*sauvegarde/);
      await writeFile(file, 'pas du json');
      const broken = cli(['--settings', file]);
      expect(broken.status).toBe(1);
      expect(broken.stderr).toMatch(/^install-hooks : /);
    }));

  it('refuses a settings file that is not a JSON object', () =>
    withTempDir(async (dir) => {
      const file = path.join(dir, 'settings.json');
      await writeFile(file, '[]');
      await expect(applyHookInstall({ settingsFile: file, relayPath: RELAY, uninstall: false, dryRun: false })).rejects.toThrow(/objet JSON/);
    }));
});
