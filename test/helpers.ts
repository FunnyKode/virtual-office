import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent } from '../src/domain/types.ts';

type Body<T extends AgentEvent['type']> = Omit<Extract<AgentEvent, { type: T }>, 'type' | 'at' | 'agentId' | 'source'>;

/** Builds an event with sensible defaults: agent "s1", source "hook". */
export function ev<T extends AgentEvent['type']>(
  type: T,
  at: number,
  body: Body<T>,
  agentId = 's1',
  source: AgentEvent['source'] = 'hook',
): AgentEvent {
  return { type, at, agentId, source, ...body } as AgentEvent;
}

export async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'virtual-office-test-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Deeply freezes a value so a test fails if code under test mutates it. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}
