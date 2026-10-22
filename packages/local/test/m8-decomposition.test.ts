import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";

// M8-ui2: 사용자 경로 계약.
// - pf_split은 사유(reason)를 요구한다 (없으면 bad_request + 힌트).
// - 읽기 API(getDecompositionHistory·getTreeAt)는 모든 client 모드에서 같다.
//
// 이 테스트는 PROCFORGE_CLIENT로 inprocess/loopback/remote 3모드 모두에서 돈다.

const catalog = [
  { server: "t", name: "read", inputSchema: { type: "object" }, schemaHash: "h" },
];
const REASON = "한 번에 처리하기 어려워 두 단계로 나눈다.";

let pfdir: string;
beforeEach(() => {
  pfdir = join(mkdtempSync(join(tmpdir(), "pf-m8-")), ".procforge");
});

async function started() {
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: pfdir });
  const s = await app.start({ request: "M8 분해 이력", toolCatalog: catalog as never });
  return { app, sid: s.sessionId };
}

describe("M8-ui2 pf_split 사유 요구", () => {
  it("reason이 없으면 bad_request + 힌트", async () => {
    const { app, sid } = await started();
    try {
      await app.split({
        sessionId: sid,
        nodeId: "1",
        children: [{ goal: "a" }],
      } as never);
      expect.unreachable();
    } catch (e) {
      expect((e as { code?: string }).code).toBe("bad_request");
      expect((e as { hint?: string }).hint).toMatch(/10자/);
    }
  });

  it("공백만인 reason도 거부된다", async () => {
    const { app, sid } = await started();
    await expect(
      app.split({
        sessionId: sid,
        nodeId: "1",
        reason: "        ",
        children: [{ goal: "a" }],
      } as never),
    ).rejects.toThrow(/reason/);
  });

  it("reason이 있으면 분해되고 사유가 남는다", async () => {
    const { app, sid } = await started();
    await app.split({
      sessionId: sid,
      nodeId: "1",
      reason: REASON,
      alternatives: ["전부 한 번에 처리하기"],
      children: [{ goal: "a" }],
    } as never);
    const history = await app.getDecompositionHistory({ sessionId: sid });
    expect(history.length).toBe(1);
    expect(history[0].reason).toBe(REASON);
    expect(history[0].alternatives).toEqual(["전부 한 번에 처리하기"]);
  });
});

describe("M8-ui2 읽기 API (3 client 모드 공통)", () => {
  it("이력과 시점 트리가 같은 결과를 준다", async () => {
    const { app, sid } = await started();
    await app.split({
      sessionId: sid,
      nodeId: "1",
      reason: REASON,
      children: [{ goal: "a" }, { goal: "b" }],
    } as never);

    const history = await app.getDecompositionHistory({ sessionId: sid });
    expect(history.length).toBe(1);
    expect(history[0].parentId).toBe("1");
    expect(history[0].childIds).toEqual(["1.1", "1.2"]);
    expect(history[0].depth).toBe(0);

    const at0 = await app.getTreeAt({ sessionId: sid, revision: 0 });
    expect(at0.nodes.map((n) => n.id)).toEqual(["1"]);
    const at1 = await app.getTreeAt({ sessionId: sid, revision: 1 });
    expect(at1.nodes.map((n) => n.id)).toEqual(["1", "1.1", "1.2"]);
    expect(at1.structureOnly).toBe(false);
  });

  it("읽기 API는 세션 revision을 바꾸지 않는다", async () => {
    const { app, sid } = await started();
    await app.split({
      sessionId: sid,
      nodeId: "1",
      reason: REASON,
      children: [{ goal: "a" }],
    } as never);
    const before = (await app.readSession(sid)).revision;
    await app.getDecompositionHistory({ sessionId: sid });
    await app.getTreeAt({ sessionId: sid, revision: 1 });
    expect((await app.readSession(sid)).revision).toBe(before);
  });
});
