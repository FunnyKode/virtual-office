// Structured logs on stderr, one JSON object per line.
export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

const serialize = (value: unknown): unknown =>
  value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value;

export function createLogger(write: (line: string) => void = (line) => process.stderr.write(line)): Logger {
  const log = (level: string, message: string, context: Record<string, unknown> = {}) => {
    const fields = Object.fromEntries(Object.entries(context).map(([key, value]) => [key, serialize(value)]));
    write(`${JSON.stringify({ time: new Date().toISOString(), level, message, ...fields })}\n`);
  };
  return {
    info: (message, context) => log('info', message, context),
    error: (message, context) => log('error', message, context),
  };
}
