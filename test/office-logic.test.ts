import { describe, expect, it, vi } from 'vitest';
import type { AgentView } from '../src/domain/types.ts';
import { activityOf, displayName } from '../public/office/logic/activity.js';
import { GAP, liftBubbles } from '../public/office/logic/bubbles.js';
import { folderName, formatSince, formatTokens } from '../public/office/logic/format.js';
import { BENCH_SIZE, BENCH_Z, CORRIDOR_Z, DOOR, PODS, SATELLITES, assignSeats, benchSeat, pathTo, podSeat, samePlace, visibleAgents } from '../public/office/logic/layout.js';
import { RETRY_DELAYS_MS, connectStream, fromSnapshot, refreshStale, withChanges } from '../public/office/logic/stream.js';
import { summarize } from '../public/office/logic/summary.js';

const NOW = 10_000_000;

function agent(id: string, overrides: Partial<AgentView> = {}): AgentView {
  const slash = id.indexOf('/');
  const sessionId = slash < 0 ? id : id.slice(0, slash);
  return {
    id,
    kind: slash < 0 ? 'session' : 'subagent',
    sessionId,
    parentId: slash < 0 ? null : sessionId,
    title: null,
    agentType: null,
    cwd: null,
    model: null,
    status: 'working',
    statusChangedAt: NOW,
    startedAt: NOW - 1000,
    lastActivityAt: NOW,
    endedAt: null,
    currentTool: null,
    runningTools: [],
    pendingPermission: null,
    lastPrompt: null,
    lastMessage: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    toolCalls: 0,
    toolErrors: 0,
    stale: false,
    ...overrides,
  };
}

const tool = (summary: string) => ({ id: 't', name: summary.split(' ')[0]!, summary, startedAt: NOW });

describe('activity', () => {
  it.each([
    [{ status: 'ended' }, 'terminé', 'ended'],
    [{ status: 'waiting_permission' }, 'attend ton autorisation', 'waiting'],
    [{ status: 'working', stale: true }, 'silencieux', 'stale'],
    [{ status: 'idle' }, 'attend ta demande', 'idle'],
    [{ currentTool: tool('Read /a.ts') }, 'lit le code', 'working'],
    [{ currentTool: tool('Edit /a.ts') }, 'modifie', 'working'],
    [{ currentTool: tool('Bash git push origin x') }, 'publie', 'working'],
    [{ currentTool: tool('Bash git status') }, 'git', 'working'],
    [{ currentTool: tool('Bash npx vitest run') }, 'lance les tests', 'working'],
    [{ currentTool: tool('Bash npm install three') }, 'installe', 'working'],
    [{ currentTool: tool('Bash ls -la') }, 'terminal', 'working'],
    [{ currentTool: tool('Agent Review lot 1') }, 'délègue', 'working'],
    [{ currentTool: tool('mcp__Claude_Browser__navigate x') }, 'outil externe', 'working'],
    [{}, 'réfléchit', 'working'],
  ] as const)('%j → %s', (overrides, label, tone) => {
    expect(activityOf(agent('s', overrides as Partial<AgentView>))).toMatchObject({ label, tone });
  });

  it('names agents by title, type, or a short id', () => {
    expect(displayName(agent('s', { title: '  Refonte  ' }))).toBe('Refonte');
    expect(displayName(agent('s/a', { agentType: 'Explore' }))).toBe('Explore');
    expect(displayName(agent('s/a'))).toBe('sous-agent');
    expect(displayName(agent('abcdef123456'))).toBe('session abcdef12');
    expect(displayName(agent('s', { title: 'x'.repeat(60) }), 10)).toBe(`${'x'.repeat(9)}…`);
    expect(displayName(agent('s', { title: 'abc‮gpj.exe' }))).toBe('abcgpj.exe');
    expect(displayName(agent('s', { title: '🤖'.repeat(5) }), 3)).toBe('🤖🤖…');
  });
});

