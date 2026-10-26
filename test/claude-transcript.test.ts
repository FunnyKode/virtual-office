// Fixtures reproduce the shape of real Claude Code 2.1 transcript entries (content anonymised).
import { describe, expect, it } from 'vitest';
import { MAX_CLOCK_SKEW_MS, USAGE_MEMORY, createTranscriptParser, type TranscriptContext } from '../src/sources/claude-transcript.ts';

const SESSION: TranscriptContext = { agentId: 's1', sessionId: 's1', kind: 'session', parentId: null };
const SUB: TranscriptContext = { agentId: 's1/a1', sessionId: 's1', kind: 'subagent', parentId: 's1' };
const T0 = '2026-10-26T10:00:00.000Z';
const at = (iso: string) => Date.parse(iso);

const line = (entry: object) => JSON.stringify(entry);
const assistant = (id: string, content: object[], usage: object, extra: object = {}) =>
  line({ type: 'assistant', timestamp: T0, cwd: '/repo', message: { id, model: 'claude-opus-5-5', role: 'assistant', content, usage, ...extra } });

describe('transcript parser', () => {
  it('reports the working directory once, then a human prompt', () => {
    const parser = createTranscriptParser(SESSION);
    const events = parser.parseLine(line({ type: 'user', timestamp: T0, cwd: '/repo', origin: { kind: 'human' }, message: { role: 'user', content: 'Corrige le test' } }));
    expect(events).toEqual([
      { at: at(T0), agentId: 's1', source: 'transcript', type: 'agent.seen', kind: 'session', sessionId: 's1', parentId: null, cwd: '/repo' },
      { at: at(T0), agentId: 's1', source: 'transcript', type: 'prompt', text: 'Corrige le test' },
    ]);
    expect(parser.parseLine(line({ type: 'user', timestamp: T0, cwd: '/repo', origin: { kind: 'human' }, message: { content: 'encore' } })).map((e) => e.type)).toEqual(['prompt']);
  });

  it('ignores injected context, meta entries and non-human origins', () => {
    const parser = createTranscriptParser(SESSION);
    expect(parser.parseLine(line({ type: 'user', timestamp: T0, message: { content: '<system-reminder>x</system-reminder>' } }))).toEqual([]);
    expect(parser.parseLine(line({ type: 'user', timestamp: T0, isMeta: true, message: { content: 'meta' } }))).toEqual([]);
    expect(parser.parseLine(line({ type: 'user', timestamp: T0, origin: { kind: 'hook' }, message: { content: 'auto' } }))).toEqual([]);
    expect(parser.parseLine(line({ type: 'user', timestamp: T0, origin: { kind: 'human' }, message: { content: [{ type: 'text', text: ' tableau ' }] } }))).toMatchObject([{ type: 'prompt', text: 'tableau' }]);
  });

  it('turns tool_use and tool_result blocks into tool events', () => {
    const parser = createTranscriptParser(SESSION);
    const start = parser.parseLine(assistant('m1', [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm   test' } }], { input_tokens: 1, output_tokens: 2 }, { stop_reason: 'tool_use' }));
    expect(start).toContainEqual(expect.objectContaining({ type: 'tool.start', toolUseId: 'tu1', name: 'Bash', summary: 'Bash npm test' }));
    const end = parser.parseLine(line({ type: 'user', timestamp: T0, message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'échec' }] } }));
    expect(end).toEqual([{ at: at(T0), agentId: 's1', source: 'transcript', type: 'tool.end', toolUseId: 'tu1', isError: true }]);
  });

  it('counts usage once per message even when the message spans several lines', () => {
    const parser = createTranscriptParser(SESSION);
    const usage = { input_tokens: 2, output_tokens: 181, cache_read_input_tokens: 39917, cache_creation_input_tokens: 43043 };
    const first = parser.parseLine(assistant('m1', [{ type: 'text', text: 'Je regarde.' }], usage));
    const repeat = parser.parseLine(assistant('m1', [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/a.ts' } }], usage));
    const grown = parser.parseLine(assistant('m1', [], { ...usage, output_tokens: 200 }, { stop_reason: 'end_turn' }));
    const usageEvents = [...first, ...repeat, ...grown].filter((e) => e.type === 'usage');
    expect(usageEvents).toEqual([
      expect.objectContaining({ model: 'claude-opus-5-5', input: 2, output: 181, cacheRead: 39917, cacheWrite: 43043 }),
      expect.objectContaining({ input: 0, output: 19, cacheRead: 0, cacheWrite: 0 }),
    ]);
    expect(first).toContainEqual(expect.objectContaining({ type: 'message', text: 'Je regarde.' }));
    expect(grown.at(-1)).toMatchObject({ type: 'turn.end' });
  });

  it('reads custom titles (undated) at the last known time, and stop hook summaries', () => {
    const parser = createTranscriptParser(SESSION);
    expect(parser.parseLine(line({ type: 'custom-title', customTitle: 'Avant toute date' }))).toEqual([]);
    parser.parseLine(line({ type: 'system', subtype: 'informational', timestamp: T0 }));
    expect(parser.parseLine(line({ type: 'custom-title', customTitle: ' Refonte ' }))).toEqual([
      { at: at(T0), agentId: 's1', source: 'transcript', type: 'title', title: 'Refonte' },
    ]);
    expect(parser.parseLine(line({ type: 'system', subtype: 'stop_hook_summary', timestamp: T0 }))).toMatchObject([{ type: 'turn.end' }]);
  });

  it('skips sidechain entries in a session file but keeps them in a subagent file', () => {
    const entry = line({ type: 'user', timestamp: T0, isSidechain: true, message: { content: 'Tâche du sous-agent' } });
    expect(createTranscriptParser(SESSION).parseLine(entry)).toEqual([]);
    expect(createTranscriptParser(SUB).parseLine(entry)).toMatchObject([{ type: 'prompt', agentId: 's1/a1' }]);
  });

  it('ends a subagent when it hands its report back, keeping the report as last message', () => {
    const handback = assistant('m9', [{ type: 'tool_use', id: 'tu-h', name: 'SubagentHandback', input: { message: '  Rapport : 2 constats.  ' } }], { input_tokens: 1, output_tokens: 5 });
    const parser = createTranscriptParser(SUB);
    const events = parser.parseLine(handback);
    expect(events.map((e) => e.type)).toEqual(['agent.seen', 'message', 'usage']);
    expect(events[1]).toMatchObject({ text: 'Rapport : 2 constats.' });
    const accepted = parser.parseLine(line({ type: 'user', timestamp: T0, message: { content: [{ type: 'tool_result', tool_use_id: 'tu-h', content: 'ok' }] } }));
    expect(accepted).toMatchObject([{ type: 'agent.end', reason: 'rapport remis' }]);

    // A refused hand-back does not end the subagent: it goes on working.
    const other = createTranscriptParser(SUB);
    other.parseLine(handback);
    const refused = other.parseLine(line({ type: 'user', timestamp: T0, message: { content: [{ type: 'tool_result', tool_use_id: 'tu-h', is_error: true, content: 'refusé' }] } }));
    expect(refused.map((e) => e.type)).toEqual(['turn.end']);
    // In a session file the same tool name is an ordinary tool call.
    expect(createTranscriptParser(SESSION).parseLine(handback).map((e) => e.type)).toContain('tool.start');
  });

  it('ends the turn when the user interrupts, with or without a pending tool', () => {
    const parser = createTranscriptParser(SESSION);
    expect(parser.parseLine(line({ type: 'user', timestamp: T0, origin: { kind: 'human' }, message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }))).toMatchObject([{ type: 'turn.end' }]);
    const duringTool = parser.parseLine(line({ type: 'user', timestamp: T0, message: { content: [
      { type: 'tool_result', tool_use_id: 'tu9', is_error: true, content: 'The user doesn’t want to proceed' },
      { type: 'text', text: '[Request interrupted by user for tool use]' },
    ] } }));
    expect(duringTool.map((event) => event.type)).toEqual(['tool.end', 'turn.end']);
  });

  it('clamps timestamps from the future so one bad line cannot freeze statuses', () => {
    const now = at(T0);
    const parser = createTranscriptParser(SESSION, () => now);
    const [event] = parser.parseLine(line({ type: 'system', subtype: 'stop_hook_summary', timestamp: '2099-01-01T00:00:00.000Z' }));
    expect(event?.at).toBe(now + MAX_CLOCK_SKEW_MS);
  });

  it('bounds its memory of counted messages', () => {
    const parser = createTranscriptParser(SESSION);
    const usage = { input_tokens: 1, output_tokens: 1 };
    for (let i = 0; i <= USAGE_MEMORY; i++) parser.parseLine(assistant(`m${i}`, [], usage));
    // m0 was forgotten: seeing it again counts it again (acceptable, it only happens far behind).
    expect(parser.parseLine(assistant('m0', [], usage)).filter((e) => e.type === 'usage')).toHaveLength(1);
    expect(parser.parseLine(assistant(`m${USAGE_MEMORY}`, [], usage)).filter((e) => e.type === 'usage')).toHaveLength(0);
  });

  it('survives malformed and unexpected lines', () => {
    const parser = createTranscriptParser(SESSION);
    for (const bad of ['{', 'null', '[1,2]', '"texte"', line({ type: 'assistant', timestamp: T0 }), line({ type: 'assistant', timestamp: T0, message: { content: 'x' } }), line({ type: 'inconnu', timestamp: 'pas une date' })]) {
      expect(parser.parseLine(bad)).toEqual([]);
    }
  });
});
