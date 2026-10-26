// Static files under fixed prefixes, without path traversal, symlink escapes or unexpected types.
import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export interface StaticTree {
  /** URL prefix, ending with "/". */
  readonly prefix: string;
  /** Directory served under the prefix. */
  readonly root: string;
  /** Extra filter on the path relative to the root (posix separators). */
  readonly allow?: (relative: string) => boolean;
  readonly maxAgeSeconds: number;
}

export interface StaticFile {
  readonly file: string;
  readonly type: string;
  readonly maxAgeSeconds: number;
}

const TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function relativePath(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const normalized = path.posix.normalize(decoded);
  if (normalized.startsWith('..') || path.posix.isAbsolute(normalized) || normalized === '.') return null;
  return normalized;
}

async function insideRoot(file: string, root: string): Promise<boolean> {
  try {
    const [realFile, realRoot] = await Promise.all([realpath(file), realpath(root)]);
    return realFile.startsWith(realRoot + path.sep) && (await stat(realFile)).isFile();
  } catch {
    return false;
  }
}

/** The file to serve for a URL path, or null when it is not a servable file. */
export async function resolveStatic(pathname: string, trees: readonly StaticTree[]): Promise<StaticFile | null> {
  for (const tree of trees) {
    const relative = relativePath(pathname, tree.prefix);
    if (relative === null) continue;
    const type = TYPES[path.posix.extname(relative)];
    if (!type || (tree.allow && !tree.allow(relative))) return null;
    const file = path.resolve(tree.root, ...relative.split('/'));
    if (!(await insideRoot(file, tree.root))) return null;
    return { file, type, maxAgeSeconds: tree.maxAgeSeconds };
  }
  return null;
}

const BASE_CSP = {
  'default-src': "'none'",
  'script-src': "'self'",
  'style-src': "'self'",
  'connect-src': "'self'",
  'img-src': "'self'",
  'base-uri': "'none'",
  'form-action': "'none'",
  'frame-ancestors': "'none'",
} as const;

const IMPORT_MAP = /<script type="importmap">([\s\S]*?)<\/script>/g;

/**
 * Content-Security-Policy for an HTML page. Inline import maps (needed for Three.js addons,
 * which import the bare name "three") are allowed by their exact hash, never by 'unsafe-inline'.
 */
export function cspFor(html: string): string {
  const hashes = [...html.matchAll(IMPORT_MAP)].map((match) => `'sha256-${createHash('sha256').update(match[1] ?? '').digest('base64')}'`);
  const directives: Record<string, string> = { ...BASE_CSP, 'script-src': ["'self'", ...hashes].join(' ') };
  return Object.entries(directives).map(([name, value]) => `${name} ${value}`).join('; ');
}
