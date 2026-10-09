import type { Constraint, Node, Session, ArgSpec, SideEffect } from "./schema.js";

// local → core 호출은 반드시 이 인터페이스를 통해서만 한다. (가이드 §3, §8)
// M0~M5: packages/core가 이 인터페이스의 in-process 구현을 제공한다.
// M6: HTTP CoreClient 구현으로 교체한다. local 소스에서 core 직접 import 금지.

export type PfStartInput = {
  request: string;
  params?: Record<string, string>;
  toolCatalog: Session["toolCatalog"];
  limits?: Session["limits"];
};

export type PfStartOutput = {
  session: Session;
  node: Node;
  instruction: string;
};

export type PfNextOutput =
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
};

export type PfReportOutput = {
  verdict: "pass" | "fail" | "unverifiable";
  failedConstraints: string[];
  unverified?: string[];
  instruction: string;
};

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
};

export type PfResolveOutput = {
  node: Node;
  created?: Node[];
  instruction: string;
};

export type PfAdviseOutput = {
  constraints: Constraint[];
  rejected: { proposal: unknown; reason: string }[];
  node: Node;
  /** 추가 안내 (M4 numeric 제안 유도 등) */
  note?: string;
};

export type PfAdviseInput = {
  sessionId: string;
  nodeId: string;
  text: string;
  opts?: {
    /** 호스트 제안 조건 (M4). core가 최신 fixture로 평가해 채택/거부 */
    proposedConstraints?: unknown[];
    /** 최신 fixture 내용 (local이 읽어 전달, M4) */
    fixtureContents?: Record<string, string>;
  };
};

// local checker → core 주입 계약. core·local 모두 shared 타입만 사용.
export type EvaluateFn = (
  constraints: Constraint[],
  ctx: { resultSummary?: string; resultJson?: unknown; artifacts?: Record<string, string>; fileExists?: (p: string) => boolean },
) => { verdict: "pass" | "fail"; failedConstraints: string[]; unverified?: string[] };

export interface CoreClient {
  pfStart(input: PfStartInput): Promise<PfStartOutput>;
  pfNext(sessionId: string): Promise<PfNextOutput>;
  pfReport(input: PfReportInput): Promise<PfReportOutput>;
  pfResolve(input: PfResolveInput): Promise<PfResolveOutput>;
  pfAdvise(sessionId: string, nodeId: string, text: string, opts?: PfAdviseInput["opts"]): Promise<PfAdviseOutput>;
  pfTree(sessionId: string): Promise<{ nodes: Node[]; session: Session }>;
  pfLock(sessionId: string, nodeId: string): Promise<Node>;
  pfReopen(sessionId: string, nodeId: string, reason: string): Promise<Node>;
  /** external dry-run 계획 승인/거부 (M2.6-4) */
  pfApprove(sessionId: string, nodeId: string, approved: boolean, note?: string): Promise<Node>;
}
