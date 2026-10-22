import type {
  Constraint,
  Node,
  Session,
  SessionSummary,
  ArgSpec,
  SideEffect,
} from "./schema.js";

/** R8 메타 (M6.1-1. 원격 사전평가 경로. resultJson과 병행 금지) */
export type ResultJsonMeta = { sha256: string; size: number; preview: string };

/** 로컬 사전 판정 (M6.1-1. LocalServices 계산, core는 저장·규칙 적용) */
export type LocalEvaluation = {
  verdict: "pass" | "fail";
  failedConstraints: string[];
  unverified?: string[];
};
import type {
  Actor,
  DecompositionHistoryEntry,
  DecompositionHistoryInput,
  EventEntry,
  TreeAtInput,
  TreeAtOutput,
} from "./dto.js";
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
  | {
      done: false;
      node: Node;
      blocked?: BlockedEntry[];
      instruction: string;
      enteredProbing: boolean;
      revision: number;
      changedNodeIds: string[];
    }
  | { done: true; revision: number; changedNodeIds: string[] };

/** pfNext 본문 반환형 (메타 제외 유니온) */
export type PfNextPayload =
  | {
      done: false;
      node: Node;
      blocked?: BlockedEntry[];
      instruction: string;
      enteredProbing: boolean;
    }
  | { done: true };

export type BlockedReason =
  "dep_failed" | "dep_empty_split" | "dep_missing" | "dep_pending";

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
  /** R8 메타 (M6.1-1. 원격 사전평가 경로. resultJson과 병행 금지) */
  resultJsonMeta?: ResultJsonMeta;
  /** 로컬 사전 판정 (M6.1-1. LocalServices 계산, core는 저장·규칙 적용) */
  localEvaluation?: LocalEvaluation;
  /** 로컬 생성 auto 제약 (localEvaluation과 함께 전송, core 저장용) */
  autoConstraints?: Constraint[];
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
  /** fixture → sandbox 논리 경로 매핑 (M3.5.1-1, auto file_exists 경로용) */
  artifactSources?: Record<string, string>;
  /** 녹화 응답에서 확인된 resultJson 키 (M3.5.1-3, auto json 생성 범위) */
  verifiedJsonKeys?: string[];
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
  /** M8-ui1: 분해 사유 (사용자·MCP 경로는 필수, import/fixture는 면제) */
  reason?: string;
  /** M8-ui1: 버린 대안 */
  alternatives?: string[];
  argSpecs?: Record<string, ArgSpec>;
  sideEffect?: SideEffect;
  tool?: { server: string; name: string };
  /** ask_human용 dry-run 계획 (M2.6-4). attempt로 저장되고 실행되지 않음 */
  plan?: {
    tool: { server: string; name: string };
    args: Record<string, unknown>;
  };
  /** retry/ask_human 사유 기록용 (M2.6-4) */
  note?: string;
  /** leaf 확정 시 golden.ignore로 기록할 JSON 경로 (M3.1-2) */
  goldenIgnore?: string[];
  /** leaf 확정 시 attempt 결과물로 확정할 목록 (M4.2-2.5-4, 생략 시 마지막 attempt 유지) */
  artifacts?: string[];
  /** runner 실행 가능 도구 집합 ("server/name", M5.8.1-1). 있으면 core가 소속 판정 */
  runnableTools?: string[];
  /** probing 대조 판정 (M5.8.2 후속. LocalServices 계산, core는 규칙 적용) */
  refCheck?: {
    key: string;
    verdict: "match" | "mismatch" | "unverifiable";
    probing?: string;
    resolved?: string;
  }[];
  /** 엄격 모드 (M5.8.2 후속: unverifiable이면 거부) */
  strict?: boolean;
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

/** 절차서 import (M6.1-2. CLI·테스트용. 세션 직접 저장의 core 경로) */
export type PfImportProcedureInput = {
  doc: unknown;
  params?: Record<string, string>;
};

export type PfImportProcedureOutput = {
  sessionId: string;
};

/** golden 쓰기 (M6.1-2. 원격 record 경로. output만 갱신, fixtures는 pf_report 소유) */
export type PfWriteGoldenInput = {
  sessionId: string;
  nodeId: string;
  golden: {
    fixtures: string[];
    output: string;
    attemptId?: string;
    ignore?: string[];
  };
  expectedRevision?: number;
  actor?: Actor;
};

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
  /** map 실행 명세 (M5.5-1) */
  map?: unknown;
  /** until 실행 명세 (M5.5-2) */
  until?: unknown;
  /** 실행 간 상태 기록 선언 (M5.5-3) */
  stateWrites?: unknown;
  /** script 재시도 선언 (M5.7-3, 멱등 opt-in) */
  retry?: { attempts: number };
  /** 선행 의존 사후 편집 (M5.8.1-4, 기존 노드만·순환 거부) */
  dependsOn?: string[];
  expectedRevision?: number;
  actor?: Actor;
};

