import { describe, expect, it, vi } from 'vitest';
import { createStore } from '../src/domain/store.ts';
import { ev } from './helpers.ts';

const MINUTE = 60_000;

describe('store', () => {
  it('notifies subscribers with views of the changed agents only', () => {
    const store = createStore({ silenceMs: MINUTE, windowMs: 60 * MINUTE, now: () => 1000 });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.dispatch([ev('prompt', 1000, { text: 'a' }, 's1'), ev('prompt', 1000, { text: 'b' }, 's2')]);
    expect(listener).toHaveBeenCalledTimes(1);
    const changed = listener.mock.calls[0]![0];
    expect(changed.map((view: { id: string }) => view.id).sort()).toEqual(['s1', 's2']);
    expect(changed[0]).not.toHaveProperty('seenToolIds');
    unsubscribe();
    store.dispatch([ev('turn.end', 1001, {}, 's1')]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does nothing for an empty batch', () => {
    const store = createStore({ silenceMs: MINUTE, windowMs: MINUTE });
    const listener = vi.fn();
    store.subscribe(listener);
    store.dispatch([]);
    expect(listener).not.toHaveBeenCalled();
  });

  it('isolates a failing subscriber from the others', () => {
    const onListenerError = vi.fn();
    const store = createStore({ silenceMs: MINUTE, windowMs: MINUTE, onListenerError });
    const healthy = vi.fn();
    store.subscribe(() => {
      throw new Error('boom');
    });
    store.subscribe(healthy);
    store.dispatch([ev('prompt', Date.now(), { text: 'x' })]);
    expect(onListenerError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('marks busy agents silent for too long as stale, and sorts by recent activity', () => {
    let now = 0;
    const store = createStore({ silenceMs: MINUTE, windowMs: 60 * MINUTE, now: () => now });
    store.dispatch([ev('prompt', 0, { text: 'old' }, 'busy'), ev('turn.end', 0, {}, 'idle'), ev('prompt', 30_000, { text: 'new' }, 'recent')]);
    now = 2 * MINUTE;
    const views = store.snapshot();
    expect(views.map((view) => view.id)).toEqual(['recent', 'busy', 'idle']);
    expect(views.find((view) => view.id === 'busy')?.stale).toBe(true);
    expect(views.find((view) => view.id === 'idle')?.stale).toBe(false);
  });

  it('hides and prunes agents outside the window', () => {
    let now = 0;
    const store = createStore({ silenceMs: MINUTE, windowMs: 10 * MINUTE, now: () => now });
    store.dispatch([ev('prompt', 0, { text: 'a' }, 'old'), ev('prompt', 9 * MINUTE, { text: 'b' }, 'fresh')]);
    now = 15 * MINUTE;
    expect(store.snapshot().map((view) => view.id)).toEqual(['fresh']);
    expect(store.prune()).toBe(1);
    expect(Object.keys(store.state().agents)).toEqual(['fresh']);
    expect(store.prune()).toBe(0);
  });
});
