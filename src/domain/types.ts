// Shared vocabulary between collectors (hooks, transcripts), the store and the HTTP layer.

export type AgentKind = 'session' | 'subagent';

/**
 * - working: a turn is in progress (prompt received, tools running)
 * - waiting_permission: Claude Code is blocked on a user approval
 * - idle: the turn ended, the session waits for its owner
 * - ended: the session or subagent is over
 */
export type AgentStatus = 'working' | 'waiting_permission' | 'idle' | 'ended';

export type EventSource = 'hook' | 'transcript';

export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface CurrentTool {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly startedAt: number;
}

export interface AgentState {
  readonly id: string;
  readonly kind: AgentKind;
  readonly sessionId: string;
  readonly parentId: string | null;
  readonly title: string | null;
  readonly agentType: string | null;
  readonly cwd: string | null;
  readonly model: string | null;
  readonly status: AgentStatus;
  /** Event time of the last status change: older events cannot overwrite a newer status. */
  readonly statusChangedAt: number;
  readonly startedAt: number;
  readonly lastActivityAt: number;
  readonly endedAt: number | null;
  /** Most recently started tool among those still running (tools can run in parallel). */
  readonly currentTool: CurrentTool | null;
  readonly runningTools: readonly CurrentTool[];
  readonly pendingPermission: string | null;
  readonly lastPrompt: string | null;
  readonly lastMessage: string | null;
  readonly tokens: TokenUsage;
  readonly toolCalls: number;
  readonly toolErrors: number;
  /** Bounded memories of tool ids, so hook and transcript copies of one call count once. */
  readonly seenToolIds: readonly string[];
  readonly finishedToolIds: readonly string[];
}

export interface OfficeState {
  readonly agents: Readonly<Record<string, AgentState>>;
}

interface EventBase {
  readonly at: number;
  readonly agentId: string;
  readonly source: EventSource;
}

export type AgentEvent = EventBase &
  (
    | {
        readonly type: 'agent.seen';
        readonly kind: AgentKind;
        readonly sessionId: string;
        readonly parentId: string | null;
        readonly cwd?: string | null;
        readonly title?: string | null;
        readonly agentType?: string | null;
      }
    | { readonly type: 'agent.start'; readonly status: 'idle' | 'working' }
    | { readonly type: 'title'; readonly title: string }
    | { readonly type: 'prompt'; readonly text: string }
    | { readonly type: 'message'; readonly text: string }
    | { readonly type: 'tool.start'; readonly toolUseId: string; readonly name: string; readonly summary: string }
    | { readonly type: 'tool.end'; readonly toolUseId: string; readonly isError: boolean }
    | { readonly type: 'permission.wait'; readonly message: string }
    | { readonly type: 'turn.end' }
    | ({ readonly type: 'usage'; readonly model: string | null } & TokenUsage)
    | { readonly type: 'agent.end'; readonly reason: string | null }
  );

export type AgentEventType = AgentEvent['type'];

/** What clients receive: the stored state plus fields derived from the current time. */
export interface AgentView extends Omit<AgentState, 'seenToolIds' | 'finishedToolIds'> {
  /** Working or waiting, but silent for longer than the configured silence threshold. */
  readonly stale: boolean;
}
