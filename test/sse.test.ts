import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createSseHub } from '../src/server/sse.ts';

function fakeResponse(writableLength = 0) {
  const emitter = new EventEmitter();
  const written: string[] = [];
  const res = Object.assign(emitter, {
    writableLength,
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => written.push(chunk)),
    end: vi.fn(),
    destroy: vi.fn(),
  });
  return { res: res as unknown as ServerResponse & typeof res, written, emitter };
}

describe('SSE hub', () => {
  it('numbers frames, broadcasts to every client and forgets closed ones', () => {
    const hub = createSseHub({ heartbeatMs: 60_000, maxClients: 5, maxBufferedBytes: 1000 });
    const a = fakeResponse();
    const b = fakeResponse();
    hub.add(a.res, { event: 'snapshot', data: { n: 1 } });
    hub.add(b.res, { event: 'snapshot', data: { n: 2 } });
    expect(a.written[0]).toBe('retry: 3000\nid: 1\nevent: snapshot\ndata: {"n":1}\n\n');
    hub.broadcast('agents', [{ id: 'x' }]);
    expect(b.written.at(-1)).toBe('id: 3\nevent: agents\ndata: [{"id":"x"}]\n\n');
    b.emitter.emit('close');
    expect(hub.size()).toBe(1);
    hub.close();
    expect(a.res.end).toHaveBeenCalled();
    expect(hub.size()).toBe(0);
    hub.broadcast('agents', []);
  });

  it('evicts a client that stopped reading instead of buffering forever', () => {
    const hub = createSseHub({ heartbeatMs: 60_000, maxClients: 5, maxBufferedBytes: 10 });
    const slow = fakeResponse(11);
    hub.add(slow.res, { event: 'snapshot', data: {} });
    expect(slow.res.destroy).toHaveBeenCalled();
    expect(hub.size()).toBe(0);
    hub.close();
  });

  it('sends heartbeats so proxies and browsers keep the stream open', () => {
    vi.useFakeTimers();
    try {
      const hub = createSseHub({ heartbeatMs: 1000, maxClients: 5, maxBufferedBytes: 1000 });
      const client = fakeResponse();
      hub.add(client.res, { event: 'snapshot', data: {} });
      vi.advanceTimersByTime(2500);
      expect(client.written.filter((chunk) => chunk === ': ping\n\n')).toHaveLength(2);
      hub.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
