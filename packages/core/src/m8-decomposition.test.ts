import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CoreService } from "../src/service.js";
import { createMemoryStore } from "../src/store.js";
import { FileStore } from "@procforge/shared/filestore.js";
import type { Store } from "@procforge/shared/store.js";
import type { Session } from "@procforge/shared/schema.js";

// M8-ui2: 분해 사유·이벤트 상세·읽기 API(history/tree) 계약.
//
// 이번 마일스톤의 핵심은 두 가지다.
// 1) 모든 쓰기 이벤트가 "무엇이 왜 바뀌었는지"를 남긴다 (detail.nodesAfter).
// 2) 사람이 읽을 수 있는 분해 라운드 이력(history)과 시점 트리(treeAt)를 읽는다.

const catalog: Session["toolCatalog"] = [
  { server: "fs", name: "read", inputSchema: {}, schemaHash: "h1" },
];
const passEval = () => ({ verdict: "pass" as const, failedConstraints: [] as string[] });

const REASON = "한 파일로는 크다. 읽기와 쓰기를 나눠 각각 검증한다.";
const ALT = "전체를 한 노드로 처리하기";

function svc(store: Store = createMemoryStore()) {
  return new CoreService(store, passEval);
}

/** 구 세션(과거 시각)을 TTL 만료 없이 읽기 위한 서비스. */
function legacySvc(store: Store) {
  return new CoreService(store, passEval, {
    now: () => Date.parse("2026-01-01T00:00:10.000Z"),
  });
}

async function started(s: CoreService) {
  const { session } = await s.pfStart({ request: "M8 분해 이력", toolCatalog: catalog });
  return session.id;
}

describe("M8-ui2 분해 사유 (reason·alternatives)", () => {
  it("사유는 부모 노드에 남고 이벤트로도 기록된다", async () => {
    const s = svc();
    const sid = await started(s);
    const out = await s.pfResolve({
      sessionId: sid,
      nodeId: "1",
      decision: "split",
      children: [{ goal: "읽기" }, { goal: "쓰기" }],
      reason: REASON,
      alternatives: [ALT],
    });
    expect(out.node.splitReason).toBe(REASON);
    const ev = (await s.getEvents(sid)).at(-1)!;
    expect(ev.detail?.reason).toBe(REASON);
    expect(ev.detail?.alternatives).toEqual([ALT]);
    expect(ev.detail?.parentId).toBe("1");
    expect(ev.detail?.childIds).toEqual(["1.1", "1.2"]);
  });

  it("사유는 노드 해시에 들어가지 않는다 (승인 불변)", async () => {
    const withReason = svc();
    const without = svc();
    const sidA = await started(withReason);
    const sidB = await started(without);
    await withReason.pfResolve({
      sessionId: sidA, nodeId: "1", decision: "split",
      children: [{ goal: "a" }], reason: REASON,
    });
    await without.pfResolve({
      sessionId: sidB, nodeId: "1", decision: "split",
      children: [{ goal: "a" }],
    });
    const a = await withReason.getNode(sidA, "1");
    const b = await without.getNode(sidB, "1");
    // reason은 사람이 읽는 값이다. 해시(승인·재검증의 기준)는 불변이다.
    expect(a.hash).toBe(b.hash);
    expect(a.splitReason).toBe(REASON);
    expect(b.splitReason).toBeUndefined();
  });

  it("사유 누락·공백·1001자는 bad_request", async () => {
    const s = svc();
    const sid = await started(s);
    await expect(
      s.pfResolve({
        sessionId: sid, nodeId: "1", decision: "split",
        children: [{ goal: "a" }], reason: "짧음",
      }),
    ).rejects.toThrow(/reason/);
    await expect(
      s.pfResolve({
        sessionId: sid, nodeId: "1", decision: "split",
        children: [{ goal: "a" }], reason: "x".repeat(1001),
      }),
    ).rejects.toThrow(/reason/);
    await expect(
      s.pfResolve({
        sessionId: sid, nodeId: "1", decision: "split",
        children: [{ goal: "a" }], alternatives: ["a", "b", "c", "d"],
      }),
    ).rejects.toThrow(/alternatives/);
  });

  it("import·fixture 경로는 사유 없이도 분해된다 (호환)", async () => {
    const s = svc();
    const sid = await started(s);
    const out = await s.pfResolve({
      sessionId: sid, nodeId: "1", decision: "split",
      children: [{ goal: "a" }],
    });
    expect(out.node.splitReason).toBeUndefined();
    const ev = (await s.getEvents(sid)).at(-1)!;
    expect(ev.detail?.reason).toBeUndefined();
    expect(ev.detail?.childIds).toEqual(["1.1"]);
  });
});

