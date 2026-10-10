import type { Store } from "@procforge/shared/store.js";
import type { Node, Session } from "@procforge/shared/schema.js";
import type { CommitChange } from "@procforge/shared/store.js";
import type { EventEntry } from "@procforge/shared/dto.js";

export type { Store };

export function createMemoryStore(): Store {
  const sessions = new Map<string, Session>();
  const nodes = new Map<string, Map<string, Node>>();
  const events = new Map<string, EventEntry[]>();
  const lastUsed = new Map<string, number>();
  const apply = (sid: string, c: CommitChange) => {
    for (const n of c.nodes ?? []) {
      if (!nodes.has(sid)) nodes.set(sid, new Map());
      nodes.get(sid)!.set(n.id, { ...n });
    }
    if (c.session) {
      sessions.set(c.session.id, c.session);
      if (!nodes.has(c.session.id)) nodes.set(c.session.id, new Map());
    }
    if (c.events?.length) events.set(sid, [...(events.get(sid) ?? []), ...c.events]);
  };
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
    readEvents: (sid) => [...(events.get(sid) ?? [])],
    getLastUsed: (sid) => lastUsed.get(sid),
    touchSession: (sid) => {
      lastUsed.set(sid, Date.now());
    },
    withLock: async (_sid, fn) => await fn(),
    commitChange: (sid, c) => apply(sid, c),
  };
}
