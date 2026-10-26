import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cspFor, resolveStatic, type StaticTree } from '../src/server/static.ts';
import { withTempDir } from './helpers.ts';

describe('resolveStatic', () => {
  it('serves allowed files under their prefix only', () =>
    withTempDir(async (dir) => {
      const root = path.join(dir, 'site');
      await mkdir(path.join(root, 'sub'), { recursive: true });
      await writeFile(path.join(root, 'sub', 'a.js'), 'x');
      await writeFile(path.join(root, 'b.css'), 'x');
      await writeFile(path.join(root, 'secret.json'), '{}');
      await writeFile(path.join(dir, 'outside.js'), 'x');
      await symlink(path.join(dir, 'outside.js'), path.join(root, 'lien.js'));
      const trees: StaticTree[] = [{ prefix: '/s/', root, maxAgeSeconds: 0, allow: (relative) => !relative.startsWith('interdit') }];

      expect(await resolveStatic('/s/sub/a.js', trees)).toMatchObject({ file: path.join(root, 'sub', 'a.js'), type: 'text/javascript; charset=utf-8' });
      expect(await resolveStatic('/s/b.css', trees)).toMatchObject({ type: 'text/css; charset=utf-8' });
      for (const refused of ['/s/secret.json', '/s/../outside.js', '/s/sub/../../outside.js', '/s/lien.js', '/s/absent.js', '/s/sub', '/s/', '/s/%E0.js', '/s/a%00.js', '/s/sub\\a.js', '/s/interdit.js', '/autre/a.js']) {
        expect(await resolveStatic(refused, trees), refused).toBeNull();
      }
    }));
});

describe('cspFor', () => {
  it('allows each inline import map by hash and nothing else inline', () => {
    const csp = cspFor('<script type="importmap">{"imports":{}}</script><script>alert(1)</script>');
    expect(csp).toContain("script-src 'self' 'sha256-");
    expect(csp.match(/'sha256-/g)).toHaveLength(1);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(cspFor('<p>rien</p>')).toContain("script-src 'self';");
  });
});
