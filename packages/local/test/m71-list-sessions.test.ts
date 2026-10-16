import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { testStack, clientMode } from "./client-mode.js";
import { ProcForgeApp } from "../src/app/app.js";
import { savePairing } from "../src/services/pairings.js";

// M7-ui1: core.getSessions (테넌트 저장소 기준) + App 합성 (로컬 부가).
// inprocess/loopback/remote 전 모드에서 동일 파일이 돈다 (CI remote 잡 포함).

let pfdir: string;
beforeEach(() => {
  pfdir = join(mkdtempSync(join(tmpdir(), "pf-m71ls-")), ".procforge");
});

describe("M7-ui1 listSessions", () => {
  it("core 요약 + 로컬 부가 (원격이면 서버 저장소 기준)", async () => {
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({
      core: client,
      procforgeDir: pfdir,
      projectRoot: pfdir,
    });
    const started = await app.start({ request: "list-me", toolCatalog: [] });
    savePairing(pfdir, "oc-x", started.sessionId);
    const { sessions } = await app.listSessions();
    const me = sessions.find((s) => s.sessionId === started.sessionId);
    expect(me).toBeDefined();
    expect(me?.request).toBe("list-me");
    expect(me?.revision).toBe(0);
    expect(me?.nodeCount).toBeGreaterThan(0);
    expect(me?.rootStatus).toBe("open");
    expect(me?.pairings.map((p) => p.openCodeSessionId)).toEqual(["oc-x"]);
    if (clientMode() === "remote") {
      // 서버 저장소에만 있고 로컬 폴더엔 없음 — 직접 읽기였으면 빈 목록.
      expect(existsSync(join(pfdir, "sessions", started.sessionId))).toBe(false);
    }
  });

  it("빈 목록", async () => {
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({
      core: client,
      procforgeDir: pfdir,
      projectRoot: pfdir,
    });
    // remote는 서버 저장소를 공유하므로 남의 세션이 있을 수 있다.
    // inprocess/loopback이면 비어 있다.
    const { sessions } = await app.listSessions();
    if (clientMode() !== "remote") expect(sessions).toEqual([]);
    else expect(Array.isArray(sessions)).toBe(true);
  });
});
