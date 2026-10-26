// Figures for the office HUD.

/** @typedef {import('../../../src/domain/types.ts').AgentView} AgentView */

/**
 * @param {Iterable<AgentView>} agents
 * @param {number} now
 * @param {number} dayMs agents active within this period count towards the totals
 */
export function summarize(agents, now, dayMs = 24 * 3_600_000) {
  let working = 0;
  let idle = 0;
  let stale = 0;
  let outputTokens = 0;
  let toolCalls = 0;
  /** @type {AgentView[]} */
  const waiting = [];
  for (const agent of agents) {
    if (now - agent.lastActivityAt > dayMs) continue;
    outputTokens += agent.tokens.output;
    toolCalls += agent.toolCalls;
    if (agent.status === 'waiting_permission') waiting.push(agent);
    else if (agent.stale) stale += 1;
    else if (agent.status === 'working') working += 1;
    else if (agent.status === 'idle') idle += 1;
  }
  waiting.sort((a, b) => a.lastActivityAt - b.lastActivityAt);
  return { working, idle, stale, waiting, outputTokens, toolCalls };
}
