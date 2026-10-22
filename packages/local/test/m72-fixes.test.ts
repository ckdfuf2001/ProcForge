import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CoreService, createMemoryStore } from "@procforge/core";
import { FileStore } from "../src/filestore.js";
import { testStack } from "./client-mode.js";
import { ProcForgeApp } from "../src/app/app.js";

// M7-ui2 보정 a~f: split stale·읽기 무쓰기·폴러 오류·revision 정합·시작점·dist 강제.

const catalog = [
  { server: "t", name: "read", inputSchema: { type: "object" }, schemaHash: "h" },
];

let pfdir: string;
beforeEach(() => {
  pfdir = join(mkdtempSync(join(tmpdir(), "pf-ui2b-")), ".procforge");
});

async function splitSession(dep?: { nodeId: string; dependsOn: string[] }) {
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: pfdir });
  const s = await app.start({ request: "r", toolCatalog: catalog as never });
  // 1 → 1.1, 1.2 (split)
  await app.split({
    sessionId: s.sessionId,
    nodeId: "1",
    reason: "M8 테스트용 분해 사유입니다.",
    children: [{ goal: "a" }, { goal: "b" }],
    expectedRevision: 0,
  });
  if (dep) {
    await app.editNode({
      sessionId: s.sessionId,
      nodeId: dep.nodeId,
      dependsOn: dep.dependsOn,
      expectedRevision: (await app.readSession(s.sessionId)).revision,
    });
  }
  return { app, sid: s.sessionId };
}

const rev = async (app: ProcForgeApp, sid: string): Promise<number> =>
  (await app.readSession(sid)).revision;
const nodeOf = async (app: ProcForgeApp, sid: string, nid: string) =>
  app.readNode(sid, nid);

describe("M7-ui2-a split stale 표시", () => {
  it("1.2 편집 → 하류 1.1 stale, split(1)은 미기록 → 재실행 후 전부 해제", async () => {
    const { app, sid } = await splitSession({ nodeId: "1.1", dependsOn: ["1.2"] });
    await app.editNode({
      sessionId: sid,
      nodeId: "1.2",
      goal: "b 고침",
      expectedRevision: (await app.readSession(sid)).revision,
    });
    // 하류 1.1은 stale 표시가 켜진다.
    const n11 = await app.readNode(sid, "1.1");
    expect(n11.staleSince).toBeDefined();
    expect(n11.staleSince?.causeNodeId).toBe("1.2");
    // split(1)은 표시가 없다 (M7-ui2-a: split엔 미기록).
    expect((await app.readNode(sid, "1")).staleSince).toBeUndefined();
    // 하류를 다시 확정(leaf) → 표시 해제.
    for (const nid of ["1.1", "1.2"]) {
      await app.report({
        sessionId: sid,
        nodeId: nid,
        tool: { server: "t", name: "read" },
        args: {},
        resultSummary: "ok",
        selfVerdict: "pass",
        selfReason: "ok",
      });
    }
    expect((await app.readNode(sid, "1.1")).staleSince).toBeUndefined();
    expect((await app.readNode(sid, "1.2")).staleSince).toBeUndefined();
    expect((await app.readNode(sid, "1")).staleSince).toBeUndefined();
  }, 30000);
});

describe("M7-ui2-b 읽기 무쓰기", () => {
  it("UI 폴링 10회 후 세션 파일 불변", async () => {
    const { app, sid } = await splitSession();
    const file = join(pfdir, "sessions", sid, "session.json");
    const nodeFile = join(pfdir, "sessions", sid, "nodes", "1.1.json");
    if (!existsSync(file)) {
      // remote 모드: 서버 저장소를 봐야 한다. 이 테스트는 inprocess에서만 의미 있다.
      return;
    }
    const before = {
      s: readFileSync(file, "utf8"),
      sm: statSync(file).mtimeMs,
      n: existsSync(nodeFile) ? readFileSync(nodeFile, "utf8") : "",
      nm: existsSync(nodeFile) ? statSync(nodeFile).mtimeMs : 0,
    };
    for (let i = 0; i < 10; i++) {
      await app.getEventsPage({ sessionId: sid, afterRevision: 0 });
      await app.getBlocked({ sessionId: sid });
      await app.listSessions();
      await app.sessionTree({ sessionId: sid });
      await app.readNode(sid, "1.1");
    }
    expect(readFileSync(file, "utf8")).toBe(before.s);
    expect(statSync(file).mtimeMs).toBe(before.sm);
    if (before.n) {
      expect(readFileSync(nodeFile, "utf8")).toBe(before.n);
      expect(statSync(nodeFile).mtimeMs).toBe(before.nm);
    }
  }, 30000);
});

describe("M7-ui2-d staleSince.revision = 이벤트 revision", () => {
it("표시 revision이 그 변경 이벤트의 revision과 일치", async () => {
    const { app, sid } = await splitSession({ nodeId: "1.1", dependsOn: ["1.2"] });
    const rev0 = (await app.readSession(sid)).revision;
    await app.editNode({
      sessionId: sid,
      nodeId: "1.2",
      goal: "b 고침2",
      expectedRevision: rev0,
    });
    const evs = await app.getEventsPage({ sessionId: sid, afterRevision: rev0 });
    const nodeEvent = evs.events.find((e) => e.nodeIds.includes("1.2"));
    expect(nodeEvent).toBeDefined();
    expect((await app.readNode(sid, "1.1")).staleSince?.revision).toBe(
      nodeEvent!.revision,
    );
  }, 30000);
});

describe("M7-ui2-c 폴러 오류", () => {
  it("session_not_found → error 이벤트 후 종료 (MemoryStore 직접)", async () => {
    const svc = new CoreService(createMemoryStore());
    const { SessionEventHub } = await import("../src/app/events-hub.js");
    let thrown = false;
    const hub = new SessionEventHub({
      fetchEvents: async () => {
        throw Object.assign(new Error("세션 없음: x"), {
          code: "session_not_found",
        });
      },
      pollMs: 20,
      heartbeatMs: 100000,
    });
    let out = "";
    let closed = false;
    hub.subscribe("s", 0, (c) => {
      out += c;
    }, () => {
      closed = true;
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(out).toContain("event: error");
    expect(closed).toBe(true);
    expect(hub.count("s")).toBe(0);
    hub.stopAll();
    expect(thrown).toBe(false);
    expect(typeof svc.getEventsPage).toBe("function");
  });
});

describe("M7-ui2-f XSS 테스트 대상", () => {
  it("실제 packages/ui/dist 가 있으면 그 산출물을 검증", () => {
    const real = join(import.meta.dirname ?? ".", "..", "..", "ui", "dist", "index.html");
    const exists = existsSync(real);
    if (!exists && process.env.CI) {
      throw new Error("packages/ui/dist 없음. CI에서는 pnpm -r build 후 테스트할 것");
    }
    if (exists) {
      const html = readFileSync(real, "utf8");
      // 인라인 스크립트 0 (CSP script-src 'self' 통과 조건).
      expect(/<script(?![^>]*\bsrc=)/i.test(html)).toBe(false);
      expect(html).not.toContain("dangerouslySetInnerHTML");
    }
    expect(exists || !process.env.CI).toBe(true);
  });
});
