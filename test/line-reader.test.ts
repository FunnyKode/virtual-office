import { appendFile, rename, rm, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLineReader } from '../src/sources/line-reader.ts';
import { withTempDir } from './helpers.ts';

describe('line reader', () => {
  it('returns only complete lines appended since the previous read', () =>
    withTempDir(async (dir) => {
      const file = path.join(dir, 't.jsonl');
      await writeFile(file, 'a\nb\npar');
      const reader = createLineReader(file);
      expect((await reader.read()).lines).toEqual(['a', 'b']);
      expect((await reader.read()).lines).toEqual([]);
      await appendFile(file, 'tiel\r\n\nc\n');
      expect((await reader.read()).lines).toEqual(['partiel', 'c']);
    }));

  it('keeps a UTF-8 character split across two writes intact', () =>
    withTempDir(async (dir) => {
      const file = path.join(dir, 't.jsonl');
      const bytes = Buffer.from('été\n', 'utf8');
      await writeFile(file, bytes.subarray(0, 1));
      const reader = createLineReader(file);
      expect((await reader.read()).lines).toEqual([]);
      await appendFile(file, bytes.subarray(1));
      expect((await reader.read()).lines).toEqual(['été']);
    }));

  it('starts near the end of a large file and drops the cut first line', () =>
    withTempDir(async (dir) => {
      const file = path.join(dir, 't.jsonl');
      await writeFile(file, 'premiere-ligne-longue\nderniere\n');
      const reader = createLineReader(file, { maxInitialBytes: 12 });
      expect((await reader.read()).lines).toEqual(['derniere']);
    }));

  it('restarts from the beginning after truncation or replacement', () =>
    withTempDir(async (dir) => {
      const file = path.join(dir, 't.jsonl');
      await writeFile(file, 'un\ndeux\n');
      const reader = createLineReader(file);
      await reader.read();
      await truncate(file, 0);
      await writeFile(file, 'trois\n');
      expect(await reader.read()).toMatchObject({ lines: ['trois'], restarted: true, exists: true, modifiedMs: expect.any(Number) });

      const other = path.join(dir, 'autre.jsonl');
      await writeFile(other, 'quatre\ncinq\nsix\n');
      await rename(other, file);
      expect(await reader.read()).toMatchObject({ lines: ['quatre', 'cinq', 'six'], restarted: true });
    }));

  it('reports a missing file without throwing', () =>
    withTempDir(async (dir) => {
      const file = path.join(dir, 't.jsonl');
      const reader = createLineReader(file);
      expect(await reader.read()).toEqual({ lines: [], restarted: false, exists: false, modifiedMs: 0 });
      await writeFile(file, 'x\n');
      expect((await reader.read()).lines).toEqual(['x']);
      await rm(file);
      expect((await reader.read()).exists).toBe(false);
    }));

  it('reads files larger than one chunk', () =>
    withTempDir(async (dir) => {
      const file = path.join(dir, 't.jsonl');
      const line = 'y'.repeat(1000);
      await writeFile(file, `${Array.from({ length: 1500 }, () => line).join('\n')}\n`);
      const { lines } = await createLineReader(file).read();
      expect(lines).toHaveLength(1500);
      expect(lines.every((l) => l === line)).toBe(true);
    }));
});
