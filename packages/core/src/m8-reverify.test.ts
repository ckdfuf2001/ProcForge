import { describe, it, expect, afterEach } from "vitest";
import { assertAllTrackedReplays, trackReplay } from "../test/replay-invariant.js";
import { CoreService } from "../src/service.js";
import { createMemoryStore } from "../src/store.js";
import type { Store } from "@procforge/shared/store.js";
import type { Session } from "@procforge/shared/schema.js";

// M8-1-0: 확정 leaf의 자기 재검증 (needs_reverify).

const catalog: Session["toolCatalog"] = [
  {
    server: "fs",
    name: "read",
    inputSchema: {
      type: "object",
      properties: { file_path: { type: "string" } },
      required: ["file_path"],
      additionalProperties: false,
    },
    schemaHash: "h1",
  },
];
const passEval = () => ({ verdict: "pass" as const, failedConstraints: [] as string[] });

function svc(store: Store = createMemoryStore()) {
  return trackReplay(new CoreService(store, passEval));
}

afterEach(async () => {
  await assertAllTrackedReplays();
});

function rep(args: Record<string, unknown> = { file_path: "a" }) {
  return {
    selfVerdict: "pass" as const,
    selfReason: "ok",
    tool: { server: "fs", name: "read" },
    args,
    resultSummary: "ok",
  };
}

async function leafed(s: CoreService) {
  const { session } = await s.pfStart({ request: "재검증", toolCatalog: catalog });
  const sid = session.id;
  await s.pfReport({ ...rep(), sessionId: sid, nodeId: "1" });
  await s.pfResolve({
    sessionId: sid,
    nodeId: "1",
    decision: "leaf",
    tool: { server: "fs", name: "read" },
    argSpecs: { file_path: { kind: "fixed", value: "a" } },
  });
  return sid;
}

async function reconfirm(
  s: CoreService,
  sid: string,
  nodeId: string,
  args: Record<string, unknown> = { file_path: "a" },
) {
  await s.pfNext({ sessionId: sid });
  await s.pfReport({ ...rep(args), sessionId: sid, nodeId });
  return s.pfResolve({
    sessionId: sid,
    nodeId,
    decision: "leaf",
    tool: { server: "fs", name: "read" },
    argSpecs: { file_path: { kind: "fixed", value: args.file_path } },
  });
}