describe('format', () => {
  it('formats token counts', () => {
    expect([formatTokens(-1), formatTokens(Number.NaN), formatTokens(999), formatTokens(1234), formatTokens(56_789), formatTokens(3_400_000), formatTokens(2e9)])
      .toEqual(['–', '–', '999', '1,2 k', '57 k', '3,4 M', '2 G']);
  });

  it('formats elapsed time', () => {
    expect([formatSince(NOW, NOW), formatSince(NOW - 12 * 60_000, NOW), formatSince(NOW - 125 * 60_000, NOW), formatSince(NOW - 72 * 3_600_000, NOW)])
      .toEqual(['à l’instant', '12 min', '2 h 05', '3 j']);
  });

  it('keeps the last folder of a path', () => {
    expect([folderName('/home/moi/dev/projet'), folderName('C:\\dev\\app\\'), folderName(null), folderName('/')]).toEqual(['projet', 'app', null, '/']);
  });
});

describe('layout', () => {
  it('computes seats and rejects unknown ones', () => {
    expect(podSeat(0, 'desk')).toMatchObject({ kind: 'pod', pod: 0, slot: 'desk', x: PODS[0]!.x });
    expect(podSeat(5, 3).slot).toBe(3);
    expect(benchSeat(0)).toMatchObject({ kind: 'bench', z: BENCH_Z });
    expect(() => podSeat(99, 'desk')).toThrow(RangeError);
    expect(() => podSeat(0, 7)).toThrow(RangeError);
    expect(() => benchSeat(BENCH_SIZE)).toThrow(RangeError);
  });

  it('shows busy agents and recently idle ones, never ended ones', () => {
    const visible = visibleAgents([
      agent('busy'),
      agent('fresh-idle', { status: 'idle', lastActivityAt: NOW - 60_000 }),
      agent('old-idle', { status: 'idle', lastActivityAt: NOW - 3 * 3_600_000 }),
      agent('done', { status: 'ended' }),
    ], NOW);
    expect(visible.map((a) => a.id)).toEqual(['busy', 'fresh-idle']);
  });

  it('gives each session a pod and seats its subagents around it', () => {
    const { seats, overflow } = assignSeats(new Map(), [agent('s1'), agent('s1/a'), agent('s1/b'), agent('s2', { status: 'idle' })], NOW);
    expect(seats.get('s1')).toMatchObject({ kind: 'pod', pod: 0, slot: 'desk' });
    expect(seats.get('s2')).toMatchObject({ kind: 'pod', pod: 1, slot: 'desk' });
    expect([seats.get('s1/a'), seats.get('s1/b')].map((s) => s?.kind === 'pod' && s.slot)).toEqual([0, 1]);
    expect(overflow).toEqual([]);
  });

  it('keeps everyone in place across updates', () => {
    const first = assignSeats(new Map(), [agent('s1', { lastActivityAt: NOW - 10 }), agent('s2'), agent('s2/x')], NOW).seats;
    const second = assignSeats(first, [agent('s1', { lastActivityAt: NOW + 50 }), agent('s3', { status: 'waiting_permission' }), agent('s2'), agent('s2/y'), agent('s2/x')], NOW).seats;
    for (const id of ['s1', 's2', 's2/x']) expect(second.get(id)).toEqual(first.get(id));
    expect(second.get('s3')).toMatchObject({ kind: 'pod' });
    expect(second.get('s2/y')).toMatchObject({ kind: 'pod', slot: 1 });
  });

  it('lets a busy newcomer take the pod of the least recent idle session', () => {
    const sessions = PODS.map((_, i) => agent(`s${i}`, { status: 'idle', lastActivityAt: NOW - i * 1000 }));
    const full = assignSeats(new Map(), sessions, NOW).seats;
    const { seats } = assignSeats(full, [...sessions, agent('urgent', { status: 'waiting_permission' })], NOW);
    expect(seats.get('urgent')).toEqual(podSeat(PODS.length - 1, 'desk'));
    expect(seats.get(`s${PODS.length - 1}`)).toMatchObject({ kind: 'bench', index: 0 });
    const idleNewcomer = assignSeats(full, [...sessions, agent('late', { status: 'idle' })], NOW).seats;
    expect(idleNewcomer.get('late')).toMatchObject({ kind: 'bench' });
  });

  it('sends extra subagents, orphans and overflow to the bench, then out of view', () => {
    const subs = Array.from({ length: SATELLITES + 1 }, (_, i) => agent(`s1/${i}`));
    const orphan = agent('gone/x');
    const crowd = Array.from({ length: BENCH_SIZE + 2 }, (_, i) => agent(`p/${i}`, { parentId: 'absent', lastActivityAt: NOW - 1000 }));
    const { seats, overflow } = assignSeats(new Map(), [agent('s1'), ...subs, orphan, ...crowd], NOW);
    expect(seats.get(`s1/${SATELLITES}`)).toMatchObject({ kind: 'bench' });
    expect(seats.get('gone/x')).toMatchObject({ kind: 'bench' });
    expect(overflow).toHaveLength(4);
    const kept = assignSeats(seats, [agent('s1'), ...subs, orphan, ...crowd], NOW).seats;
    expect(kept.get('gone/x')).toEqual(seats.get('gone/x'));
  });

  it('walks around pods through aisles and the corridor, and not at all when already seated', () => {
    const seat = podSeat(0, 'desk'); // back row, left column: x = -8
    expect(pathTo({ x: seat.x, z: seat.z }, seat)).toEqual([]);
    expect(pathTo(DOOR, seat)).toEqual([
      { x: DOOR.x, z: CORRIDOR_Z },
      { x: -4, z: CORRIDOR_Z },
      { x: -4, z: seat.z },
      { x: seat.x, z: seat.z },
    ]);
    const bench = benchSeat(3);
    expect(pathTo(seat, bench)).toEqual([{ x: -4, z: seat.z }, { x: -4, z: CORRIDOR_Z }, { x: bench.x, z: CORRIDOR_Z }, { x: bench.x, z: bench.z }]);
    // No waypoint inside a pod rug (7 × 5.4 around each centre), except the start and the seat itself.
    for (const point of pathTo(podSeat(3, 2), podSeat(2, 1)).slice(0, -1).slice(1)) {
      expect(PODS.some((c) => Math.abs(point.x - c.x) < 3.5 && point.z > c.z - 2.2 && point.z < c.z + 3.2)).toBe(false);
    }
    expect(samePlace(seat, podSeat(0, 'desk'))).toBe(true);
    expect(samePlace(seat, benchSeat(0))).toBe(false);
  });
});

