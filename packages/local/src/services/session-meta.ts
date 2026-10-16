import { FileStore } from "../filestore.js";
import { loadPairings } from "./pairings.js";
import { readEvents } from "../trace.js";
import type { SessionSummary as CoreSummary } from "@procforge/shared/schema.js";

// M7-ui1: 로컬 부가정보 합성 (pairings·connectionIds·lastUsedAt).
// 세션 원천은 core.getSessions (원격 모드에서 서버 저장소). App은 합성만.

export type SessionRow = CoreSummary & {
  lastUsedAt: number | null;
  connectionIds: string[];
  pairings: { openCodeSessionId: string; at: string }[];
};

export function enrichSessions(
  procforgeDir: string,
  rows: CoreSummary[],
): SessionRow[] {
  const store = new FileStore(procforgeDir);
  const pairs = loadPairings(procforgeDir);
  return rows.map((s) => {
    const seen = new Set<string>();
    try {
      for (const e of readEvents(procforgeDir, s.sessionId)) {
        if (typeof e.connectionId === "string" && e.connectionId !== "") {
          seen.add(e.connectionId);
        }
      }
    } catch {
      // 추적 읽기 실패는 목록에 영향 없음
    }
    return {
      ...s,
      lastUsedAt: store.getLastUsed(s.sessionId) ?? null,
      connectionIds: [...seen].sort(),
      pairings: Object.values(pairs.pairs)
        .filter((p) => p.pfSessionId === s.sessionId)
        .map((p) => ({ openCodeSessionId: p.openCodeSessionId, at: p.at })),
    };
  });
}
