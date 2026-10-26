import type { AgentState, AgentView, OfficeState } from './types.ts';

export interface ViewOptions {
  readonly now: number;
  readonly silenceMs: number;
  readonly windowMs: number;
}

export function toView(agent: AgentState, now: number, silenceMs: number): AgentView {
  const { seenToolIds: _seen, finishedToolIds: _finished, ...visible } = agent;
  const busy = agent.status === 'working' || agent.status === 'waiting_permission';
  return { ...visible, stale: busy && now - agent.lastActivityAt > silenceMs };
}

export const isInWindow = (agent: AgentState, now: number, windowMs: number): boolean =>
  now - agent.lastActivityAt <= windowMs;

/** Agents active within the window, most recent activity first. */
export function listViews(state: OfficeState, { now, silenceMs, windowMs }: ViewOptions): AgentView[] {
  return Object.values(state.agents)
    .filter((agent) => isInWindow(agent, now, windowMs))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .map((agent) => toView(agent, now, silenceMs));
}