describe('stream', () => {
  it('builds and updates the agent table without mutating it', () => {
    const table = fromSnapshot({ generatedAt: NOW, silenceMs: 1000, agents: [agent('a'), agent('b')] });
    const next = withChanges(table, [agent('b', { status: 'idle' }), agent('c')]);
    expect(table.get('b')?.status).toBe('working');
    expect([...next.keys()]).toEqual(['a', 'b', 'c']);
    expect(next.get('b')?.status).toBe('idle');
  });

  it('recomputes staleness as time passes', () => {
    const busy = agent('a', { lastActivityAt: NOW - 5000 });
    expect(refreshStale(busy, NOW, 10_000)).toBe(busy);
    expect(refreshStale(busy, NOW, 1000).stale).toBe(true);
    expect(refreshStale(agent('i', { status: 'idle', lastActivityAt: 0 }), NOW, 1).stale).toBe(false);
  });

  it('follows the SSE stream and reports the connection', () => {
    const listeners = new Map<string, (event: { data?: string }) => void>();
    const source = { readyState: 0, close: vi.fn(), addEventListener: (type: string, fn: (event: { data?: string }) => void) => listeners.set(type, fn) };
    const onAgents = vi.fn();
    const onConnection = vi.fn();
    const stream = connectStream({ createSource: () => source as unknown as EventSource, onAgents, onConnection });
    const emit = (type: string, data?: unknown) => listeners.get(type)!({ data: typeof data === 'string' ? data : JSON.stringify(data) });

    emit('open');
    emit('snapshot', { generatedAt: NOW, silenceMs: 42, agents: [agent('a')] });
    emit('agents', [agent('b')]);
    emit('agents', 'pas du json');
    emit('snapshot', { agents: 'faux' });
    source.readyState = 2;
    emit('error');
    stream.close();

    expect(onConnection.mock.calls.map(([state]) => state)).toEqual(['connecting', 'live', 'live', 'offline']);
    expect(onAgents).toHaveBeenCalledTimes(2);
    expect([...onAgents.mock.calls[1]![0].keys()]).toEqual(['a', 'b']);
    expect(onAgents.mock.calls[1]![1]).toBe(42);
    expect(source.close).toHaveBeenCalled();
  });

  it('reopens a stream the browser gave up on, waiting longer each time, until closed', () => {
    type Fake = { readyState: number; close: ReturnType<typeof vi.fn>; listeners: Map<string, () => void>; addEventListener(type: string, fn: () => void): void };
    const sources: Fake[] = [];
    const createSource = () => {
      const fake: Fake = { readyState: 0, close: vi.fn(), listeners: new Map(), addEventListener(type, fn) { this.listeners.set(type, fn); } };
      sources.push(fake);
      return fake as unknown as EventSource;
    };
    const timers: Array<{ run: () => void; ms: number }> = [];
    const cancel = vi.fn();
    const onConnection = vi.fn();
    const stream = connectStream({ createSource, onAgents: vi.fn(), onConnection, schedule: (run, ms) => timers.push({ run, ms }), cancel });
    const fail = (fake: Fake) => { fake.readyState = 2; fake.listeners.get('error')!(); };

    sources[0]!.listeners.get('error')!(); // transient: the browser retries itself
    expect(timers).toHaveLength(0);
    fail(sources[0]!);
    fail(sources[0]!);
    timers[0]!.run();
    fail(sources[1]!);
    timers[2]!.run();
    sources[2]!.listeners.get('open')!();
    fail(sources[2]!);
    expect(timers.map((t) => t.ms)).toEqual([RETRY_DELAYS_MS[0], RETRY_DELAYS_MS[1], RETRY_DELAYS_MS[2], RETRY_DELAYS_MS[0]]);
    expect(sources).toHaveLength(3);
    stream.close();
    expect(cancel).toHaveBeenCalled();
    timers.at(-1)!.run();
    expect(sources).toHaveLength(3);
    expect(sources[0]!.close).toHaveBeenCalled();
  });
});

