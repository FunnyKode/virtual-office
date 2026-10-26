// Client side of the SSE stream: keeps the agent table up to date and reports the connection state.

/** @typedef {import('../../../src/domain/types.ts').AgentView} AgentView */
/** @typedef {{ generatedAt: number, silenceMs: number, agents: AgentView[] }} Snapshot */
/** @typedef {'connecting' | 'live' | 'offline'} Connection */

/** @param {Snapshot} snapshot */
export function fromSnapshot(snapshot) {
  return new Map(snapshot.agents.map((agent) => [agent.id, agent]));
}

/**
 * New table with the changed agents replaced; the input is left untouched.
 * @param {ReadonlyMap<string, AgentView>} agents
 * @param {readonly AgentView[]} changed
 */
export function withChanges(agents, changed) {
  const next = new Map(agents);
  for (const agent of changed) next.set(agent.id, agent);
  return next;
}

/**
 * Busy agents silent for too long are stale; recomputed client side since time passes between events.
 * @param {AgentView} agent
 * @param {number} now
 * @param {number} silenceMs
 * @returns {AgentView}
 */
export function refreshStale(agent, now, silenceMs) {
  const busy = agent.status === 'working' || agent.status === 'waiting_permission';
  const stale = busy && now - agent.lastActivityAt > silenceMs;
  return stale === agent.stale ? agent : { ...agent, stale };
}

/** Delays before reopening a stream the browser gave up on (the last one repeats). */
export const RETRY_DELAYS_MS = [1000, 2000, 5000, 10_000];
const CLOSED = 2;

/**
 * Follows the stream. EventSource retries on its own after a network error, but gives up for good
 * on an HTTP error (a 503 when the server is full, for instance): then we reopen it ourselves.
 * @param {{
 *   createSource: (url: string) => EventSource,
 *   onAgents: (agents: ReadonlyMap<string, AgentView>, silenceMs: number) => void,
 *   onConnection: (state: Connection) => void,
 *   url?: string,
 *   schedule?: (run: () => void, ms: number) => unknown,
 *   cancel?: (handle: any) => void,
 * }} options
 * @returns {{ close(): void }}
 */
export function connectStream({ createSource, onAgents, onConnection, url = '/api/flux', schedule = setTimeout, cancel = clearTimeout }) {
  /** @type {ReadonlyMap<string, AgentView>} */
  let agents = new Map();
  let silenceMs = 15 * 60_000;
  let failures = 0;
  let closed = false;
  /** @type {unknown} */
  let retry = null;
  /** @type {EventSource} */
  let source;

  function open() {
    source = createSource(url);
    onConnection('connecting');
    const current = source;
    current.addEventListener('open', () => {
      failures = 0;
      onConnection('live');
    });
    current.addEventListener('error', () => {
      if (current.readyState !== CLOSED) return onConnection('connecting');
      onConnection('offline');
      current.close();
      const delay = RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)] ?? 10_000;
      failures += 1;
      retry = schedule(() => {
        retry = null;
        if (!closed) open();
      }, delay);
    });
    current.addEventListener('snapshot', (event) => {
      const snapshot = parse(event);
      if (!snapshot || !Array.isArray(snapshot.agents)) return;
      silenceMs = snapshot.silenceMs ?? silenceMs;
      agents = fromSnapshot(snapshot);
      onConnection('live');
      onAgents(agents, silenceMs);
    });
    current.addEventListener('agents', (event) => {
      const changed = parse(event);
      if (!Array.isArray(changed)) return;
      agents = withChanges(agents, changed);
      onAgents(agents, silenceMs);
    });
  }

  open();
  return {
    close() {
      closed = true;
      if (retry !== null) cancel(retry);
      source.close();
    },
  };
}

/** @param {Event} event */
function parse(event) {
  try {
    return JSON.parse(/** @type {MessageEvent} */ (event).data);
  } catch {
    return null;
  }
}
