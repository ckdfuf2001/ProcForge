import type { TOOL_NAMES } from "../server.js";

// 도구 ↔ App 메서드 1:1 매핑 (M4.2-4-3). server 디스패치와 매핑 테스트의 단일 원천.
// CLI 전용 (repair/traceMarkdown/exportSession)은 MCP 도구가 아니므로 제외.

export type ToolName = (typeof TOOL_NAMES)[number];

export const APP_METHODS = {
  pf_start: "start",
  pf_next: "next",
  pf_report: "report",
  pf_split: "split",
  pf_confirm_leaf: "confirmLeaf",
  pf_retry: "retry",
  pf_ask_human: "askHuman",
  pf_approve: "approve",
  pf_advise: "advise",
  pf_tree: "tree",
  pf_get_node: "getNode",
  pf_lock: "lock",
  pf_reopen: "reopen",
  pf_edit_args: "editArgs",
  pf_edit_node: "editNode",
  pf_refresh_catalog: "refreshCatalog",
  pf_test: "test",
  pf_finalize: "finalize",
} as const satisfies Record<string, string>;