describe('bubbles', () => {
  it('leaves separate bubbles alone and lifts the farther of two overlapping ones', () => {
    const lifts = liftBubbles([
      { id: 'near', x: 100, y: 300, w: 80, h: 30 },
      { id: 'far', x: 110, y: 290, w: 80, h: 30 },
      { id: 'alone', x: 500, y: 100, w: 80, h: 30 },
    ]);
    expect(lifts.get('near')).toBe(0);
    expect(lifts.get('alone')).toBe(0);
    // far's bottom must clear near's top (300 - 30) by the gap
    expect(290 - lifts.get('far')!).toBeLessThanOrEqual(300 - 30 - GAP);
  });

  it('stacks a crowd without any overlap', () => {
    const crowd = Array.from({ length: 8 }, (_, i) => ({ id: `r${i}`, x: 200 + i * 5, y: 400 - i, w: 120, h: 34 }));
    const lifts = liftBubbles(crowd);
    const boxes = crowd.map((b) => ({ top: b.y - lifts.get(b.id)! - b.h, bottom: b.y - lifts.get(b.id)! }));
    for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) expect(a.bottom <= b.top || b.bottom <= a.top).toBe(true);
  });
});

describe('summary', () => {
  it('counts agents by state and adds up the day’s tokens', () => {
    const result = summarize([
      agent('w', { tokens: { input: 1, output: 100, cacheRead: 0, cacheWrite: 0 }, toolCalls: 3 }),
      agent('p1', { status: 'waiting_permission', lastActivityAt: NOW - 10 }),
      agent('p2', { status: 'waiting_permission', lastActivityAt: NOW - 500 }),
      agent('z', { stale: true }),
      agent('i', { status: 'idle', tokens: { input: 0, output: 50, cacheRead: 0, cacheWrite: 0 } }),
      agent('e', { status: 'ended' }),
      agent('old', { lastActivityAt: NOW - 48 * 3_600_000, tokens: { input: 0, output: 999, cacheRead: 0, cacheWrite: 0 } }),
    ], NOW);
    expect(result).toMatchObject({ working: 1, idle: 1, stale: 1, outputTokens: 150, toolCalls: 3 });
    expect(result.waiting.map((a) => a.id)).toEqual(['p2', 'p1']);
  });
});
