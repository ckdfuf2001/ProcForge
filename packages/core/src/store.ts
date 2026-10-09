import type { Store } from "@procforge/shared/store.js";
import type { Node, Session } from "@procforge/shared/schema.js";
import type { EventEntry } from "@procforge/shared/dto.js";

export type { Store };

export function createMemoryStore(): Store {
  const sessions = new Map<string, Session>();
  const nodes = new Map<string, Map<string, Node>>();
  const events = new Map<string, EventEntry[]>();
  return {
    getSession: (id) => sessions.get(id),
    saveSession: (s) => {
      sessions.set(s.id, s);
      if (!nodes.has(s.id)) nodes.set(s.id, new Map());
    },
    getNodes: (sid) => nodes.get(sid) ?? new Map(),
    getNode: (sid, nid) => nodes.get(sid)?.get(nid),
    saveNode: (sid, n) => {
      if (!nodes.has(sid)) nodes.set(sid, new Map());
      nodes.get(sid)!.set(n.id, { ...n });
    },
    appendEvents: (sid, evts) => {
      events.set(sid, [...(events.get(sid) ?? []), ...evts]);
    },
  };
}
