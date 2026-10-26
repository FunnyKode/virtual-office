const SUMMARY_LIMIT = 200;
const SUMMARY_KEYS = ['command', 'description', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt'] as const;

/** One readable line for a tool call: its name followed by its most telling argument. */
export function summarizeTool(name: string, input: unknown): string {
  const fields = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const key = SUMMARY_KEYS.find((candidate) => typeof fields[candidate] === 'string' && fields[candidate] !== '');
  const detail = key ? String(fields[key]).replace(/\s+/g, ' ').trim() : '';
  return `${name}${detail ? ` ${detail}` : ''}`.slice(0, SUMMARY_LIMIT);
}
