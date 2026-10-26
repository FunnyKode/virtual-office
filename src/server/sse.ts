// Server-Sent Events hub: one long-lived response per client, heartbeats, and eviction of clients
// that stop reading (a stuck tab must not make the server buffer without limit).
import type { ServerResponse } from 'node:http';

export interface SseHubOptions {
  readonly heartbeatMs: number;
  readonly maxClients: number;
  readonly maxBufferedBytes: number;
}

export interface SseHub {
  /** Returns false when the hub is full; the caller then answers 503. */
  add(res: ServerResponse, initial: { event: string; data: unknown }): boolean;
  broadcast(event: string, data: unknown): void;
  size(): number;
  close(): void;
}

const frame = (id: number, event: string, data: unknown): string =>
  `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function createSseHub(options: SseHubOptions): SseHub {
  const clients = new Set<ServerResponse>();
  let nextId = 1;

  function send(res: ServerResponse, chunk: string): void {
    if (res.writableLength > options.maxBufferedBytes) {
      clients.delete(res);
      res.destroy();
      return;
    }
    res.write(chunk);
  }

  const heartbeat = setInterval(() => {
    for (const res of clients) send(res, ': ping\n\n');
  }, options.heartbeatMs);
  heartbeat.unref();

  return {
    add(res, initial) {
      if (clients.size >= options.maxClients) return false;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-content-type-options': 'nosniff',
        'x-accel-buffering': 'no',
      });
      clients.add(res);
      res.on('close', () => clients.delete(res));
      send(res, `retry: 3000\n${frame(nextId++, initial.event, initial.data)}`);
      return true;
    },
    broadcast(event, data) {
      if (clients.size === 0) return;
      const chunk = frame(nextId++, event, data);
      for (const res of clients) send(res, chunk);
    },
    size: () => clients.size,
    close() {
      clearInterval(heartbeat);
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}
