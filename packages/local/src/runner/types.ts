export type RunMode = "record" | "replay" | "passthrough" | "live";

export type RunOptions = {
  procforgeDir: string;
  projectRoot: string;
  sessionId: string;
  /** 서브트리 루트 (미지정 시 전체) */
  nodeId?: string;
  mode?: RunMode;
  /** golden/cassette 갱신 허용 */
  updateGolden?: boolean;
  /** bash 내장 실행 허용 (기본 false) */
  allowBash?: boolean;
  /** projectRoot 읽기 폴백 허용 (기본 false, M3.2-4) */
  allowProjectRead?: boolean;
  /** hash 변경 노드+하류만 실행 */
  changed?: boolean;
  runId?: string;
  /** 재실행 제외 (M5 run 스텝, golden 출력으로 의존 공급) */
  skipNodeIds?: string[];
  /** generated 인자 공급값 (M5, nodeId → 키→값) */
  supplied?: Record<string, Record<string, unknown>>;
  /** 승인된 external 노드 (M5) */
  approvedNodeIds?: string[];
  /** 절차서 이름 (M5 run state 기록용) */
  procedure?: string;
};

export type NodeResultStatus = "pass" | "fail" | "unverified" | "skipped" | "blocked" | "suspended";

export type NodeResult = {
  nodeId: string;
  status: NodeResultStatus;
  failedConstraints: string[];
  unverified?: string[];
  detail?: string;
  durationMs: number;
};

export type RunReport = {
  runId: string;
  sessionId: string;
  mode: RunMode;
  at: string;
  results: NodeResult[];
  summary: { pass: number; fail: number; unverified: number; skipped: number; blocked: number; suspended: number };
  nodeHashes: Record<string, string>;
};

export type ToolResponse = {
  resultText: string;
  resultJson?: unknown;
};
