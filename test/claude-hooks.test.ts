import { describe, expect, it } from 'vitest';
import { parseHookPayload } from '../src/sources/claude-hooks.ts';
import { summarizeTool } from '../src/sources/tool-summary.ts';

const NOW = 1_000;
const base = { session_id: 'sess-1', cwd: '/repo', transcript_path: '/x.jsonl' };

const typesOf = (body: object) => {
  const result = parseHookPayload({ ...base, ...body }, NOW);
  if (!result.ok) throw new Error(result.error);
  return result.events.map((event) => event.type);
};

describe('hook payloads', () => {
  it('prefixes every relevant event with agent.seen carrying the working directory', () => {
    const result = parseHookPayload({ ...base, hook_event_name: 'UserPromptSubmit', prompt: 'Lance les tests' }, NOW);
    expect(result).toEqual({
      ok: true,
      events: [
        { at: NOW, agentId: 'sess-1', source: 'hook', type: 'agent.seen', kind: 'session', sessionId: 'sess-1', parentId: null, cwd: '/repo', agentType: null },
        { at: NOW, agentId: 'sess-1', source: 'hook', type: 'prompt', text: 'Lance les tests' },
      ],
    });
  });

  it.each([
    ['SessionStart', {}, ['agent.seen', 'agent.start']],
    ['SessionStart', { source: 'compact' }, []],
    ['PreToolUse', { tool_name: 'Bash', tool_use_id: 'tu1', tool_input: { command: 'ls' } }, ['agent.seen', 'tool.start']],
    ['PostToolUse', { tool_name: 'Bash', tool_use_id: 'tu1' }, ['agent.seen', 'tool.end']],
    ['PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'tu1' }, ['agent.seen', 'tool.end']],
    ['PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm x' } }, ['agent.seen', 'permission.wait']],
    ['Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }, ['agent.seen', 'permission.wait']],
    ['Notification', { message: 'Claude needs your permission' }, ['agent.seen', 'permission.wait']],
    ['Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }, ['agent.seen', 'turn.end']],
    ['Notification', { notification_type: 'auth_success' }, []],
    ['Stop', {}, ['agent.seen', 'turn.end']],
    ['SessionEnd', { reason: 'logout' }, ['agent.seen', 'agent.end']],
    ['PreCompact', {}, []],
    ['PreToolUse', { tool_name: 'Bash' }, []],
  ])('%s %j → %j', (name, body, expected) => {
    expect(typesOf({ hook_event_name: name, ...body })).toEqual(expected);
  });

  it('attributes events carrying agent_id to the subagent, child of its session', () => {
    const result = parseHookPayload({ ...base, hook_event_name: 'SubagentStart', agent_id: 'ag-7', agent_type: 'Explore' }, NOW);
    expect(result.ok && result.events).toEqual([
      expect.objectContaining({ type: 'agent.seen', agentId: 'sess-1/ag-7', kind: 'subagent', parentId: 'sess-1', agentType: 'Explore' }),
      expect.objectContaining({ type: 'agent.start', status: 'working', agentId: 'sess-1/ag-7' }),
    ]);
    const stop = parseHookPayload({ ...base, hook_event_name: 'SubagentStop', agent_id: 'ag-7' }, NOW);
    expect(stop.ok && stop.events.at(-1)).toMatchObject({ type: 'agent.end', agentId: 'sess-1/ag-7', reason: null });
  });

  it('describes the tool in the permission message and the tool start', () => {
    const result = parseHookPayload({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'git push' } }, NOW);
    expect(result.ok && result.events[1]).toMatchObject({ message: 'Autorisation demandée : Bash git push' });
  });

  it.each([
    [null, 'objet JSON attendu'],
    [[], 'objet JSON attendu'],
    [{ session_id: 's' }, 'hook_event_name manquant'],
    [{ hook_event_name: 'Stop' }, 'session_id manquant ou invalide'],
    [{ hook_event_name: 'Stop', session_id: '../../etc' }, 'session_id manquant ou invalide'],
    [{ hook_event_name: 'Stop', session_id: 's', agent_id: 'a/b' }, 'agent_id invalide'],
  ])('rejects %j', (body, error) => {
    expect(parseHookPayload(body, NOW)).toEqual({ ok: false, error });
  });
});

describe('tool summary', () => {
  it('uses the most telling argument and stays short', () => {
    expect(summarizeTool('Read', { file_path: '/a.ts', description: '' })).toBe('Read /a.ts');
    expect(summarizeTool('Task', { description: 'Explorer\n le code' })).toBe('Task Explorer le code');
    expect(summarizeTool('Mystery', null)).toBe('Mystery');
    expect(summarizeTool('Bash', { command: 'x'.repeat(500) })).toHaveLength(200);
  });
});
