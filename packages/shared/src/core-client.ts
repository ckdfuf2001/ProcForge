import type { Constraint, Node, Session, ArgSpec, SideEffect } from "./schema.js";
import type { Actor, EventEntry } from "./dto.js";
import type { ProcedureDoc } from "./procedure.js";

// local → core 호출은 반드시 이 인터페이스를 통해서만 한다. (가이드 §3, §8)
// M0~M5: packages/core가 이 인터페이스의 in-process 구현을 제공한다.
// M6: HTTP CoreClient 구현으로 교체한다. local 소스에서 core 직접 import 금지.

/** 변경 결과 공통 메타 (M4.2-2.5-5, 모든 변경 응답에 포함) */
export type ChangeMeta = {
  revision: number;
  changedNodeIds: string[];
};

export type PfStartInput = {
  request: string;
  params?: Record<string, string>;
  toolCatalog: Session["toolCatalog"];
  limits?: Session["limits"];
  /** 수집 시점 opencode 버전 (M3.6-7, 생략 시 "unknown") */
  opencodeVersion?: string;
};

export type PfStartOutput = {
  session: Session;
  node: Node;
  instruction: string;
};

export type PfNextOutput =
  | { done: false; node: Node; blocked?: BlockedEntry[]; instruction: string; revision: number; changedNodeIds: string[] }
  | { done: true; revision: number; changedNodeIds: string[] };

/** pfNext 본문 반환형 (메타 제외 유니온) */
export type PfNextPayload =
  | { done: false; node: Node; blocked?: BlockedEntry[]; instruction: string }
  | { done: true };

export type BlockedReason = "dep_failed" | "dep_empty_split" | "dep_missing" | "dep_pending";

export type BlockedEntry = {
  nodeId: string;
  waitingOn: string[];
  reason: BlockedReason;
};

export type PfReportInput = {
  sessionId: string;
  nodeId: string;
  tool: { server: string; name: string };
  args: Record<string, unknown>;
  resultSummary: string;
  resultJson?: unknown;
  artifacts?: string[];
  artifactContents?: Record<string, string>;
  /** 호스트 자기 판정 (필수, M1.5-2). constraints가 비었으면 이 값을 사용. */
  selfVerdict: "pass" | "fail";
  /** 자기 판정 사유 (필수) */
  selfReason: string;
  /** llm_rubric constraint id → 판정 사유. 남은 rubric은 전부 필요 (M1.5-3) */
  rubricReasons?: Record<string, string>;
  /** local이 미리 채번한 attempt id (fixture 경로 결정용, M2). 없으면 core가 채번 */
  attemptId?: string;
  expectedRevision?: number;
  actor?: Actor;
};

export type PfReportOutput = {
  verdict: "pass" | "fail" | "unverifiable";
  failedConstraints: string[];
  unverified?: string[];
  instruction: string;
} & ChangeMeta;

export type PfResolveDecision = "leaf" | "split" | "retry" | "ask_human";

export type PfResolveInput = {
  sessionId: string;
  nodeId: string;
  decision: PfResolveDecision;
  children?: { goal: string; dependsOn?: string[]; sideEffect?: SideEffect }[];
  argSpecs?: Record<string, ArgSpec>;
  sideEffect?: SideEffect;
  tool?: { server: string; name: string };
  /** ask_human용 dry-run 계획 (M2.6-4). attempt로 저장되고 실행되지 않음 */
  plan?: { tool: { server: string; name: string }; args: Record<string, unknown> };
  /** retry/ask_human 사유 기록용 (M2.6-4) */
  note?: string;
  /** leaf 확정 시 golden.ignore로 기록할 JSON 경로 (M3.1-2) */
  goldenIgnore?: string[];
  /** leaf 확정 시 attempt 결과물로 확정할 목록 (M4.2-2.5-4, 생략 시 마지막 attempt 유지) */
  artifacts?: string[];
  expectedRevision?: number;
  actor?: Actor;
};

export type PfResolveOutput = {
  node: Node;
  created?: Node[];
  instruction: string;
} & ChangeMeta;

export type PfAdviseOutput = {
  constraints: Constraint[];
  rejected: { proposal: unknown; reason: string }[];
  node: Node;
  /** 추가 안내 (M4 numeric 제안 유도 등) */
  note?: string;
} & ChangeMeta;

/** attempt artifacts 교체 (M4.2-1, 확정 보정용). golden은 이후 leaf 확정 시 재구성 */
export type AmendAttemptArtifactsInput = {
  sessionId: string;
  nodeId: string;
  attemptId: string;
  artifacts: string[];
  expectedRevision?: number;
  actor?: Actor;
};

