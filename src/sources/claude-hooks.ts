// Translates Claude Code hook payloads (JSON received on the hook's stdin, relayed by hooks/relay.mjs)
// into domain events. Unknown hook names are accepted and ignored, so new Claude Code versions stay harmless.
import { sessionKey, subagentKey } from '../domain/ids.ts';
import type { AgentEvent } from '../domain/types.ts';
import { summarizeTool } from './tool-summary.ts';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type HookParseResult =
  | { readonly ok: true; readonly events: AgentEvent[] }
  | { readonly ok: false; readonly error: string };

type Payload = Record<string, unknown>;

const str = (payload: Payload, key: string): string | null => {
  const value = payload[key];
  return typeof value === 'string' && value !== '' ? value : null;
};

function isPermissionNotification(payload: Payload): boolean {
  const kind = str(payload, 'notification_type');
  if (kind) return kind === 'permission_prompt';
  return /permission/i.test(str(payload, 'message') ?? '');
}

function eventsFor(name: string, payload: Payload, agentId: string, at: number): AgentEvent[] {
  const base = { at, agentId, source: 'hook' as const };
  const toolUseId = str(payload, 'tool_use_id');
  const toolName = str(payload, 'tool_name') ?? 'outil';
  switch (name) {
    case 'SessionStart':
      // A compaction happens in the middle of a turn: the session is still working.
      return str(payload, 'source') === 'compact' ? [] : [{ ...base, type: 'agent.start', status: 'idle' }];
    case 'SubagentStart':
      return [{ ...base, type: 'agent.start', status: 'working' }];
    case 'UserPromptSubmit':
      return [{ ...base, type: 'prompt', text: str(payload, 'prompt') ?? '' }];
    case 'PreToolUse':
      return toolUseId
        ? [{ ...base, type: 'tool.start', toolUseId, name: toolName, summary: summarizeTool(toolName, payload['tool_input']) }]
        : [];
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return toolUseId ? [{ ...base, type: 'tool.end', toolUseId, isError: name === 'PostToolUseFailure' }] : [];
    case 'PermissionRequest':
      return [{ ...base, type: 'permission.wait', message: `Autorisation demandée : ${summarizeTool(toolName, payload['tool_input'])}` }];
    case 'Notification':
      if (isPermissionNotification(payload)) return [{ ...base, type: 'permission.wait', message: str(payload, 'message') ?? 'Autorisation demandée' }];
      return str(payload, 'notification_type') === 'idle_prompt' ? [{ ...base, type: 'turn.end' }] : [];
    case 'Stop':
      return [{ ...base, type: 'turn.end' }];
    case 'SubagentStop':
    case 'SessionEnd':
      return [{ ...base, type: 'agent.end', reason: str(payload, 'reason') }];
    default:
      return [];
  }
}

export function parseHookPayload(body: unknown, at: number): HookParseResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'objet JSON attendu' };
  const payload = body as Payload;
  const name = str(payload, 'hook_event_name');
  const sessionId = str(payload, 'session_id');
  const subagentId = str(payload, 'agent_id');
  if (!name) return { ok: false, error: 'hook_event_name manquant' };
  if (!sessionId || !ID_PATTERN.test(sessionId)) return { ok: false, error: 'session_id manquant ou invalide' };
  if (subagentId !== null && !ID_PATTERN.test(subagentId)) return { ok: false, error: 'agent_id invalide' };

  const agentId = subagentId ? subagentKey(sessionId, subagentId) : sessionKey(sessionId);
  const specific = eventsFor(name, payload, agentId, at);
  if (specific.length === 0) return { ok: true, events: [] };
  const seen: AgentEvent = {
    at,
    agentId,
    source: 'hook',
    type: 'agent.seen',
    kind: subagentId ? 'subagent' : 'session',
    sessionId,
    parentId: subagentId ? sessionKey(sessionId) : null,
    cwd: str(payload, 'cwd'),
    agentType: str(payload, 'agent_type'),
  };
  return { ok: true, events: [seen, ...specific] };
}