describe("M8-1-0 leaf 자기 재검증", () => {
  it("advise → needs_reverify → pf_next → 옛 attempt 거절 → 새 report 재확정", async () => {
    const s = svc();
    const sid = await leafed(s);
    const advised = await s.pfAdvise({
      sessionId: sid,
      nodeId: "1",
      text: "파일 out.json 생성",
    });
    expect(advised.node.status).toBe("needs_reverify");
    expect(advised.node.reverifySince?.cause).toBe("advise");
    expect(advised.node.reverifySince?.causeNodeId).toBe("1");

    const next = await s.pfNext({ sessionId: sid });
    expect(next.done).toBe(false);
    if (!next.done) {
      expect(next.node.id).toBe("1");
      expect(next.node.status).toBe("probing");
      expect(next.enteredProbing).toBe(true);
    }

    // 옛 attempt(재검증 이전 revision)로는 확정할 수 없다.
    await expect(
      s.pfResolve({
        sessionId: sid,
        nodeId: "1",
        decision: "leaf",
        tool: { server: "fs", name: "read" },
        argSpecs: { file_path: { kind: "fixed", value: "a" } },
      }),
    ).rejects.toThrow(/재검증 필요/);

    const confirmed = await reconfirm(s, sid, "1");
    expect(confirmed.node.status).toBe("leaf");
    expect(confirmed.node.reverifySince).toBeUndefined();
    expect((await s.pfNext({ sessionId: sid })).done).toBe(true);
  });

  it("hash가 그대로면 edit_args도 전이하지 않는다", async () => {
    const s = svc();
    const sid = await leafed(s);
    const r = await s.pfEditArgs({
      sessionId: sid,
      nodeId: "1",
      patch: { set: { file_path: { kind: "fixed", value: "a" } } },
    });
    expect(r.node.status).toBe("leaf");
    expect(r.node.reverifySince).toBeUndefined();
  });

  it("locked leaf 쓰기는 거절한다", async () => {
    const s = svc();
    const sid = await leafed(s);
    await s.pfLock({ sessionId: sid, nodeId: "1" });
    await expect(
      s.pfAdvise({ sessionId: sid, nodeId: "1", text: "파일 out.json 생성" }),
    ).rejects.toThrow(/locked/);
    await expect(
      s.pfEditArgs({
        sessionId: sid,
        nodeId: "1",
        patch: { set: { file_path: { kind: "fixed", value: "b" } } },
      }),
    ).rejects.toThrow(/locked/);
    await expect(
      s.pfEditNode({ sessionId: sid, nodeId: "1", goal: "새 목표" }),
    ).rejects.toThrow(/locked/);
  });

  it("stale leaf 직접 수정은 needs_reverify가 우선, 재확정 시 staleSince도 지운다", async () => {
    const store = createMemoryStore();
    const s = svc(store);
    const sid = await leafed(s);
    const n = store.getNode(sid, "1")!;
    store.saveNode(sid, {
      ...n,
      staleSince: { revision: 1, causeNodeId: "1" },
    });
    const advised = await s.pfAdvise({
      sessionId: sid,
      nodeId: "1",
      text: "파일 out.json 생성",
    });
    expect(advised.node.status).toBe("needs_reverify");
    expect(advised.node.staleSince).toEqual({ revision: 1, causeNodeId: "1" });
    const confirmed = await reconfirm(s, sid, "1");
    expect(confirmed.node.status).toBe("leaf");
    expect(confirmed.node.staleSince).toBeUndefined();
  });

  it("needs_reverify/probing에서 pf_split 허용 + causeAdvice 자동 연결", async () => {
    const s = svc();
    const sid = await leafed(s);
    const advised = await s.pfAdvise({
      sessionId: sid,
      nodeId: "1",
      text: "3개로 나눠라",
    });
    expect(advised.node.status).toBe("needs_reverify");
    const next = await s.pfNext({ sessionId: sid });
    expect(next.done).toBe(false);
    if (!next.done) expect(next.node.status).toBe("probing");
    const split = await s.pfResolve({
      sessionId: sid,
      nodeId: "1",
      decision: "split",
      children: [{ goal: "a" }, { goal: "b" }],
      reason: "재검증 중 분해가 더 싸다. 읽기와 쓰기를 나눈다.",
    });
    expect(split.node.status).toBe("split");
    expect(split.node.reverifySince).toBeUndefined();
    const evs = await s.getEvents(sid);
    expect(evs.at(-1)?.detail?.causeAdviseIds?.length).toBe(1);
  });

  it("재확정 hash 변경만 하류에 전파한다", async () => {
    const s = svc();
    const { session } = await s.pfStart({ request: "전파", toolCatalog: catalog });
    const sid = session.id;
    await s.pfResolve({
      sessionId: sid,
      nodeId: "1",
      decision: "split",
      children: [{ goal: "a" }, { goal: "b", dependsOn: ["1.1"] }],
      reason: "하류 전파를 확인하려고 두 노드로 나눈다.",
    });
    await s.pfReport({ ...rep(), sessionId: sid, nodeId: "1.1" });
    await s.pfResolve({
      sessionId: sid,
      nodeId: "1.1",
      decision: "leaf",
      tool: { server: "fs", name: "read" },
      argSpecs: { file_path: { kind: "fixed", value: "a" } },
    });
    await s.pfReport({ ...rep(), sessionId: sid, nodeId: "1.2" });
    await s.pfResolve({
      sessionId: sid,
      nodeId: "1.2",
      decision: "leaf",
      tool: { server: "fs", name: "read" },
      argSpecs: { file_path: { kind: "fixed", value: "a" } },
    });
    const h2Before = (await s.getNode(sid, "1.2")).hash;

    await s.pfAdvise({
      sessionId: sid,
      nodeId: "1.1",
      text: "파일 out.json 생성",
    });
    const stale = await s.getNode(sid, "1.2");
    expect(stale.status).toBe("open");
    expect(stale.staleSince).toBeDefined();
    const h2Stale = stale.hash;

    // 같은 인자로 재확정: 1.1 hash가 advise 시점과 같아 하류 재전파 없음.
    await reconfirm(s, sid, "1.1");
    expect((await s.getNode(sid, "1.2")).hash).toBe(h2Stale);

    // 인자를 바꿔 재확정: 1.1 hash가 바뀌어 하류 hash도 바뀐다.
    await s.pfEditArgs({
      sessionId: sid,
      nodeId: "1.1",
      patch: { set: { file_path: { kind: "fixed", value: "b" } } },
    });
    await reconfirm(s, sid, "1.1", { file_path: "b" });
    expect((await s.getNode(sid, "1.2")).hash).not.toBe(h2Stale);
    expect(h2Before).not.toBe(h2Stale);
  });

  it("open 노드 advise는 기존처럼 open을 유지한다", async () => {
    const s = svc();
    const { session } = await s.pfStart({ request: "open", toolCatalog: catalog });
    const sid = session.id;
    const advised = await s.pfAdvise({
      sessionId: sid,
      nodeId: "1",
      text: "파일 out.json 생성",
    });
    expect(advised.node.status).toBe("open");
    expect(advised.node.reverifySince).toBeUndefined();
  });

  it("타임라인에 의견 → 재검증 → 재확정이 보인다", async () => {
    const s = svc();
    const { session } = await s.pfStart({ request: "타임라인", toolCatalog: catalog });
    const sid = session.id;
    await s.pfResolve({
      sessionId: sid,
      nodeId: "1",
      decision: "split",
      children: [{ goal: "a" }, { goal: "b", dependsOn: ["1.1"] }],
      reason: "타임라인 확인용 분해. 두 단계를 만든다.",
    });
    await s.pfReport({ ...rep(), sessionId: sid, nodeId: "1.1" });
    await s.pfResolve({
      sessionId: sid,
      nodeId: "1.1",
      decision: "leaf",
      tool: { server: "fs", name: "read" },
      argSpecs: { file_path: { kind: "fixed", value: "a" } },
    });
    await s.pfAdvise({
      sessionId: sid,
      nodeId: "1.1",
      text: "파일 out.json 생성",
    });
    await s.pfNext({ sessionId: sid });
    await s.pfReport({ ...rep(), sessionId: sid, nodeId: "1.1" });
    await s.pfResolve({
      sessionId: sid,
      nodeId: "1.1",
      decision: "leaf",
      tool: { server: "fs", name: "read" },
      argSpecs: { file_path: { kind: "fixed", value: "a" } },
    });

    const rounds = await s.getDecompositionHistory({ sessionId: sid });
    const events = rounds[0]?.events ?? [];
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("advise");
    expect(kinds).toContain("reverify");
    expect(kinds).toContain("confirm");
    for (const e of events) expect(e.nodeIds).toContain("1.1");
  });
});
