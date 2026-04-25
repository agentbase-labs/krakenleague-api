/**
 * In-process event bus for WebSocket fanout.
 *
 * TODO: replace with Redis pub/sub when we scale to >1 node.
 */
type Handler = (payload: unknown) => void;

const handlers = new Map<string, Set<Handler>>();

export function subscribe(channel: string, h: Handler): () => void {
  let set = handlers.get(channel);
  if (!set) {
    set = new Set();
    handlers.set(channel, set);
  }
  set.add(h);
  return () => {
    const s = handlers.get(channel);
    if (s) s.delete(h);
  };
}

export function publish(channel: string, payload: unknown) {
  const s = handlers.get(channel);
  if (!s) return;
  for (const h of s) {
    try {
      h(payload);
    } catch (e) {
      // ignore per-subscriber errors
    }
  }
}
