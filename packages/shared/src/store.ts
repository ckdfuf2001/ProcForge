import type { Node, Session } from "./schema.js";
import type { EventEntry } from "./dto.js";

// 영속성 포트. core·local 모두 shared의 이 인터페이스에만 의존한다.
// (local→core 직접 import 금지 회피용. M0-6/DECISIONS 참조)

/** 원자 커밋 단위 (M4.2-2.5-3): 세션+노드+이벤트 일괄 */
export type CommitChange = {
  session?: Session;
  nodes?: Node[];
  events?: EventEntry[];
};

export type Store = {
  getSession(id: string): Session | undefined;
  saveSession(s: Session): void;
  getNodes(sessionId: string): Map<string, Node>;
  getNode(sessionId: string, nodeId: string): Node | undefined;
  saveNode(sessionId: string, n: Node): void;
  /** 상태 이벤트 append (R6 트랜잭션: 상태 저장 전 호출, 실패 시 전체 실패) */
  appendEvents(sessionId: string, events: EventEntry[]): void;
  /** 상태 이벤트 조회 (R7 히스토리 원천) */
  readEvents(sessionId: string): EventEntry[];
  /** 세션 TTL용 최종 사용 시각 (없으면 undefined) */
  getLastUsed(sessionId: string): number | undefined;
  /** 최종 사용 시각 갱신 */
  touchSession(sessionId: string): void;
  /** 세션 잠금 안에서 실행 (M4.2-2.5, core change 트랜잭션용. 대기 후 conflict) */
  withLock<T>(sessionId: string, fn: () => T | Promise<T>): Promise<T>;
  /** 원자 커밋 (M4.2-2.5-3): pending 기록 후 일괄 반영 */
  commitChange(sessionId: string, change: CommitChange): void;
};
