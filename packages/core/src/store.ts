import type { Node, Session } from "@procforge/shared/schema.js";

export type Store = {
  getSession(id: string): Session | undefined;
  saveSession(s: Session): void;
  getNodes(sessionId: string): Map<string, Node>;
  getNode(sessionId: string, nodeId: string): Node | undefined;
  saveNode(sessionId: string, n: Node): void;
};

export function createMemoryStore(): Store {
  const sessions = new Map<string, Session>();
  const nodes = new Map<string, Map<string, Node>>();
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
  };
}
