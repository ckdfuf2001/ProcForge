import { createHash } from "node:crypto";

// 결정적 해시 헬퍼 (R7 before/afterHash 결합용).

export function sha256hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** 변경 노드 해시들을 정렬해 다시 해시 (R7 beforeHash/afterHash) */
export function combineHashes(hashes: string[]): string {
  return sha256hex([...hashes].sort().join("\n"));
}
