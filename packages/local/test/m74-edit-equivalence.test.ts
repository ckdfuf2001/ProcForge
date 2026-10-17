import { describe, it, expect } from "vitest";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";

// M7-ui4-f: **미리보기와 실제 저장이 같은 결과를 내는지**.
// previewEdit.wouldStale == 편집 저장 후 staleSince 가 박힌 노드.
// (검증 로직은 core의 순수 함수 applyEdit 하나를 공유한다 — packages/core/src/edit.ts)

const catalog = [
  { server: "t", name: "read", inputSchema: { type: "object" }, schemaHash: "h" },
];
const c = (id: string) => ({
  id,
  source: "human" as const,
  kind: "equals" as const,
  // R8: path 문자열은 core 경계를 넘을 수 없다 — 값만 있는 조건을 쓴다.
  spec: { rubric: `조건 ${id}` },
});

async function built(pfdir: string) {
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: pfdir });
  const s = await app.start({ request: "루트", toolCatalog: catalog as never });
  const sid = s.sessionId;
  const rev = async () => (await app.readSession(sid)).revision;
  await app.split({
    sessionId: sid,
    nodeId: "1",
    children: [{ goal: "a" }, { goal: "b" }],
    expectedRevision: await rev(),
  });
  await app.split({
    sessionId: sid,
    nodeId: "1.2",
    children: [{ goal: "c" }],
    expectedRevision: await rev(),
  });
  await app.split({
    sessionId: sid,
    nodeId: "1.1",
    children: [{ goal: "d" }],
    expectedRevision: await rev(),
  });
  await app.editNode({
    sessionId: sid,
    nodeId: "1.1.1",
    dependsOn: ["1.2.1"],
    expectedRevision: await rev(),
  });
  return { app, sid };
}

async function staleIds(app: ProcForgeApp, sid: string): Promise<string[]> {
  const { nodes } = await app.sessionTree({ sessionId: sid });
  return nodes.filter((n) => n.staleSince !== undefined).map((n) => n.id).sort();
}

describe("M7-ui4-f previewEdit ↔ 실제 편집 동치", () => {
  it("goal 편집: 미리보기 목록 = 저장 후 새 stale 목록", async () => {
    const pfdir = mk();
    const { app, sid } = await built(pfdir);
    const goal = "c 바뀐 목표";
    const pv = await app.previewEdit({ sessionId: sid, nodeId: "1.2.1", change: { goal } });
    const before = await staleIds(app, sid);
    await app.editNode({ sessionId: sid, nodeId: "1.2.1", goal, expectedRevision: (await app.readSession(sid)).revision });
    const newly = (await staleIds(app, sid)).filter((x) => !before.includes(x));
    expect(newly).toEqual([...pv.wouldStale].sort());
    expect(pv.wouldStale).toEqual(["1.1.1"]);
  });

  it("constraint 추가: 동치", async () => {
    const pfdir = mk();
    const { app, sid } = await built(pfdir);
    const pv = await app.previewEdit({
      sessionId: sid,
      nodeId: "1.2.1",
      change: { addConstraints: [c("c1")] },
    });
    const before = await staleIds(app, sid);
    await app.editNode({
      sessionId: sid,
      nodeId: "1.2.1",
      addConstraints: [c("c1")] as never,
      expectedRevision: (await app.readSession(sid)).revision,
    });
    const newly = (await staleIds(app, sid)).filter((x) => !before.includes(x));
    expect(newly).toEqual([...pv.wouldStale].sort());
  });

  it("중복 constraint: 미리보기도 실제도 같은 메시지로 거절", async () => {
    const pfdir = mk();
    const { app, sid } = await built(pfdir);
    await app.editNode({
      sessionId: sid,
      nodeId: "1.2.1",
      addConstraints: [c("dup")] as never,
      expectedRevision: (await app.readSession(sid)).revision,
    });
    // 핸들러를 **즉시** 붙인다 (두 번째 프로미스가 그 전에 reject되면 Node가
    // unhandled rejection으로 친다 — 테스트 오염).
    const pvExp = expect(
      app.previewEdit({ sessionId: sid, nodeId: "1.2.1", change: { addConstraints: [c("dup")] } }),
    ).rejects.toThrow(/duplicate constraint/);
    const realExp = expect(
      app.editNode({
        sessionId: sid,
        nodeId: "1.2.1",
        addConstraints: [c("dup")] as never,
        expectedRevision: (await app.readSession(sid)).revision,
      }),
    ).rejects.toThrow(/duplicate constraint/);
    await Promise.all([pvExp, realExp]);
  });

  it("split 노드 편집도 동치 (split 자체는 stale 표시 안 함)", async () => {
    const pfdir = mk();
    const { app, sid } = await built(pfdir);
    const goal = "b 다시";
    const pv = await app.previewEdit({ sessionId: sid, nodeId: "1.2", change: { goal } });
    await app.editNode({ sessionId: sid, nodeId: "1.2", goal, expectedRevision: (await app.readSession(sid)).revision });
    const { nodes } = await app.sessionTree({ sessionId: sid });
    expect(nodes.find((n) => n.id === "1.2")?.status).toBe("split");
    expect(await staleIds(app, sid)).toEqual([...pv.wouldStale].sort());
  });

  it("dependsOn 편집 동치", async () => {
    const pfdir = mk();
    const { app, sid } = await built(pfdir);
    const dependsOn = ["1.2"];
    const pv = await app.previewEdit({
      sessionId: sid,
      nodeId: "1.1.1",
      change: { dependsOn },
    });
    const before = await staleIds(app, sid);
    await app.editNode({
      sessionId: sid,
      nodeId: "1.1.1",
      dependsOn,
      expectedRevision: (await app.readSession(sid)).revision,
    });
    const newly = (await staleIds(app, sid)).filter((x) => !before.includes(x));
    expect(newly).toEqual([...pv.wouldStale].sort());
  });

  it("goal 검증(빈값·공백·상한)이 양쪽에서 같은 결론·같은 메시지", async () => {
    const pfdir = mk();
    const { app, sid } = await built(pfdir);
    for (const goal of ["", "   ", "x".repeat(5000)]) {
      // 메시지 문자열을 하드코딩하지 않는다 — 계층(wire zod / core)에 따라
      // 문구는 달라지지만 **preview와 실제 저장은 같은 결론·같은 문구**여야 한다.
      const pv = await app
        .previewEdit({ sessionId: sid, nodeId: "1.2.1", change: { goal } })
        .then(
          () => "성공",
          (e: Error) => e.message,
        );
      const real = await app
        .editNode({
          sessionId: sid,
          nodeId: "1.2.1",
          goal,
          expectedRevision: (await app.readSession(sid)).revision,
        })
        .then(
          () => "성공",
          (e: Error) => e.message,
        );
      expect(pv).not.toBe("성공");
      expect(real).toBe(pv);
    }
  });

  it("미리보기는 revision·노드를 건드리지 않는다", async () => {
    const pfdir = mk();
    const { app, sid } = await built(pfdir);
    const rev = (await app.readSession(sid)).revision;
    await app.previewEdit({ sessionId: sid, nodeId: "1.2", change: { goal: "z" } });
    expect((await app.readSession(sid)).revision).toBe(rev);
    expect(await staleIds(app, sid)).toEqual([]);
  });
});

function mk(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  return join(mkdtempSync(join(tmpdir(), "pf-eq-")), ".procforge");
}