/**
 * M7-ui4: 편집 미리보기 입력 (읽기 전용).
 * change는 pfEditArgs의 patch 또는 pfEditNode의 필드 중 하나.
 * 최대 길이는 core 검증과 동일(goal·텍스트 4KB).
 */
export type PreviewEditInput = {
  sessionId: string;
  nodeId: string;
  change: {
    patch?: PfEditArgsPatch;
    goal?: string;
    dependsOn?: string[];
    addConstraints?: Constraint[];
    removeConstraintIds?: string[];
  };
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
  ctx: {
    resultSummary?: string;
    resultJson?: unknown;
    artifacts?: Record<string, string>;
    fileExists?: (p: string) => boolean;
  },
) => {
  verdict: "pass" | "fail";
  failedConstraints: string[];
  unverified?: string[];
};

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
  amendAttemptArtifacts(
    input: AmendAttemptArtifactsInput,
  ): Promise<{ node: Node } & ChangeMeta>;
  /** 카탈로그 저장 (M4.2-2, 수집은 local). 세션 toolCatalog 교체 */
  pfUpdateCatalog(input: {
    sessionId: string;
    entries: unknown[];
    expectedRevision?: number;
    actor?: Actor;
  }): Promise<ChangeMeta>;
  /** 확정 인자 수정 (M4.2-2) */
  pfEditArgs(
    input: PfEditArgsInput,
  ): Promise<{ node: Node; instruction: string } & ChangeMeta>;
  /** 목표·검사 조건 직접 수정 (M4.2-2) */
  pfEditNode(
    input: PfEditNodeInput,
  ): Promise<{ node: Node; instruction: string } & ChangeMeta>;
  /** 상태 이벤트 조회 (M4.2-2, R7 히스토리 원천) */
  getEvents(sessionId: string, sinceSeq?: number): Promise<EventEntry[]>;
  /** M8-ui2: 분해 라운드 목록 (읽기 전용, touch 없음) */
  getDecompositionHistory(
    input: DecompositionHistoryInput,
  ): Promise<DecompositionHistoryEntry[]>;
  /** M8-ui2: 특정 revision 시점 트리 (읽기 전용, touch 없음) */
  getTreeAt(input: TreeAtInput): Promise<TreeAtOutput>;
  /** 세션 조회 (M4.2-2.5, TTL 판정 포함) */
  getSession(sessionId: string): Promise<Session>;
  /** 노드 조회 (M4.2-2.5) */
  getNode(sessionId: string, nodeId: string): Promise<Node>;
  /** 세션 목록 (M7-ui1. 테넌트 저장소 기준. 판단 없음) */
  getSessions(): Promise<{ sessions: SessionSummary[] }>;
  /** 이벤트 페이지 (M7-ui2. afterRevision 뒤 limit개 + 마지막 revision) */
  getEventsPage(input: {
    sessionId: string;
    afterRevision?: number;
    limit?: number;
    /** M7-ui3: 노드 이력 (서버측 필터) */
    nodeId?: string;
  }): Promise<{ events: EventEntry[]; lastRevision: number }>;
/** blocked·needs_human 목록 (M7-ui2. pfNext와 같은 계산, 읽기 전용) */
  getBlocked(input: { sessionId: string }): Promise<{
    blocked: BlockedEntry[];
    needsHuman: string[];
    revision: number;
  }>;
  /**
   * M7-ui4: 편집 미리보기 (읽기 전용·커밋 없음).
   * propagateStale을 dry-run으로 재사용해 "이 변경으로 stale이 될 노드"를
   * 알려준다. 저장소를 건드리지 않는다.
   */
  previewEdit(input: PreviewEditInput): Promise<{
    wouldStale: string[];
    newHash: string;
    revision: number;
  }>;
  /** 절차서 문서 조립 (M4.2-1, 검증·params 경고 포함. 파일 쓰기는 local) */
  pfBuildProcedure(
    sessionId: string,
    name: string,
  ): Promise<{ doc: ProcedureDoc; warnings: string[] }>;
  /** external dry-run 계획 승인/거부 (M2.6-4) */
  pfApprove(input: PfApproveInput): Promise<{ node: Node } & ChangeMeta>;
  /** 절차서 import (M6.1-2) */
  pfImportProcedure(
    input: PfImportProcedureInput,
  ): Promise<PfImportProcedureOutput>;
  /** golden 쓰기 (M6.1-2) */
  pfWriteGolden(
    input: PfWriteGoldenInput,
  ): Promise<{ node: Node } & ChangeMeta>;
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
