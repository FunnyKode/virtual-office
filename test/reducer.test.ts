import { describe, expect, it } from 'vitest';
import { EMPTY_OFFICE, TEXT_LIMIT, TOOL_ID_MEMORY, agentOf, reduce, reduceAll } from '../src/domain/reducer.ts';
import type { OfficeState } from '../src/domain/types.ts';
import { deepFreeze, ev } from './helpers.ts';

const agent = (state: OfficeState, id = 's1') => {
  const found = state.agents[id];
  if (!found) throw new Error(`agent ${id} absent`);
  return found;
};

describe('reduce', () => {
  it('creates a session on its first event and keeps the input state untouched', () => {
    const before = deepFreeze(EMPTY_OFFICE);
    const after = reduce(before, ev('prompt', 1000, { text: 'Bonjour' }));
    expect(before.agents).toEqual({});
    expect(agent(after)).toMatchObject({ kind: 'session', sessionId: 's1', parentId: null, status: 'working', lastPrompt: 'Bonjour', startedAt: 1000 });
  });

  it('lets the first status event win even if it is older than the agent discovery', () => {
    const state = reduceAll(EMPTY_OFFICE, [
      ev('agent.seen', 100, { kind: 'session', sessionId: 's1', parentId: null }, 's1', 'transcript'),
      ev('prompt', 99, { text: 'écrit juste avant la création du fichier' }, 's1', 'transcript'),
    ]);
    expect(agent(state)).toMatchObject({ status: 'working', startedAt: 99 });
  });

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('treats the id "%s" as an ordinary agent', (id) => {
    const state = reduceAll(EMPTY_OFFICE, [
      ev('prompt', 1, { text: 'x' }, id),
      ev('usage', 2, { model: null, input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, id),
    ]);
    expect(agentOf(state, id)).toMatchObject({ id, status: 'working', startedAt: 1, tokens: { output: 2 } });
    expect(agentOf(EMPTY_OFFICE, id)).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('keeps showing a tool while parallel tools finish', () => {
    const state = reduceAll(EMPTY_OFFICE, [
      ev('tool.start', 1, { toolUseId: 'A', name: 'Bash', summary: 'Bash long' }),
      ev('tool.start', 2, { toolUseId: 'B', name: 'Read', summary: 'Read a' }),
      ev('tool.end', 3, { toolUseId: 'B', isError: false }),
    ]);
    expect(agent(state)).toMatchObject({ status: 'working', currentTool: { id: 'A' }, runningTools: [{ id: 'A' }] });
    const late = reduce(state, ev('tool.start', 0, { toolUseId: 'C', name: 'Grep', summary: 'Grep' }, 's1', 'transcript'));
    expect(agent(late).currentTool?.id).toBe('A');
    expect(agent(reduce(late, ev('turn.end', 4, {}))).runningTools).toEqual([]);
  });

  it('derives subagent identity and parent from the agent key', () => {
    const state = reduce(EMPTY_OFFICE, ev('tool.start', 5, { toolUseId: 't', name: 'Read', summary: 'Read a.ts' }, 's1/abc'));
    expect(agent(state, 's1/abc')).toMatchObject({ kind: 'subagent', sessionId: 's1', parentId: 's1' });
  });

  it('follows a full turn: prompt, tool, permission, tool end, stop', () => {
    const state = reduceAll(EMPTY_OFFICE, [
      ev('prompt', 1, { text: 'go' }),
      ev('tool.start', 2, { toolUseId: 't1', name: 'Bash', summary: 'Bash npm test' }),
      ev('permission.wait', 3, { message: 'Claude needs your permission to use Bash' }),
    ]);
    expect(agent(state)).toMatchObject({ status: 'waiting_permission', pendingPermission: 'Claude needs your permission to use Bash', currentTool: { id: 't1' } });
    const done = reduceAll(state, [ev('tool.end', 4, { toolUseId: 't1', isError: false }), ev('turn.end', 5, {})]);
    expect(agent(done)).toMatchObject({ status: 'idle', currentTool: null, pendingPermission: null, toolCalls: 1, toolErrors: 0, lastActivityAt: 5 });
  });

  it('counts a tool reported by both hooks and transcript once, errors included', () => {
    const state = reduceAll(EMPTY_OFFICE, [
      ev('tool.start', 10, { toolUseId: 't1', name: 'Bash', summary: 'Bash x' }),
      ev('tool.start', 11, { toolUseId: 't1', name: 'Bash', summary: 'Bash x' }, 's1', 'transcript'),
      ev('tool.end', 12, { toolUseId: 't1', isError: true }),
      ev('tool.end', 13, { toolUseId: 't1', isError: true }, 's1', 'transcript'),
    ]);
    expect(agent(state)).toMatchObject({ toolCalls: 1, toolErrors: 1, currentTool: null });
  });

  it('does not resurrect a finished tool when its start arrives late', () => {
    const state = reduceAll(EMPTY_OFFICE, [
      ev('tool.start', 10, { toolUseId: 't1', name: 'Read', summary: 'Read' }),
      ev('tool.end', 11, { toolUseId: 't1', isError: false }),
      ev('tool.start', 10, { toolUseId: 't1', name: 'Read', summary: 'Read' }, 's1', 'transcript'),
    ]);
    expect(agent(state).currentTool).toBeNull();
  });

  it('ignores a tool start older than the running tool', () => {
    const state = reduceAll(EMPTY_OFFICE, [
      ev('tool.start', 20, { toolUseId: 'new', name: 'Grep', summary: 'Grep' }),
      ev('tool.start', 15, { toolUseId: 'old', name: 'Read', summary: 'Read' }, 's1', 'transcript'),
    ]);
    expect(agent(state)).toMatchObject({ currentTool: { id: 'new' }, toolCalls: 2 });
  });

  it('keeps the newest status when an older event arrives after it', () => {
    const state = reduceAll(EMPTY_OFFICE, [ev('turn.end', 50, {}), ev('prompt', 40, { text: 'late copy' }, 's1', 'transcript')]);
    expect(agent(state)).toMatchObject({ status: 'idle', lastPrompt: 'late copy', lastActivityAt: 50, startedAt: 40 });
  });

  it('freezes an ended agent until it explicitly starts again', () => {
    const ended = reduceAll(EMPTY_OFFICE, [ev('agent.end', 10, { reason: 'logout' }), ev('prompt', 11, { text: 'late' })]);
    expect(agent(ended)).toMatchObject({ status: 'ended', endedAt: 10 });
    const resumed = reduce(ended, ev('agent.start', 12, { status: 'idle' }));
    expect(agent(resumed)).toMatchObject({ status: 'idle', endedAt: null });
    expect(agent(reduce(resumed, ev('agent.start', 1, { status: 'working' }))).status).toBe('idle');
  });

  it('accumulates token usage and keeps the last known model', () => {
    const state = reduceAll(EMPTY_OFFICE, [
      ev('usage', 1, { model: 'claude-opus-5-5', input: 2, output: 100, cacheRead: 10, cacheWrite: 5 }),
      ev('usage', 2, { model: null, input: 1, output: 50, cacheRead: 0, cacheWrite: 0 }),
    ]);
    expect(agent(state)).toMatchObject({ model: 'claude-opus-5-5', tokens: { input: 3, output: 150, cacheRead: 10, cacheWrite: 5 } });
  });

  it('merges agent.seen without losing known fields', () => {
    const state = reduceAll(EMPTY_OFFICE, [
      ev('title', 1, { title: 'Refonte' }),
      ev('agent.seen', 2, { kind: 'session', sessionId: 's1', parentId: null, cwd: '/repo', title: 'autre', agentType: null }),
      ev('agent.seen', 3, { kind: 'session', sessionId: 's1', parentId: null }),
      ev('message', 4, { text: 'Fini.' }),
    ]);
    expect(agent(state)).toMatchObject({ title: 'Refonte', cwd: '/repo', lastMessage: 'Fini.' });
  });

  it('clips long texts and bounds the tool id memory', () => {
    const long = 'x'.repeat(TEXT_LIMIT + 50);
    const events = Array.from({ length: TOOL_ID_MEMORY + 10 }, (_, i) =>
      ev('tool.start', i + 1, { toolUseId: `t${i}`, name: 'Read', summary: 'Read' }),
    );
    const state = reduceAll(EMPTY_OFFICE, [ev('prompt', 0, { text: long }), ...events]);
    expect(agent(state).lastPrompt).toHaveLength(TEXT_LIMIT);
    expect(agent(state).seenToolIds).toHaveLength(TOOL_ID_MEMORY);
    expect(agent(state).toolCalls).toBe(TOOL_ID_MEMORY + 10);
  });
});
