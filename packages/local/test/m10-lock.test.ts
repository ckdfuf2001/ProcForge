import { describe, it, expect, beforeEach } from "vitest";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProcForgeApp } from "../src/app/app.js";
import { FileStore } from "../src/filestore.js";
import {
  procRunLockPath,
  acquireProcRunLock,
} from "../src/services/run-lock.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

useTmpCleanup();

// M10-lock: swap 직전 run 잠금 획득 시도는 conflict, 끝난 뒤 파일 정위치.

const CAT = [
  { server: "t", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;
const TOOL = { server: "t", name: "echo" } as never;

let root: string;
let pfdir: string;

beforeEach(() => {
  root = makeTmp("pf-m10lock-");
  pfdir = join(root, ".procforge");
});

describe("M10-lock", () => {
  it("swap 중 run 잠금은 conflict, 끝난 뒤 procedure.json·state.json 정위치", async () => {
    const { client } = testStack(pfdir);
    let hookCalls = 0;
    let hookResult = "";
    const app = new ProcForgeApp({
      core: client,
      procforgeDir: pfdir,
      projectRoot: root,
      onBeforeProcedureSwap: (name: string) => {
        hookCalls += 1;
        try {
          const release = acquireProcRunLock(
            new FileStore(pfdir),
            pfdir,
            name,
            "probe",
            60000,
          );
          release();
          hookResult = "acquired (BUG: 잠금 없음)";
        } catch (e) {
          hookResult = `conflict:${(e as { code?: string }).code ?? "?"}`;
        }
      },
    });
    const s = await app.start({ request: "잠금 테스트", toolCatalog: CAT });
    const sid = s.sessionId;
    await app.split({
      sessionId: sid,
      nodeId: "1",
      reason: "M10-lock 테스트용 분해 사유입니다.",
      children: [{ goal: "x" }],
      expectedRevision: 0,
    } as never);
    await app.report({
      sessionId: sid, nodeId: "1.1", tool: TOOL,
      args: { note: "hi" }, resultSummary: "ok", resultJson: { note: "hi" },
      selfVerdict: "pass", selfReason: "ok",
    });
    await app.confirmLeaf({
      sessionId: sid, nodeId: "1.1", tool: TOOL,
      argSpecs: { note: { kind: "fixed", value: "hi" } } as never,
    });
    // swap 전부터 있던 sidecar (보존 대상).
    const procDir = join(pfdir, "procedures", "lockp");
    mkdirSync(procDir, { recursive: true });
    writeFileSync(join(procDir, "state.json"), JSON.stringify({ lastId: "a1" }));
    const out = await app.finalize({ sessionId: sid, name: "lockp" });
    expect(out.name).toBe("lockp");
    expect(hookCalls).toBe(1);
    expect(hookResult).toBe("conflict:conflict");
    // 끝난 뒤 정위치: 새 procedure.json + 보존된 state.json.
    const doc = JSON.parse(
      readFileSync(join(procDir, "procedure.json"), "utf8"),
    ) as { name: string };
    expect(doc.name).toBe("lockp");
    expect(readFileSync(join(procDir, "state.json"), "utf8")).toBe(
      JSON.stringify({ lastId: "a1" }),
    );
    // 잠금 잔재 없음 (새 위치·구 위치 모두).
    expect(existsSync(procRunLockPath(pfdir, "lockp"))).toBe(false);
    expect(existsSync(join(procDir, ".run.lock"))).toBe(false);
  }, 60000);
});