describe("M8-ui2 이벤트 상세 (detail.nodesAfter)", () => {
  it("모든 쓰기 이벤트가 변경된 노드 스냅샷을 남긴다", async () => {
    const s = svc();
    const sid = await started(s);
    await s.pfResolve({
      sessionId: sid, nodeId: "1", decision: "split",
      children: [{ goal: "a" }, { goal: "b" }], reason: REASON,
    });
    await s.pfAdvise({ sessionId: sid, nodeId: "1.1", text: "여기부터는 사람 확인 필요." });
    const events = await s.getEvents(sid);
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (const e of events) {
      expect(e.detail, `${e.method} 이벤트에 detail이 없다`).toBeDefined();
      expect(Array.isArray(e.detail?.nodesAfter)).toBe(true);
    }
    const split = events.find((e) => e.summary.startsWith("split "))!;
    expect(split.detail?.nodesAfter?.map((n) => n.id).sort()).toEqual(["1", "1.1", "1.2"]);
    const advise = events.find((e) => e.method === "pfAdvise")!;
    expect(advise.detail?.nodesAfter?.map((n) => n.id)).toEqual(["1.1"]);
  });

  it("이벤트를 되감아 현재 store와 같은 트리를 복원한다 (재생 불변식)", async () => {
    const s = svc();
    const sid = await started(s);
    await s.pfResolve({
      sessionId: sid, nodeId: "1", decision: "split",
      children: [{ goal: "a" }, { goal: "b" }], reason: REASON,
    });
    await s.pfAdvise({ sessionId: sid, nodeId: "1.1", text: "사람 조언입니다." });
    const tree = await s.getTreeAt({ sessionId: sid, revision: 2 });
    expect(tree.structureOnly).toBe(false);
    const live = await s.pfTree(sid);
    expect(tree.nodes.map((n) => n.id)).toEqual(live.nodes.map((n) => n.id));
    for (const n of live.nodes) {
      const got = tree.nodes.find((x) => x.id === n.id)!;
      expect(got.status).toBe(n.status);
      expect(got.goal).toBe(n.goal);
      expect(got.children).toEqual(n.children);
      expect(got.hash).toBe(n.hash);
    }
  });
});

describe("M8-ui2 분해 라운드 이력 (getDecompositionHistory)", () => {
  it("분해 라운드가 revision·깊이·사유와 함께 나온다", async () => {
    const s = svc();
    const sid = await started(s);
    await s.pfResolve({
      sessionId: sid, nodeId: "1", decision: "split",
      children: [{ goal: "a" }, { goal: "b" }], reason: REASON, alternatives: [ALT],
    });
    await s.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "split",
      children: [{ goal: "a1" }], reason: "더 작게 나누는 것이 낫다.",
    });
    const rounds = await s.getDecompositionHistory({ sessionId: sid });
    expect(rounds.length).toBe(2);
    expect(rounds[0]).toMatchObject({
      parentId: "1",
      childIds: ["1.1", "1.2"],
      depth: 0,
      reason: REASON,
      alternatives: [ALT],
    });
    expect(rounds[1]).toMatchObject({
      parentId: "1.1",
      childIds: ["1.1.1"],
      depth: 1,
      reason: "더 작게 나누는 것이 낫다.",
    });
    expect(rounds[0].revision).toBeLessThan(rounds[1].revision);
  });

  it("읽기 전용이다 (revision·노드 상태 불변)", async () => {
    const s = svc();
    const sid = await started(s);
    await s.pfResolve({
      sessionId: sid, nodeId: "1", decision: "split",
      children: [{ goal: "a" }], reason: REASON,
    });
    const before = await s.getSession(sid);
    const treeBefore = await s.pfTree(sid);
    await s.getDecompositionHistory({ sessionId: sid });
    const after = await s.getSession(sid);
    const treeAfter = await s.pfTree(sid);
    expect(after.revision).toBe(before.revision);
    expect(treeAfter.nodes.map((n) => n.status)).toEqual(treeBefore.nodes.map((n) => n.status));
  });
});

