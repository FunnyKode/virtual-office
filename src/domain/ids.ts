// Agent identity: a session is its session id, a subagent is "<sessionId>/<subagentId>".

export function sessionKey(sessionId: string): string {
  return sessionId;
}

export function subagentKey(sessionId: string, subagentId: string): string {
  return `${sessionId}/${subagentId}`;
}

export function parseAgentKey(key: string): { sessionId: string; subagentId: string | null } {
  const slash = key.indexOf('/');
  if (slash < 0) return { sessionId: key, subagentId: null };
  return { sessionId: key.slice(0, slash), subagentId: key.slice(slash + 1) };
}
