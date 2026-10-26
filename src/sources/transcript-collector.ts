// Discovers Claude Code transcripts and feeds their new lines to the store.
// Layout: <root>/<project>/<sessionId>.jsonl and <root>/<project>/<sessionId>/subagents/agent-<id>.jsonl
// (+ agent-<id>.meta.json). Each scan only reads bytes appended since the previous one.
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { sessionKey, subagentKey } from '../domain/ids.ts';
import type { AgentEvent } from '../domain/types.ts';
import { createTranscriptParser, type TranscriptContext, type TranscriptParser } from './claude-transcript.ts';
import { createLineReader, type LineReader } from './line-reader.ts';

export interface TranscriptCollectorOptions {
  readonly root: string;
  readonly dispatch: (events: readonly AgentEvent[]) => void;
  readonly windowMs: number;
  readonly maxInitialBytes: number;
  readonly now?: () => number;
  readonly onError?: (error: unknown, file: string) => void;
  /** Listing directories costs more than reading known files: new transcripts are looked for less often. */
  readonly discoveryEveryMs?: number;
}

export const DEFAULT_DISCOVERY_EVERY_MS = 5_000;

export interface TranscriptCollector {
  /** Never rejects: failures go to onError. */
  scan(): Promise<void>;
  start(intervalMs: number): void;
  /** Stops the timer and waits for a scan in progress. */
  stop(): Promise<void>;
  trackedFiles(): readonly string[];
}

interface Tracked {
  readonly reader: LineReader;
  readonly parser: TranscriptParser;
}

interface Candidate {
  readonly file: string;
  readonly context: TranscriptContext;
  readonly metaFile: string | null;
}

const SESSION_FILE = /^([A-Za-z0-9_-]+)\.jsonl$/;
const SUBAGENT_FILE = /^agent-([A-Za-z0-9_-]+)\.jsonl$/;

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

async function listDir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return [];
    throw error;
  }
}

async function discover(root: string): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for (const project of await listDir(root)) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(root, project.name);
    for (const entry of await listDir(projectDir)) {
      const session = SESSION_FILE.exec(entry.name);
      if (entry.isFile() && session?.[1]) {
        const sessionId = session[1];
        candidates.push({
          file: path.join(projectDir, entry.name),
          context: { agentId: sessionKey(sessionId), sessionId, kind: 'session', parentId: null },
          metaFile: null,
        });
      } else if (entry.isDirectory() && SESSION_FILE.test(`${entry.name}.jsonl`)) {
        const sessionId = entry.name;
        const subagentsDir = path.join(projectDir, sessionId, 'subagents');
        for (const sub of await listDir(subagentsDir)) {
          const match = SUBAGENT_FILE.exec(sub.name);
          if (!sub.isFile() || !match?.[1]) continue;
          const file = path.join(subagentsDir, sub.name);
          candidates.push({
            file,
            context: { agentId: subagentKey(sessionId, match[1]), sessionId, kind: 'subagent', parentId: sessionKey(sessionId) },
            metaFile: file.replace(/\.jsonl$/, '.meta.json'),
          });
        }
      }
    }
  }
  return candidates;
}

async function readMeta(metaFile: string | null): Promise<{ title: string | null; agentType: string | null }> {
  if (!metaFile) return { title: null, agentType: null };
  try {
    const meta: unknown = JSON.parse(await readFile(metaFile, 'utf8'));
    const record = typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>) : {};
    const text = (key: string) => (typeof record[key] === 'string' ? (record[key] as string) : null);
    return { title: text('description'), agentType: text('agentType') };
  } catch {
    return { title: null, agentType: null };
  }
}

function seenEvent(candidate: Candidate, at: number, meta: { title: string | null; agentType: string | null }): AgentEvent {
  const { context } = candidate;
  return {
    at,
    agentId: context.agentId,
    source: 'transcript',
    type: 'agent.seen',
    kind: context.kind,
    sessionId: context.sessionId,
    parentId: context.parentId,
    title: meta.title,
    agentType: meta.agentType,
  };
}

