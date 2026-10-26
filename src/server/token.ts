// Shared secret between the server and the hook relay, stored in a file only the user can read.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

const EMPTY_FILE_RETRIES = 5;
const EMPTY_FILE_DELAY_MS = 20;

async function readToken(file: string): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    let info;
    let token: string;
    try {
      info = await stat(file);
      token = (await readFile(file, 'utf8')).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    // Another process created the file but has not written it yet.
    if (token === '' && attempt < EMPTY_FILE_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, EMPTY_FILE_DELAY_MS));
      continue;
    }
    if (!TOKEN_PATTERN.test(token)) throw new Error(`jeton illisible dans ${file} : supprimez le fichier pour en générer un nouveau`);
    if ((info.mode & 0o077) !== 0) throw new Error(`${file} est lisible par d'autres utilisateurs : chmod 600 "${file}"`);
    return token;
  }
}

export async function ensureToken(file: string): Promise<string> {
  const existing = await readToken(file);
  if (existing) return existing;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  try {
    await writeFile(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
    return token;
  } catch (error) {
    // Another process created it first: use theirs.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return (await readToken(file)) ?? token;
    throw error;
  }
}

export function tokenMatches(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
