import { existsSync } from "node:fs";
import { join } from "node:path";
import { pfError } from "@procforge/shared/errors.js";
import { FileStore } from "../filestore.js";

// 손상 rev 해제 (M4.2-4-0-1, CLI repair → App 경유). MCP 도구 없음.

export function repairDiscard(
  procforgeDir: string,
  sessionId: string,
  rev: number,
): { removed: string[] } {
  if (!existsSync(join(procforgeDir, "sessions", sessionId))) {
    throw pfError("not_found", `session ${sessionId} not found`);
  }
  return new FileStore(procforgeDir).repairDiscard(sessionId, rev);
}