describe("M8-ui2 시점 트리 (getTreeAt)", () => {
  it("revision 이전의 노드는 보이지 않는다", async () => {
    const s = svc();
    const sid = await started(s);
    await s.pfResolve({
      sessionId: sid, nodeId: "1", decision: "split",
      children: [{ goal: "a" }, { goal: "b" }], reason: REASON,
    });
    const at0 = await s.getTreeAt({ sessionId: sid, revision: 0 });
    expect(at0.nodes.map((n) => n.id)).toEqual(["1"]);
    const at1 = await s.getTreeAt({ sessionId: sid, revision: 1 });
    expect(at1.nodes.map((n) => n.id)).toEqual(["1", "1.1", "1.2"]);
  });

  it("미래 revision은 bad_request", async () => {
    const s = svc();
    const sid = await started(s);
    await expect(
      s.getTreeAt({ sessionId: sid, revision: 99 }),
    ).rejects.toThrow(/revision/);
  });
});

describe("M8-ui2 조언→재분해 연결 (causeAdviseIds)", () => {
  it("조언이 등록된 뒤의 분해는 그 조언을 원인으로 기록한다", async () => {
    const s = svc();
    const sid = await started(s);
    await s.pfResolve({
      sessionId: sid, nodeId: "1", decision: "split",
      children: [{ goal: "a" }], reason: REASON,
    });
    await s.pfAdvise({ sessionId: sid, nodeId: "1.1", text: "여기는 사람이 확인해야 한다." });
    const advised = await s.getNode(sid, "1.1");
    const adviceId = advised.advice.at(-1)!.id;
    expect(typeof adviceId).toBe("string");
    // 1.1을 다시 분해한다 → 이 조언이 원인이 된다.
    await s.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "split",
      children: [{ goal: "a1" }], reason: "조언을 반영해 더 잘게 나눈다.",
    });
    const ev = (await s.getEvents(sid)).at(-1)!;
    expect(ev.detail?.causeAdviseIds).toEqual([adviceId]);
  });

  it("직전 split 이전의 조언은 원인이 아니다", async () => {
    const s = svc();
    const sid = await started(s);
    await s.pfResolve({
      sessionId: sid, nodeId: "1", decision: "split",
      children: [{ goal: "a" }], reason: REASON,
    });
    await s.pfAdvise({ sessionId: sid, nodeId: "1.1", text: "첫 조언입니다." });
    await s.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "split",
      children: [{ goal: "a1" }], reason: "첫 번째 분해의 사유입니다.",
    });
    await s.pfAdvise({ sessionId: sid, nodeId: "1.1", text: "두 번째 조언입니다." });
    await s.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "split",
      children: [{ goal: "a2" }], reason: "두 번째 분해의 사유입니다.",
    });
    const events = await s.getEvents(sid);
    const last = events.at(-1)!;
    const advised = await s.getNode(sid, "1.1");
    const secondAdviceId = advised.advice.at(-1)!.id;
    expect(last.detail?.causeAdviseIds).toEqual([secondAdviceId]);
  });
});