/** 인자 패치 (M4.2-2): fixed 값 수정·fixed↔var 전환 + 키 삭제 */
export type PfEditArgsPatch = {
  set?: Record<string, ArgSpec>;
  remove?: string[];
};

export type PfEditArgsInput = {
  sessionId: string;
  nodeId: string;
  patch: PfEditArgsPatch;
  expectedRevision?: number;
  actor?: Actor;
};

export type PfEditNodeInput = {
  sessionId: string;
  nodeId: string;
  goal?: string;
  addConstraints?: Constraint[];
  removeConstraintIds?: string[];
  expectedRevision?: number;
  actor?: Actor;
};

export type PfAdviseInput = {
  sessionId: string;
  nodeId: string;
  text: string;
  /** 호스트 제안 조건 (M4). core가 최신 fixture로 평가해 채택/거부 */
  proposedConstraints?: unknown[];
  /** 최신 fixture 내용 (local이 읽어 전달, M4) */
  fixtureContents?: Record<string, string>;
  expectedRevision?: number;
  actor?: Actor;
};

// local checker → core 주입 계약. core·local 모두 shared 타입만 사용.
export type EvaluateFn = (
  constraints: Constraint[],
  ctx: { resultSummary?: string; resultJson?: unknown; artifacts?: Record<string, string>; fileExists?: (p: string) => boolean },
) => { verdict: "pass" | "fail"; failedConstraints: string[]; unverified?: string[] };

export interface CoreClient {
  pfStart(input: PfStartInput): Promise<PfStartOutput>;
  pfNext(input: PfNextInput): Promise<PfNextOutput>;
  pfReport(input: PfReportInput): Promise<PfReportOutput>;
  pfResolve(input: PfResolveInput): Promise<PfResolveOutput>;
  pfAdvise(input: PfAdviseInput): Promise<PfAdviseOutput>;
  pfTree(sessionId: string): Promise<{ nodes: Node[]; session: Session }>;
  pfLock(input: PfLockInput): Promise<{ node: Node } & ChangeMeta>;
  pfReopen(input: PfReopenInput): Promise<{ node: Node } & ChangeMeta>;
  /** attempt artifacts 교체 (server 직접 저장 대체) */
  amendAttemptArtifacts(input: AmendAttemptArtifactsInput): Promise<{ node: Node } & ChangeMeta>;
  /** 카탈로그 저장 (M4.2-2, 수집은 local). 세션 toolCatalog 교체 */
  pfUpdateCatalog(input: { sessionId: string; entries: unknown[]; expectedRevision?: number; actor?: Actor }): Promise<ChangeMeta>;
  /** 확정 인자 수정 (M4.2-2) */
  pfEditArgs(input: PfEditArgsInput): Promise<{ node: Node; instruction: string } & ChangeMeta>;
  /** 목표·검사 조건 직접 수정 (M4.2-2) */
  pfEditNode(input: PfEditNodeInput): Promise<{ node: Node; instruction: string } & ChangeMeta>;
  /** 상태 이벤트 조회 (M4.2-2, R7 히스토리 원천) */
  getEvents(sessionId: string, sinceSeq?: number): Promise<EventEntry[]>;
  /** 세션 조회 (M4.2-2.5, TTL 판정 포함) */
  getSession(sessionId: string): Promise<Session>;
  /** 노드 조회 (M4.2-2.5) */
  getNode(sessionId: string, nodeId: string): Promise<Node>;
  /** 절차서 문서 조립 (M4.2-1, 검증·params 경고 포함. 파일 쓰기는 local) */
  pfBuildProcedure(sessionId: string, name: string): Promise<{ doc: ProcedureDoc; warnings: string[] }>;
  /** external dry-run 계획 승인/거부 (M2.6-4) */
  pfApprove(input: PfApproveInput): Promise<{ node: Node } & ChangeMeta>;
}

/** 객체 입력 (M4.2-2.5-5, 순서 인자 통일) */
export type PfNextInput = {
  sessionId: string;
  expectedRevision?: number;
  actor?: Actor;
};

/** 객체 입력 (M4.2-2.5-5) */
export type PfLockInput = {
  sessionId: string;
  nodeId: string;
  expectedRevision?: number;
  actor?: Actor;
};

/** 객체 입력 (M4.2-2.5-5) */
export type PfReopenInput = {
  sessionId: string;
  nodeId: string;
  reason: string;
  expectedRevision?: number;
  actor?: Actor;
};

/** 객체 입력 (M4.2-2.5-5) */
export type PfApproveInput = {
  sessionId: string;
  nodeId: string;
  approved: boolean;
  note?: string;
  expectedRevision?: number;
  actor?: Actor;
};
