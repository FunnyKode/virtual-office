// Where each agent sits. Pure and stable: an agent keeps its seat from one update to the next,
// so robots do not shuffle around when the stream sends news.
//
// Floor plan (world units, y up, camera looks from +x +z):
//   six pods (3 × 2): a session desk with up to four subagent seats around it,
//   a bench along the front for overflow, the door in the middle of the front wall.

/** @typedef {import('../../../src/domain/types.ts').AgentView} AgentView */
/** @typedef {{ kind: 'pod', pod: number, slot: 'desk' | number, x: number, z: number, face: number }} PodSeat */
/** @typedef {{ kind: 'bench', index: number, x: number, z: number, face: number }} BenchSeat */
/** @typedef {PodSeat | BenchSeat} Seat */

export const POD_COLUMNS = [-8, 0, 8];
export const POD_ROWS = [-5, 2];
export const SATELLITES = 4;
export const BENCH_SIZE = 14;
export const BENCH_Z = 7.6;
/** Front corridor, between the front row of pods and the bench. */
export const CORRIDOR_Z = 6.2;
/** Side aisles between pod columns (pods are 7 units wide around x = -8, 0, 8). */
export const AISLES_X = [-12, -4, 4, 12];
export const DOOR = Object.freeze({ x: 0, z: 10.5 });
export const IDLE_VISIBLE_MS = 2 * 3_600_000;

/** Pod centres, row by row. */
export const PODS = Object.freeze(POD_ROWS.flatMap((z) => POD_COLUMNS.map((x) => Object.freeze({ x, z }))));

/** @type {ReadonlyArray<readonly [number, number]>} */
const SATELLITE_OFFSETS = [
  [-2.5, -0.7],
  [2.5, -0.7],
  [-2.5, 1.7],
  [2.5, 1.7],
];

/** @param {number} x @param {number} z @param {number} tx @param {number} tz */
const faceTowards = (x, z, tx, tz) => Math.atan2(tx - x, tz - z);

/**
 * @param {number} pod
 * @param {'desk' | number} slot
 * @returns {PodSeat}
 */
export function podSeat(pod, slot) {
  const centre = PODS[pod];
  if (!centre) throw new RangeError(`pod ${pod} inexistant`);
  if (slot === 'desk') return { kind: 'pod', pod, slot, x: centre.x, z: centre.z + 1.05, face: Math.PI };
  const offset = SATELLITE_OFFSETS[slot];
  if (!offset) throw new RangeError(`place ${slot} inexistante`);
  const x = centre.x + offset[0];
  const z = centre.z + offset[1];
  return { kind: 'pod', pod, slot, x, z, face: faceTowards(x, z, centre.x, centre.z + 0.4) };
}

/**
 * @param {number} index
 * @returns {BenchSeat}
 */
export function benchSeat(index) {
  if (index < 0 || index >= BENCH_SIZE) throw new RangeError(`place de banc ${index} inexistante`);
  const x = -9.1 + index * 1.4;
  return { kind: 'bench', index, x, z: BENCH_Z, face: Math.PI };
}

/** @type {Record<AgentView['status'], number>} */
const PRIORITY = { waiting_permission: 0, working: 1, idle: 2, ended: 3 };

/**
 * Busy first, then most recent activity.
 * @param {AgentView} a
 * @param {AgentView} b
 */
function rank(a, b) {
  return (PRIORITY[a.status] - PRIORITY[b.status]) || (b.lastActivityAt - a.lastActivityAt) || a.id.localeCompare(b.id);
}

/**
 * Agents worth a robot: not ended, and idle ones only if recently active.
 * @param {readonly AgentView[]} agents
 * @param {number} now
 */
export function visibleAgents(agents, now, idleVisibleMs = IDLE_VISIBLE_MS) {
  return agents.filter((agent) => agent.status !== 'ended' && (agent.status !== 'idle' || now - agent.lastActivityAt <= idleVisibleMs));
}

/** @type {(length: number) => number[]} */
const indexes = (length) => Array.from({ length }, (_, i) => i);

/**
 * Sessions keep their pod; newcomers take a free pod, or the pod of the least recent idle
 * session when they are busy. Returns pod → session id, and the sessions sent to the bench.
 * @param {readonly AgentView[]} sessions ranked
 * @param {ReadonlyMap<string, Seat>} previous
 */
function assignPods(sessions, previous) {
  /** @type {Map<number, AgentView>} */
  const owners = new Map();
  /** @type {AgentView[]} */
  const benched = [];
  for (const session of sessions) {
    const before = previous.get(session.id);
    if (before?.kind === 'pod' && before.slot === 'desk') owners.set(before.pod, session);
  }
  const seated = new Set([...owners.values()].map((session) => session.id));
  for (const session of sessions) {
    if (seated.has(session.id)) continue;
    let pod = indexes(PODS.length).find((index) => !owners.has(index));
    if (pod === undefined && session.status !== 'idle') {
      const evicted = [...owners.entries()].filter(([, holder]) => holder.status === 'idle').sort(([, a], [, b]) => rank(b, a))[0];
      if (evicted) {
        benched.push(evicted[1]);
        pod = evicted[0];
      }
    }
    if (pod === undefined) benched.push(session);
    else owners.set(pod, session);
  }
  return { owners, benched };
}

