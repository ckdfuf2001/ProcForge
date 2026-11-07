import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProcForgeApp } from "../src/app/app.js";
import { FileStore } from "../src/filestore.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

useTmpCleanup();

// M10-4-fix(판정2): drive 시작 실패는 run failed + 사유 원문으로 기록된다.

const CAT = [
  { server: "t", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;

let root: string;
let pfdir: string;
let app: ProcForgeApp;

beforeEach(() => {
  root = makeTmp("pf-m104df-");
  pfdir = join(root, ".procforge");
  const { client } = testStack(pfdir);
  app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
});

describe("M10-drive-fail", () => {
  it("세션 락 선점 상태에서 drive 시작 → 10초 안에 failed + 사유 원문", async () => {
    const dir = join(pfdir, "procedures", "g-d");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "procedure.json"),
      JSON.stringify({
        format: "procforge-procedure",
        version: 1,
        name: "g-d",
        sourceSession: "11111111-1111-4111-8111-111111111111",
        createdAt: new Date(0).toISOString(),
        params: {},
        toolCatalog: CAT,
        tree: { rootId: "1", nodes: [] },
        nodes: [],
      }),
    );
    const started = await app.runStart({ procedure: "g-d", params: {} });
    // 세션 락을 미리 잡는다 — drive의 단일 시도 acquireLock이 실패한다.
    const release = new FileStore(pfdir).acquireLock(started.sessionId);
    try {
      (
        app as unknown as {
          launchDrive: (runId: string, docName: string) => void;
        }
      ).launchDrive(started.runId, "g-d");
      let status = "";
      let failedDetail: string | undefined;
      for (let i = 0; i < 50; i++) {
        const info = await app.uiRunInfo({ runId: started.runId });
        status = info.status;
        failedDetail = info.failedDetail;
        if (status === "failed") break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(status).toBe("failed");
      expect(failedDetail ?? "").toMatch(/session locked/);
    } finally {
      release();
    }
  }, 30000);
});
