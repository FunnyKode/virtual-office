// Usage : node scripts/install-hooks.ts [--settings <fichier>] [--uninstall] [--dry-run]
// Par défaut : ~/.claude/settings.json. Une copie de sauvegarde est faite avant toute écriture.
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { installRelay, removeRelay } from '../src/install/hook-settings.ts';

export interface InstallOptions {
  readonly settingsFile: string;
  readonly relayPath: string;
  readonly uninstall: boolean;
  readonly dryRun: boolean;
  readonly now?: () => Date;
}

export interface InstallResult {
  readonly changed: boolean;
  readonly backup: string | null;
  readonly content: string;
}

async function readSettings(file: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${file} ne contient pas un objet JSON`);
  return parsed as Record<string, unknown>;
}

export async function applyHookInstall(options: InstallOptions): Promise<InstallResult> {
  const current = await readSettings(options.settingsFile);
  const next = options.uninstall ? removeRelay(current ?? {}) : installRelay(current ?? {}, options.relayPath);
  const content = `${JSON.stringify(next, null, 2)}\n`;
  const changed = JSON.stringify(current ?? {}) !== JSON.stringify(next);
  if (!changed || options.dryRun) return { changed, backup: null, content };

  let backup: string | null = null;
  if (current) {
    const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
    backup = `${options.settingsFile}.bak-${stamp}`;
    await copyFile(options.settingsFile, backup);
  }
  const temporary = `${options.settingsFile}.tmp-${process.pid}`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, options.settingsFile);
  return { changed, backup, content };
}

async function cli(): Promise<void> {
  const { values } = parseArgs({
    options: {
      settings: { type: 'string', default: path.join(os.homedir(), '.claude', 'settings.json') },
      uninstall: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const relayPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'relay.mjs');
  const result = await applyHookInstall({
    settingsFile: path.resolve(values.settings),
    relayPath,
    uninstall: values.uninstall,
    dryRun: values['dry-run'],
  });
  if (values['dry-run']) process.stdout.write(result.content);
  const verb = values.uninstall ? 'retirés de' : 'installés dans';
  process.stderr.write(
    !result.changed
      ? `Rien à changer dans ${values.settings}.\n`
      : values['dry-run']
        ? `Simulation : les hooks seraient ${verb} ${values.settings}.\n`
        : `Hooks ${verb} ${values.settings}${result.backup ? ` (sauvegarde : ${result.backup})` : ''}.\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((error: unknown) => {
    process.stderr.write(`install-hooks : ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
