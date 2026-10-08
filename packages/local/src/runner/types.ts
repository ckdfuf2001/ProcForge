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
};

export type NodeResultStatus = "pass" | "fail" | "unverified" | "skipped" | "blocked";

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
  summary: { pass: number; fail: number; unverified: number; skipped: number; blocked: number };
  nodeHashes: Record<string, string>;
};

export type ToolResponse = {
  resultText: string;
  resultJson?: unknown;
};
