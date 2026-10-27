import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// M7-1: OpenCode 세션 ↔ ProcForge 세션 짝짓기 (latest-wins + 이력).
// UI가 "이 조언을 어느 대화로 보낼지" 알기 위한 대응표.

/** M8-1-pair: 짝의 출처. 없으면 신호 전달 뒤 관찰(기존) 또는 수동 기록. */
export type PairingSource = "discovered";

export type Pairing = {
  openCodeSessionId: string;
  pfSessionId: string;
  at: string;
  source?: PairingSource;
};

export type Pairings = {
  pairs: Record<string, Pairing>;
  history: Pairing[];
};

const HISTORY_CAP = 100;

export function pairingsFile(procforgeDir: string): string {
  return join(procforgeDir, "pairings.json");
}

export function loadPairings(procforgeDir: string): Pairings {
  try {
    if (!existsSync(pairingsFile(procforgeDir)))
      return { pairs: {}, history: [] };
    const raw = JSON.parse(
      readFileSync(pairingsFile(procforgeDir), "utf8"),
    ) as Partial<Pairings>;
    return {
      pairs:
        raw.pairs && typeof raw.pairs === "object"
          ? (raw.pairs as Pairings["pairs"])
          : {},
      history: Array.isArray(raw.history) ? raw.history : [],
    };
  } catch {
    return { pairs: {}, history: [] };
  }
}

/** latest-wins 갱신 + 이력 보존 */
export function savePairing(
  procforgeDir: string,
  openCodeSessionId: string,
  pfSessionId: string,
  source?: PairingSource,
): Pairings {
  const cur = loadPairings(procforgeDir);
  const entry: Pairing = {
    openCodeSessionId,
    pfSessionId,
    at: new Date().toISOString(),
    ...(source !== undefined ? { source } : {}),
  };
  const pairs = { ...cur.pairs, [openCodeSessionId]: entry };
  const history = [...cur.history, entry].slice(-HISTORY_CAP);
  const next: Pairings = { pairs, history };
  mkdirSync(dirname(pairingsFile(procforgeDir)), { recursive: true });
  writeFileSync(pairingsFile(procforgeDir), JSON.stringify(next, null, 2));
  return next;
}

export function getPairing(
  procforgeDir: string,
  openCodeSessionId: string,
): Pairing | undefined {
  return loadPairings(procforgeDir).pairs[openCodeSessionId];
}
