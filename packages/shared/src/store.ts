import type { Node, Session } from "./schema.js";

// 영속성 포트. core·local 모두 shared의 이 인터페이스에만 의존한다.
// (local→core 직접 import 금지 회피용. M0-6/DECISIONS 참조)
export type Store = {
  getSession(id: string): Session | undefined;
  saveSession(s: Session): void;
  getNodes(sessionId: string): Map<string, Node>;
  getNode(sessionId: string, nodeId: string): Node | undefined;
  saveNode(sessionId: string, n: Node): void;
};
