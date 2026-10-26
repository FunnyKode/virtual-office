import { appendFile, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createStore } from '../src/domain/store.ts';
import { createTranscriptCollector, type TranscriptCollectorOptions } from '../src/sources/transcript-collector.ts';
import { withTempDir } from './helpers.ts';

const HOUR = 3_600_000;
const SESSION = '11111111-2222-3333-4444-555555555555';

const userLine = (text: string, timestamp = new Date().toISOString()) =>
  `${JSON.stringify({ type: 'user', timestamp, cwd: '/repo', origin: { kind: 'human' }, message: { content: text } })}\n`;
const toolLine = (id: string) =>
  `${JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name: 'Grep', input: { pattern: 'TODO' } }], usage: { input_tokens: 3, output_tokens: 7 } } })}\n`;

function setup(root: string, onError = vi.fn(), extra: Partial<TranscriptCollectorOptions> = {}) {
  const store = createStore({ silenceMs: HOUR, windowMs: 48 * HOUR });
  const collector = createTranscriptCollector({ root, dispatch: (events) => store.dispatch(events), windowMs: 48 * HOUR, maxInitialBytes: 1 << 20, onError, ...extra });
  return { store, collector, onError };
}

describe('transcript collector', () => {
  it('discovers sessions and subagents, then reads only new lines', () =>
    withTempDir(async (root) => {
      const project = path.join(root, '-home-moi-projet');
      const subagents = path.join(project, SESSION, 'subagents');
      await mkdir(subagents, { recursive: true });
      await writeFile(path.join(project, `${SESSION}.jsonl`), userLine('Analyse le dépôt'));
      await writeFile(path.join(subagents, 'agent-abc.jsonl'), userLine('Cherche les TODO'));
      await writeFile(path.join(subagents, 'agent-abc.meta.json'), JSON.stringify({ description: 'Recherche des TODO', agentType: 'Explore' }));
      await writeFile(path.join(project, 'notes.txt'), 'ignoré');
      const { store, collector, onError } = setup(root);

      await collector.scan();
      const agents = store.state().agents;
      expect(agents[SESSION]).toMatchObject({ kind: 'session', status: 'working', cwd: '/repo', lastPrompt: 'Analyse le dépôt' });
      expect(agents[`${SESSION}/abc`]).toMatchObject({ kind: 'subagent', parentId: SESSION, title: 'Recherche des TODO', agentType: 'Explore' });
      expect(collector.trackedFiles()).toHaveLength(2);

      await appendFile(path.join(subagents, 'agent-abc.jsonl'), toolLine('tu1'));
      await collector.scan();
      await collector.scan();
      expect(store.state().agents[`${SESSION}/abc`]).toMatchObject({ toolCalls: 1, tokens: { input: 3, output: 7 }, currentTool: { name: 'Grep' } });
      expect(onError).not.toHaveBeenCalled();
    }));

  it('skips transcripts older than the window and forgets deleted ones', () =>
    withTempDir(async (root) => {
      const project = path.join(root, 'p');
      await mkdir(project);
      const old = path.join(project, 'ancienne.jsonl');
      await writeFile(old, userLine('vieux', '2020-01-01T00:00:00.000Z'));
      const past = new Date(Date.now() - 72 * HOUR);
      await utimes(old, past, past);
      const live = path.join(project, 'vivante.jsonl');
      await writeFile(live, userLine('récent'));
      const { store, collector } = setup(root);

      await collector.scan();
      expect(Object.keys(store.state().agents)).toEqual(['vivante']);
      await rm(live);
      await collector.scan();
      expect(collector.trackedFiles()).toEqual([]);
    }));

  it('picks up subagent metadata written after the transcript', () =>
    withTempDir(async (root) => {
      const subagents = path.join(root, 'p', SESSION, 'subagents');
      await mkdir(subagents, { recursive: true });
      await writeFile(path.join(subagents, 'agent-late.jsonl'), userLine('go'));
      const { store, collector } = setup(root, vi.fn(), { discoveryEveryMs: 0 });
      await collector.scan();
      expect(store.state().agents[`${SESSION}/late`]?.title).toBeNull();
      await writeFile(path.join(subagents, 'agent-late.meta.json'), JSON.stringify({ description: 'Arrivée tardive', agentType: 'Plan' }));
      await collector.scan();
      expect(store.state().agents[`${SESSION}/late`]).toMatchObject({ title: 'Arrivée tardive', agentType: 'Plan' });
    }));

  it('puts idle files to sleep and resumes them from where they stopped', () =>
    withTempDir(async (root) => {
      await mkdir(path.join(root, 'p'));
      const file = path.join(root, 'p', 'dort.jsonl');
      await writeFile(file, userLine('premier'));
      let now = Date.now();
      const { store, collector } = setup(root, vi.fn(), { discoveryEveryMs: 0, now: () => now });
      await collector.scan();
      now += 49 * HOUR;
      await collector.scan();
      expect(collector.trackedFiles()).toEqual([]);
      await appendFile(file, userLine('second'));
      now = Date.now();
      await collector.scan();
      await collector.scan();
      expect(collector.trackedFiles()).toEqual([file]);
      expect(store.state().agents['dort']?.lastPrompt).toBe('second');
    }));

  it('lists directories only every discovery period', () =>
    withTempDir(async (root) => {
      await mkdir(path.join(root, 'p'));
      let now = 0;
      const { collector } = setup(root, vi.fn(), { discoveryEveryMs: 5000, now: () => now });
      await collector.scan();
      await writeFile(path.join(root, 'p', 'nouvelle.jsonl'), userLine('salut'));
      now = 4000;
      await collector.scan();
      expect(collector.trackedFiles()).toEqual([]);
      now = Date.now();
      await collector.scan();
      expect(collector.trackedFiles()).toHaveLength(1);
    }));

  it('reports a failing dispatch instead of rejecting', () =>
    withTempDir(async (root) => {
      const onError = vi.fn();
      const collector = createTranscriptCollector({ root, windowMs: HOUR, maxInitialBytes: 1024, onError, dispatch: () => { throw new Error('store en panne'); } });
      await expect(collector.scan()).resolves.toBeUndefined();
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'store en panne' }), root);
      await collector.stop();
    }));

  it('never runs two scans at once', () =>
    withTempDir(async (root) => {
      const { collector } = setup(root);
      const first = collector.scan();
      expect(collector.scan()).toBe(first);
      await first;
    }));

  it('tolerates a missing root and unreadable metadata', () =>
    withTempDir(async (root) => {
      const project = path.join(root, 'p');
      await mkdir(path.join(project, SESSION, 'subagents'), { recursive: true });
      await writeFile(path.join(project, SESSION, 'subagents', 'agent-x.jsonl'), userLine('go'));
      await writeFile(path.join(project, SESSION, 'subagents', 'agent-x.meta.json'), '{pas du json');
      const { store, collector, onError } = setup(root);
      await collector.scan();
      expect(store.state().agents[`${SESSION}/x`]).toMatchObject({ title: null, agentType: null });

      const missing = setup(path.join(root, 'absent'));
      await missing.collector.scan();
      expect(missing.onError).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    }));

  it('reports a root that cannot be listed', () =>
    withTempDir(async (root) => {
      const file = path.join(root, 'pas-un-dossier');
      await writeFile(file, '');
      const blocked = path.join(root, 'bloque');
      await mkdir(blocked, { mode: 0o000 });
      const { collector, onError } = setup(blocked);
      await collector.scan();
      // Running as root bypasses permissions; the assertion only holds for a normal user.
      if (process.getuid?.() !== 0) expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'EACCES' }), blocked);
    }));

  it('scans on an interval until stopped', () =>
    withTempDir(async (root) => {
      vi.useFakeTimers();
      try {
        const { collector } = setup(root);
        const scan = vi.spyOn(collector, 'scan');
        collector.start(1000);
        collector.start(1000);
        await vi.advanceTimersByTimeAsync(3100);
        await collector.stop();
        await vi.advanceTimersByTimeAsync(3000);
        expect(scan).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    }));
});