describe("M8-ui2 구 세션 호환 (패치 없는 이벤트)", () => {
  /** 구 형식 이벤트(상세 없음)로 된 세션을 만든다. */
  function legacySession(): { store: FileStore; sid: string } {
    const dir = mkdtempSync(join(tmpdir(), "pf-m8-legacy-"));
    const store = new FileStore(dir);
    const sid = "11111111-2222-4333-8444-555555555555";
    mkdirSync(join(dir, "sessions", sid, "nodes"), { recursive: true });
    const session = {
      id: sid,
      request: "구 세션",
      params: {},
      toolCatalog: catalog,
      rootId: "1",
      limits: { maxDepth: 5, maxRetries: 2, maxNodes: 50 },
      createdAt: "2026-01-01T00:00:00.000Z",
      revision: 2,
    };
    writeFileSync(
      join(dir, "sessions", sid, "session.json"),
      JSON.stringify(session, null, 2),
    );
    const node = (id: string, parentId: string | null, goal: string, depth: number) =>
      JSON.stringify({
        id, parentId, goal, status: "open", depth,
        dependsOn: [], children: [], sideEffect: "none",
        constraints: [], advice: [], attempts: [], retries: 0,
        hash: "h", locked: false,
      });
    writeFileSync(join(dir, "sessions", sid, "nodes", "1.json"), node("1", null, "루트", 0));
    writeFileSync(join(dir, "sessions", sid, "nodes", "1.1.json"), node("1.1", "1", "자식1", 1));
    writeFileSync(join(dir, "sessions", sid, "nodes", "1.2.json"), node("1.2", "1", "자식2", 1));
    // detail 없는 구 이벤트 2건 (split + report)
    const events = [
      {
        seq: 1, revision: 1, at: "2026-01-01T00:00:01.000Z", actor: "host",
        method: "pfResolve", nodeIds: ["1", "1.1", "1.2"],
        beforeHash: "b", afterHash: "a", summary: "split 1 +2",
      },
      {
        seq: 2, revision: 2, at: "2026-01-01T00:00:02.000Z", actor: "host",
        method: "pfReport", nodeIds: ["1.1"],
        beforeHash: "a", afterHash: "c", summary: "report 1.1 pass",
      },
    ];
    writeFileSync(
      join(dir, "sessions", sid, "events.jsonl"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    return { store, sid };
  }

  it("이력은 나오고 사유는 null이다", async () => {
    const { store, sid } = legacySession();
    const s = legacySvc(store);
    const rounds = await s.getDecompositionHistory({ sessionId: sid });
    expect(rounds.length).toBe(1);
    expect(rounds[0]).toMatchObject({
      parentId: "1",
      childIds: ["1.1", "1.2"],
      depth: 0,
      reason: null,
      alternatives: [],
      causeAdviseIds: [],
    });
  });

  it("패치 없는 구간은 구조만, 상태 null (structureOnly)", async () => {
    const { store, sid } = legacySession();
    const s = legacySvc(store);
    const tree = await s.getTreeAt({ sessionId: sid, revision: 2 });
    expect(tree.structureOnly).toBe(true);
    expect(tree.nodes.map((n) => n.id).sort()).toEqual(["1", "1.1", "1.2"]);
    for (const n of tree.nodes) expect(n.status).toBeNull();
  });
});

describe("M8-ui2 파일 저장소 왕복", () => {
  it("파일에 저장된 이벤트에도 detail이 남는다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pf-m8-file-"));
    const store = new FileStore(dir);
    const s = svc(store);
    const sid = await started(s);
    await s.pfResolve({
      sessionId: sid, nodeId: "1", decision: "split",
      children: [{ goal: "a" }], reason: REASON,
    });
    const reread = new FileStore(dir);
    const s2 = svc(reread);
    const ev = (await s2.getEvents(sid)).at(-1)!;
    expect(ev.detail?.reason).toBe(REASON);
    expect(ev.detail?.childIds).toEqual(["1.1"]);
    const tree = await s2.getTreeAt({ sessionId: sid, revision: 1 });
    expect(tree.structureOnly).toBe(false);
    expect(tree.nodes.map((n) => n.id)).toEqual(["1", "1.1"]);
  });

  it("구 세션 디렉터리를 그대로 읽는다 (d290 스타일)", async () => {
    // 실제 저장소를 복사해 구 이벤트 세션을 읽는다 (파일을 못 읽으면 조용히 넘어가지 않는다).
    const src = join(process.cwd(), ".procforge", "sessions");
    const d290 = join(src, "d290a93d-dd9d-42d6-9e37-5a6ceb90a282");
    const exists = await import("node:fs").then((fs) => fs.existsSync(d290));
    if (!exists) return; // 로컬에만 있는 세션이면 건너뛴다 (CI는 계속 green).
    const dir = mkdtempSync(join(tmpdir(), "pf-m8-d290-"));
    cpSync(d290, join(dir, "sessions", "d290a93d-dd9d-42d6-9e37-5a6ceb90a282"), {
      recursive: true,
    });
    const store = new FileStore(dir);
    const sid = "d290a93d-dd9d-42d6-9e37-5a6ceb90a282";
    const s = svc(store);
    const rounds = await s.getDecompositionHistory({ sessionId: sid });
    expect(rounds.length).toBeGreaterThan(0);
    for (const r of rounds) expect(r.reason).toBeNull();
    const tree = await s.getTreeAt({ sessionId: sid, revision: 1 });
    expect(tree.structureOnly).toBe(true);
  });
});
