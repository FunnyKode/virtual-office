// Pure state transitions. Hooks and transcripts may report the same fact twice and out of order:
// status changes are last-writer-wins on event time, tool calls are deduplicated by tool id.
import { parseAgentKey } from './ids.ts';
import type { AgentEvent, AgentState, AgentStatus, CurrentTool, OfficeState, TokenUsage } from './types.ts';

export const TOOL_ID_MEMORY = 64;
export const RUNNING_TOOLS_LIMIT = 16;
export const TEXT_LIMIT = 600;

export const EMPTY_OFFICE: OfficeState = { agents: {} };

const ZERO_TOKENS: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const clip = (text: string): string => (text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT - 1)}…` : text);
const clipOrNull = (text: string | null | undefined): string | null => (text == null ? null : clip(text));

const remember = (ids: readonly string[], id: string): readonly string[] =>
  ids.includes(id) ? ids : [...ids, id].slice(-TOOL_ID_MEMORY);

/** Own-property lookup: agent ids come from outside and may be "constructor" or "__proto__". */
export const agentOf = (state: OfficeState, id: string): AgentState | undefined =>
  Object.hasOwn(state.agents, id) ? state.agents[id] : undefined;

export function createAgent(event: AgentEvent): AgentState {
  const { sessionId, subagentId } = parseAgentKey(event.agentId);
  const seen = event.type === 'agent.seen' ? event : null;
  return {
    id: event.agentId,
    kind: seen?.kind ?? (subagentId ? 'subagent' : 'session'),
    sessionId: seen?.sessionId ?? sessionId,
    parentId: seen ? seen.parentId : subagentId ? sessionId : null,
    title: null,
    agentType: null,
    cwd: null,
    model: null,
    status: 'idle',
    // No transition has happened yet: any dated status event may set the first one.
    statusChangedAt: 0,
    startedAt: event.at,
    lastActivityAt: event.at,
    endedAt: null,
    currentTool: null,
    runningTools: [],
    pendingPermission: null,
    lastPrompt: null,
    lastMessage: null,
    tokens: ZERO_TOKENS,
    toolCalls: 0,
    toolErrors: 0,
    seenToolIds: [],
    finishedToolIds: [],
  };
}

/** The tool shown for an agent is the most recently started of those still running. */
const withRunning = (runningTools: readonly CurrentTool[]): Pick<AgentState, 'runningTools' | 'currentTool'> => ({
  runningTools,
  currentTool: runningTools.at(-1) ?? null,
});

const STOPPED = withRunning([]);

/** Applies a status change unless a newer status is already known, or the agent is over. */
function withStatus(agent: AgentState, status: AgentStatus, at: number, patch: Partial<AgentState> = {}): AgentState {
  if (at < agent.statusChangedAt) return agent;
  if (agent.status === 'ended' && status !== 'ended') return agent;
  return { ...agent, ...patch, status, statusChangedAt: at };
}

function touch(agent: AgentState, at: number): AgentState {
  return {
    ...agent,
    startedAt: Math.min(agent.startedAt, at),
    lastActivityAt: Math.max(agent.lastActivityAt, at),
  };
}

function applyToAgent(prev: AgentState, event: AgentEvent): AgentState {
  const agent = touch(prev, event.at);
  switch (event.type) {
    case 'agent.seen':
      return {
        ...agent,
        kind: event.kind,
        sessionId: event.sessionId,
        parentId: event.parentId,
        cwd: clipOrNull(event.cwd) ?? agent.cwd,
        title: agent.title ?? clipOrNull(event.title),
        agentType: clipOrNull(event.agentType) ?? agent.agentType,
      };
    case 'agent.start':
      // The only transition allowed out of "ended": a resumed session or a subagent starting again.
      if (event.at < agent.statusChangedAt) return agent;
      return { ...agent, status: event.status, statusChangedAt: event.at, endedAt: null };
    case 'title':
      return { ...agent, title: clip(event.title) };
    case 'prompt':
      return withStatus({ ...agent, lastPrompt: clip(event.text) }, 'working', event.at, { ...STOPPED, pendingPermission: null });
    case 'message':
      return { ...agent, lastMessage: clip(event.text) };
    case 'tool.start':
      return startTool(agent, event);
    case 'tool.end':
      return endTool(agent, event);
    case 'permission.wait':
      return withStatus(agent, 'waiting_permission', event.at, { pendingPermission: clip(event.message) });
    case 'turn.end':
      return withStatus(agent, 'idle', event.at, { ...STOPPED, pendingPermission: null });
    case 'usage':
      return {
        ...agent,
        model: clipOrNull(event.model) ?? agent.model,
        tokens: {
          input: agent.tokens.input + event.input,
          output: agent.tokens.output + event.output,
          cacheRead: agent.tokens.cacheRead + event.cacheRead,
          cacheWrite: agent.tokens.cacheWrite + event.cacheWrite,
        },
      };
    case 'agent.end':
      return withStatus(agent, 'ended', event.at, { ...STOPPED, endedAt: event.at, pendingPermission: null });
  }
}

function startTool(agent: AgentState, event: Extract<AgentEvent, { type: 'tool.start' }>): AgentState {
  const firstSight = !agent.seenToolIds.includes(event.toolUseId);
  const counted: AgentState = {
    ...agent,
    toolCalls: agent.toolCalls + (firstSight ? 1 : 0),
    seenToolIds: remember(agent.seenToolIds, event.toolUseId),
  };
  const alreadyRunningOrDone =
    agent.runningTools.some((tool) => tool.id === event.toolUseId) || agent.finishedToolIds.includes(event.toolUseId);
  if (alreadyRunningOrDone) return counted;
  const tool = { id: event.toolUseId, name: event.name, summary: clip(event.summary), startedAt: event.at };
  const running = [...agent.runningTools, tool].sort((a, b) => a.startedAt - b.startedAt).slice(-RUNNING_TOOLS_LIMIT);
  return withStatus(counted, 'working', event.at, { ...withRunning(running), pendingPermission: null });
}

function endTool(agent: AgentState, event: Extract<AgentEvent, { type: 'tool.end' }>): AgentState {
  const firstEnd = !agent.finishedToolIds.includes(event.toolUseId);
  const counted: AgentState = {
    ...agent,
    toolErrors: agent.toolErrors + (firstEnd && event.isError ? 1 : 0),
    finishedToolIds: remember(agent.finishedToolIds, event.toolUseId),
  };
  if (!agent.runningTools.some((tool) => tool.id === event.toolUseId)) return counted;
  const running = withRunning(agent.runningTools.filter((tool) => tool.id !== event.toolUseId));
  return withStatus({ ...counted, ...running }, 'working', event.at, { pendingPermission: null });
}

function step(agents: Record<string, AgentState>, event: AgentEvent): void {
  const existing = Object.hasOwn(agents, event.agentId) ? agents[event.agentId] : undefined;
  agents[event.agentId] = applyToAgent(existing ?? createAgent(event), event);
}

/** Null-prototype record, so any agent id is a plain key. */
const emptyAgents = (): Record<string, AgentState> => Object.create(null) as Record<string, AgentState>;

export function reduce(state: OfficeState, event: AgentEvent): OfficeState {
  return reduceAll(state, [event]);
}

/** One copy of the agent table per batch, not per event: replaying a long history stays linear. */
export function reduceAll(state: OfficeState, events: readonly AgentEvent[]): OfficeState {
  if (events.length === 0) return state;
  const agents = Object.assign(emptyAgents(), state.agents);
  for (const event of events) step(agents, event);
  return { agents };
}
