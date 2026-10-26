// Adds or removes the virtual-office relay in a Claude Code settings object, leaving every other
// setting and hook untouched. Our entries are recognised by the marker argument on their command.

export const MARKER = '--virtual-office';
export const HOOK_TIMEOUT_SECONDS = 5;

/** Hook events relayed to the office. Tool events take a matcher; the others must not have one. */
export const TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'] as const;
export const OTHER_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Notification', 'Stop', 'SubagentStart', 'SubagentStop'] as const;

type Json = Record<string, unknown>;

interface HookCommand {
  readonly type: 'command';
  readonly command: string;
  readonly timeout: number;
}

interface HookGroup {
  readonly matcher?: string;
  readonly hooks: readonly unknown[];
}

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

export function relayCommand(relayPath: string): string {
  return `node ${JSON.stringify(relayPath)} ${MARKER}`;
}

const isOurs = (hook: unknown): boolean =>
  isRecord(hook) && typeof hook['command'] === 'string' && hook['command'].endsWith(MARKER);

function withoutOurs(groups: unknown): HookGroup[] {
  if (!Array.isArray(groups)) return [];
  return groups
    .filter(isRecord)
    .map((group) => ({ ...group, hooks: Array.isArray(group['hooks']) ? group['hooks'].filter((hook) => !isOurs(hook)) : [] }))
    .filter((group) => group.hooks.length > 0);
}

function hooksOf(settings: Json): Json {
  const hooks = settings['hooks'];
  if (hooks !== undefined && !isRecord(hooks)) throw new Error('le champ "hooks" des réglages n’est pas un objet');
  return hooks ?? {};
}

export function removeRelay(settings: Json): Json {
  const hooks = hooksOf(settings);
  const cleaned = Object.fromEntries(
    Object.entries(hooks)
      .map(([event, groups]): [string, HookGroup[]] => [event, withoutOurs(groups)])
      .filter(([, groups]) => groups.length > 0),
  );
  const { hooks: _previous, ...rest } = settings;
  return Object.keys(cleaned).length > 0 ? { ...rest, hooks: cleaned } : rest;
}

export function installRelay(settings: Json, relayPath: string): Json {
  const base = removeRelay(settings);
  const hooks = hooksOf(base);
  const ours: HookCommand = { type: 'command', command: relayCommand(relayPath), timeout: HOOK_TIMEOUT_SECONDS };
  const added = [
    ...TOOL_EVENTS.map((event) => [event, { matcher: '*', hooks: [ours] }] as const),
    ...OTHER_EVENTS.map((event) => [event, { hooks: [ours] }] as const),
  ];
  const merged = { ...hooks };
  for (const [event, group] of added) {
    const existing = Array.isArray(merged[event]) ? (merged[event] as unknown[]) : [];
    merged[event] = [...existing, group];
  }
  return { ...base, hooks: merged };
}