export function createTranscriptCollector(options: TranscriptCollectorOptions): TranscriptCollector {
  const now = options.now ?? Date.now;
  const discoveryEveryMs = options.discoveryEveryMs ?? DEFAULT_DISCOVERY_EVERY_MS;
  /** Files read on every scan. */
  const active = new Map<string, Tracked>();
  /** Files idle for longer than the window: checked only at discovery, resumed from their offset. */
  const dormant = new Map<string, Tracked>();
  /** Subagents whose .meta.json was not there yet (it can be written after the transcript). */
  const metaPending = new Map<string, Candidate>();
  let lastDiscovery = -Infinity;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;

  const report = (error: unknown, file: string) => options.onError?.(error, file);

  async function track(candidate: Candidate): Promise<AgentEvent[]> {
    const sleeping = dormant.get(candidate.file);
    const info = await stat(candidate.file);
    if (now() - info.mtimeMs > options.windowMs) return [];
    if (sleeping) {
      dormant.delete(candidate.file);
      active.set(candidate.file, sleeping);
      return [];
    }
    const meta = await readMeta(candidate.metaFile);
    if (candidate.metaFile && meta.title === null) metaPending.set(candidate.file, candidate);
    active.set(candidate.file, {
      reader: createLineReader(candidate.file, { maxInitialBytes: options.maxInitialBytes }),
      parser: createTranscriptParser(candidate.context, now),
    });
    return [seenEvent(candidate, info.birthtimeMs || info.mtimeMs, meta)];
  }

  async function retryMeta(): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for (const [file, candidate] of metaPending) {
      const meta = await readMeta(candidate.metaFile);
      if (meta.title === null) continue;
      metaPending.delete(file);
      events.push(seenEvent(candidate, now(), meta));
    }
    return events;
  }

  async function discovery(): Promise<AgentEvent[]> {
    lastDiscovery = now();
    const events: AgentEvent[] = [];
    let candidates: Candidate[] = [];
    try {
      candidates = await discover(options.root);
    } catch (error) {
      report(error, options.root);
    }
    for (const candidate of candidates) {
      if (active.has(candidate.file)) continue;
      try {
        events.push(...(await track(candidate)));
      } catch (error) {
        if (!isMissing(error)) report(error, candidate.file);
      }
    }
    return [...events, ...(await retryMeta())];
  }

  async function readActive(file: string, entry: Tracked): Promise<AgentEvent[]> {
    const result = await entry.reader.read();
    if (!result.exists) {
      active.delete(file);
      metaPending.delete(file);
      return [];
    }
    if (result.lines.length === 0 && now() - result.modifiedMs > options.windowMs) {
      active.delete(file);
      dormant.set(file, entry);
    }
    return result.lines.flatMap((line) => entry.parser.parseLine(line));
  }

  async function scanOnce(): Promise<void> {
    const elapsed = now() - lastDiscovery;
    // A clock set back (NTP) must not postpone discovery until it catches up.
    const events: AgentEvent[] = elapsed >= discoveryEveryMs || elapsed < 0 ? await discovery() : [];
    for (const [file, entry] of active) {
      try {
        events.push(...(await readActive(file, entry)));
      } catch (error) {
        report(error, file);
      }
    }
    try {
      options.dispatch(events);
    } catch (error) {
      report(error, options.root);
    }
  }

  const collector: TranscriptCollector = {
    scan() {
      // Never two scans at once: a slow disk must not make reads overlap and duplicate lines.
      running ??= scanOnce()
        .catch((error: unknown) => report(error, options.root))
        .finally(() => {
          running = null;
        });
      return running;
    },
    start(intervalMs) {
      if (timer) return;
      timer = setInterval(() => void collector.scan(), intervalMs);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
    trackedFiles: () => [...active.keys()],
  };
  return collector;
}
