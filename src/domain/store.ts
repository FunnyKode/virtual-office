// Holds the office state and tells subscribers which agents changed.
import { EMPTY_OFFICE, agentOf, reduceAll } from './reducer.ts';
import type { AgentEvent, AgentState, AgentView, OfficeState } from './types.ts';
import { isInWindow, listViews, toView } from './views.ts';

export type ChangeListener = (changed: readonly AgentView[]) => void;

export interface StoreOptions {
  readonly silenceMs: number;
  readonly windowMs: number;
  readonly now?: () => number;
  readonly onListenerError?: (error: unknown) => void;
}

export interface Store {
  dispatch(events: readonly AgentEvent[]): void;
  snapshot(): AgentView[];
  state(): OfficeState;
  subscribe(listener: ChangeListener): () => void;
  /** Forgets agents silent for longer than the window, so memory stays bounded on long runs. */
  prune(): number;
}

export function createStore(options: StoreOptions): Store {
  const now = options.now ?? Date.now;
  const listeners = new Set<ChangeListener>();
  let current: OfficeState = EMPTY_OFFICE;

  function notify(changed: readonly AgentView[]): void {
    for (const listener of listeners) {
      try {
        listener(changed);
      } catch (error) {
        options.onListenerError?.(error);
      }
    }
  }

  return {
    dispatch(events) {
      if (events.length === 0) return;
      const previous = current;
      current = reduceAll(previous, events);
      const at = now();
      const changedIds = new Set(events.map((event) => event.agentId));
      const changed = [...changedIds].flatMap((id) => {
        const agent = agentOf(current, id);
        return agent && agent !== agentOf(previous, id) ? [toView(agent, at, options.silenceMs)] : [];
      });
      if (changed.length > 0) notify(changed);
    },
    snapshot() {
      return listViews(current, { now: now(), silenceMs: options.silenceMs, windowMs: options.windowMs });
    },
    state() {
      return current;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    prune() {
      const at = now();
      const kept = Object.entries(current.agents).filter(([, agent]) => isInWindow(agent, at, options.windowMs));
      const removed = Object.keys(current.agents).length - kept.length;
      if (removed > 0) current = { agents: Object.assign(Object.create(null) as Record<string, AgentState>, Object.fromEntries(kept)) };
      return removed;
    },
  };
}