/**
 * Subagents sit around their parent's pod while a slot is free; the others go to the bench.
 * @param {readonly AgentView[]} subagents ranked
 * @param {ReadonlyMap<string, number>} podOfSession
 * @param {ReadonlyMap<string, Seat>} previous
 */
function assignSatellites(subagents, podOfSession, previous) {
  /** @type {Map<string, PodSeat>} */
  const seats = new Map();
  /** @type {Map<number, Set<number>>} */
  const used = new Map();
  /** @type {AgentView[]} */
  const benched = [];
  /** @param {AgentView} agent @param {number} pod @param {number} slot */
  const place = (agent, pod, slot) => {
    used.set(pod, (used.get(pod) ?? new Set()).add(slot));
    seats.set(agent.id, podSeat(pod, slot));
  };
  /** @type {Array<{ agent: AgentView, pod: number | undefined }>} */
  const later = [];
  for (const agent of subagents) {
    const pod = agent.parentId === null ? undefined : podOfSession.get(agent.parentId);
    const before = previous.get(agent.id);
    if (pod !== undefined && before?.kind === 'pod' && before.pod === pod && typeof before.slot === 'number') place(agent, pod, before.slot);
    else later.push({ agent, pod });
  }
  for (const { agent, pod } of later) {
    const slot = pod === undefined ? undefined : indexes(SATELLITES).find((i) => !used.get(pod)?.has(i));
    if (pod !== undefined && slot !== undefined) place(agent, pod, slot);
    else benched.push(agent);
  }
  return { seats, benched };
}

/**
 * Bench places are kept from the previous update, then filled from the left.
 * @param {readonly AgentView[]} queue
 * @param {ReadonlyMap<string, Seat>} previous
 */
function assignBench(queue, previous) {
  /** @type {Map<string, BenchSeat>} */
  const seats = new Map();
  /** @type {Set<number>} */
  const taken = new Set();
  /** @type {string[]} */
  const overflow = [];
  const later = queue.filter((agent) => {
    const before = previous.get(agent.id);
    if (before?.kind !== 'bench' || taken.has(before.index)) return true;
    taken.add(before.index);
    seats.set(agent.id, benchSeat(before.index));
    return false;
  });
  for (const agent of later) {
    const index = indexes(BENCH_SIZE).find((i) => !taken.has(i));
    if (index === undefined) {
      overflow.push(agent.id);
      continue;
    }
    taken.add(index);
    seats.set(agent.id, benchSeat(index));
  }
  return { seats, overflow };
}

/**
 * @param {ReadonlyMap<string, Seat>} previous seats from the last update
 * @param {readonly AgentView[]} agents all known agents
 * @param {number} now
 * @returns {{ seats: Map<string, Seat>, overflow: string[] }}
 */
export function assignSeats(previous, agents, now, idleVisibleMs = IDLE_VISIBLE_MS) {
  const visible = visibleAgents(agents, now, idleVisibleMs);
  const sessions = visible.filter((agent) => agent.kind === 'session').sort(rank);
  const subagents = visible.filter((agent) => agent.kind === 'subagent').sort(rank);
  const pods = assignPods(sessions, previous);
  const podOfSession = new Map([...pods.owners.entries()].map(([pod, session]) => [session.id, pod]));
  const satellites = assignSatellites(subagents, podOfSession, previous);
  // When the bench is full too, the busiest agents keep a place.
  const bench = assignBench([...pods.benched, ...satellites.benched].sort(rank), previous);
  /** @type {Map<string, Seat>} */
  const seats = new Map([...podOfSession.entries()].map(([id, pod]) => [id, podSeat(pod, 'desk')]));
  for (const [id, seat] of [...satellites.seats, ...bench.seats]) seats.set(id, seat);
  return { seats, overflow: bench.overflow };
}

/**
 * Closest aisle; on a tie, the one nearer the middle of the room (and the door).
 * @param {number} x
 */
const nearestAisle = (x) =>
  [...AISLES_X].sort((a, b) => Math.abs(a - x) - Math.abs(b - x) || Math.abs(a) - Math.abs(b))[0] ?? 0;

/**
 * Walking path between two points that never cuts through a pod: from inside the pods,
 * robots first reach the nearest side aisle, then use the front corridor.
 * @param {{ x: number, z: number }} from
 * @param {{ x: number, z: number }} to
 * @returns {Array<{ x: number, z: number }>}
 */
export function pathTo(from, to) {
  if (Math.abs(from.x - to.x) < 0.01 && Math.abs(from.z - to.z) < 0.01) return [];
  const amongPods = (/** @type {number} */ z) => z < CORRIDOR_Z - 0.1;
  /** @type {Array<{ x: number, z: number }>} */
  const points = [];
  if (amongPods(from.z)) {
    const aisle = nearestAisle(from.x);
    points.push({ x: aisle, z: from.z }, { x: aisle, z: CORRIDOR_Z });
  } else points.push({ x: from.x, z: CORRIDOR_Z });
  if (amongPods(to.z)) {
    const aisle = nearestAisle(to.x);
    points.push({ x: aisle, z: CORRIDOR_Z }, { x: aisle, z: to.z });
  } else points.push({ x: to.x, z: CORRIDOR_Z });
  points.push({ x: to.x, z: to.z });
  return points;
}

/** @param {Seat | undefined} a @param {Seat | undefined} b */
export const samePlace = (a, b) => a?.kind === b?.kind && a?.x === b?.x && a?.z === b?.z;
