// Turns Claude Code transcript lines (JSONL) into domain events.
// Observed format (Claude Code 2.1): one entry per line; an assistant message is split over several
// lines sharing message.id, each repeating its usage, so usage is counted as a delta per message id.
import type { AgentEvent, AgentKind, TokenUsage } from '../domain/types.ts';
import { summarizeTool } from './tool-summary.ts';

export interface TranscriptContext {
  readonly agentId: string;
  readonly sessionId: string;
  readonly kind: AgentKind;
  readonly parentId: string | null;
}

export interface TranscriptParser {
  parseLine(line: string): AgentEvent[];
}

type Entry = Record<string, unknown>;
type Block = Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const asNumber = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function blocksOf(entry: Entry): Block[] {
  const message = entry['message'];
  if (!isRecord(message)) return [];
  const content = message['content'];
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function usageOf(message: Record<string, unknown>): TokenUsage | null {
  const usage = message['usage'];
  if (!isRecord(usage)) return null;
  return {
    input: asNumber(usage['input_tokens']),
    output: asNumber(usage['output_tokens']),
    cacheRead: asNumber(usage['cache_read_input_tokens']),
    cacheWrite: asNumber(usage['cache_creation_input_tokens']),
  };
}

/** Written by Claude Code when the user presses Escape; no end_turn and no Stop hook follow. */
const INTERRUPTION = /^\[Request interrupted by user/;
/** Messages repeat on consecutive lines, so a short memory of message ids is enough to deduplicate usage. */
export const USAGE_MEMORY = 256;
/** Timestamps further in the future than this are clamped, so one bad line cannot freeze statuses. */
export const MAX_CLOCK_SKEW_MS = 5_000;

function userText(entry: Entry): string {
  const message = entry['message'];
  if (!isRecord(message)) return '';
  const content = message['content'];
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter(isRecord)
    .filter((block) => block['type'] === 'text')
    .map((block) => asString(block['text']) ?? '')
    .join('\n')
    .trim();
}

/** A prompt typed by a person (or given to a subagent), as opposed to tool results and injected context. */
function humanPrompt(entry: Entry, text: string): string | null {
  if (entry['isMeta'] === true || !text) return null;
  const origin = entry['origin'];
  if (isRecord(origin) && origin['kind'] !== 'human') return null;
  if (!isRecord(origin) && text.startsWith('<')) return null;
  return text;
}

export function createTranscriptParser(context: TranscriptContext, now: () => number = Date.now): TranscriptParser {
  const countedUsage = new Map<string, TokenUsage>();
  let lastTimestamp: number | null = null;
  let cwdReported = false;

  const base = (at: number) => ({ at, agentId: context.agentId, source: 'transcript' as const });

  function usageDelta(messageId: string, usage: TokenUsage, model: string | null, at: number): AgentEvent[] {
    const previous = countedUsage.get(messageId) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const delta = {
      input: Math.max(0, usage.input - previous.input),
      output: Math.max(0, usage.output - previous.output),
      cacheRead: Math.max(0, usage.cacheRead - previous.cacheRead),
      cacheWrite: Math.max(0, usage.cacheWrite - previous.cacheWrite),
    };
    countedUsage.delete(messageId);
    if (countedUsage.size >= USAGE_MEMORY) countedUsage.delete(countedUsage.keys().next().value!);
    countedUsage.set(messageId, {
      input: Math.max(usage.input, previous.input),
      output: Math.max(usage.output, previous.output),
      cacheRead: Math.max(usage.cacheRead, previous.cacheRead),
      cacheWrite: Math.max(usage.cacheWrite, previous.cacheWrite),
    });
    const empty = delta.input + delta.output + delta.cacheRead + delta.cacheWrite === 0;
    return empty ? [] : [{ ...base(at), type: 'usage', model, ...delta }];
  }

  function assistantEvents(entry: Entry, at: number): AgentEvent[] {
    const message = entry['message'];
    if (!isRecord(message)) return [];
    const events: AgentEvent[] = [];
    for (const block of blocksOf(entry)) {
      const type = block['type'];
      const id = asString(block['id']);
      const name = asString(block['name']);
      if (type === 'tool_use' && id && name) {
        events.push({ ...base(at), type: 'tool.start', toolUseId: id, name, summary: summarizeTool(name, block['input']) });
      } else if (type === 'text') {
        const text = asString(block['text'])?.trim();
        if (text) events.push({ ...base(at), type: 'message', text });
      }
    }
    const messageId = asString(message['id']);
    const usage = usageOf(message);
    if (messageId && usage) events.push(...usageDelta(messageId, usage, asString(message['model']), at));
    if (message['stop_reason'] === 'end_turn') events.push({ ...base(at), type: 'turn.end' });
    return events;
  }

  function userEvents(entry: Entry, at: number): AgentEvent[] {
    const results: AgentEvent[] = blocksOf(entry)
      .filter((block) => block['type'] === 'tool_result' && asString(block['tool_use_id']))
      .map((block) => ({
        ...base(at),
        type: 'tool.end',
        toolUseId: String(block['tool_use_id']),
        isError: block['is_error'] === true,
      }));
    const text = userText(entry);
    if (INTERRUPTION.test(text)) return [...results, { ...base(at), type: 'turn.end' }];
    if (results.length > 0) return results;
    const prompt = humanPrompt(entry, text);
    return prompt ? [{ ...base(at), type: 'prompt', text: prompt }] : [];
  }

  function parseEntry(entry: Entry): AgentEvent[] {
    // Older versions interleaved subagent messages in the session file; those belong to the subagent.
    if (context.kind === 'session' && entry['isSidechain'] === true) return [];
    const parsed = Date.parse(asString(entry['timestamp']) ?? '');
    const at = Number.isNaN(parsed) ? lastTimestamp : Math.min(parsed, now() + MAX_CLOCK_SKEW_MS);
    if (at === null) return [];
    lastTimestamp = Math.max(lastTimestamp ?? at, at);

    const events: AgentEvent[] = [];
    const cwd = asString(entry['cwd']);
    if (cwd && !cwdReported) {
      cwdReported = true;
      events.push({ ...base(at), type: 'agent.seen', kind: context.kind, sessionId: context.sessionId, parentId: context.parentId, cwd });
    }
    switch (entry['type']) {
      case 'custom-title': {
        const title = asString(entry['customTitle'])?.trim();
        if (title) events.push({ ...base(at), type: 'title', title });
        break;
      }
      case 'user':
        events.push(...userEvents(entry, at));
        break;
      case 'assistant':
        events.push(...assistantEvents(entry, at));
        break;
      case 'system':
        if (entry['subtype'] === 'stop_hook_summary') events.push({ ...base(at), type: 'turn.end' });
        break;
    }
    return events;
  }

  return {
    parseLine(line) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        return [];
      }
      return isRecord(entry) ? parseEntry(entry) : [];
    },
  };
}
