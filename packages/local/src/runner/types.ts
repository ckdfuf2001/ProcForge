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
  /** 무인 실행 (M5.5-4. external은 approvals 일치 시에만 실행, 불일치 시 fail ["approval"]) */
  unattended?: boolean;
  /** 도구 호출 재시도 (M5.6-f. readOnly + sideEffect none만, 지수 백오프). */
  toolRetry?: { attempts?: number; baseMs?: number; extraTransient?: string[] };
  /** 사전 승인 목록 (M5.5-4. runSession이 procedures/<name>/approvals.json에서 로드) */
  approvals?: import("../services/approvals.js").ApprovalEntry[];
  /** 절차서 이름 (M5 run state 기록용) */
  procedure?: string;
  /** 절차서 디렉터리 (M5.5-3 state.json 위치. 미지정 시 procedures/<name>) */
  procedureDir?: string;
  /** 실행 간 상태 (M5.5-3. runSession이 로드, resolveArgs에 전달) */
  state?: Record<string, unknown>;
};

export type NodeResultStatus = "pass" | "fail" | "unverified" | "skipped" | "blocked" | "suspended";

export type NodeResult = {
  nodeId: string;
  status: NodeResultStatus;
  failedConstraints: string[];
  unverified?: string[];
  detail?: string;
  /** map 항목 실패 인덱스 (M5.5-1) */
  failedItems?: number[];
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
