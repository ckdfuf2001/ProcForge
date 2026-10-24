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

  it("잠긴 split 노드의 의견은 거절하지 않는다(M8-1-0 이전 동작 유지)", async () => {
    const s = svc();
    const { session } = await s.pfStart({ request: "잠금", toolCatalog: catalog });
    const sid = session.id;
    await s.pfResolve({
      sessionId: sid,
      nodeId: "1",
      decision: "split",
      children: [{ goal: "a" }],
      reason: "잠금 확인용 분해. 자식 하나를 만든다.",
    });
    await s.pfLock({ sessionId: sid, nodeId: "1" });
    const advised = await s.pfAdvise({
      sessionId: sid,
      nodeId: "1",
      text: "방향을 더 다듬자.",
    });
    expect(advised.node.id).toBe("1");
  });

  it("reopen해도 reverifySince는 남는다 — 옛 attempt로 확정 불가", async () => {
    const s = svc();
    const sid = await leafed(s);
    await s.pfAdvise({
      sessionId: sid,
      nodeId: "1",
      text: "파일 out.json 생성",
    });
    const reopened = await s.pfReopen({ sessionId: sid, nodeId: "1" });
    expect(reopened.node.status).toBe("open");
    expect(reopened.node.reverifySince).toBeDefined();
    // 옛 attempt(재검증 이전 revision)로 확정하면 거절된다.
    await expect(
      s.pfResolve({
        sessionId: sid,
        nodeId: "1",
        decision: "leaf",
        tool: { server: "fs", name: "read" },
        argSpecs: { file_path: { kind: "fixed", value: "a" } },
      }),
    ).rejects.toThrow(/재검증 필요/);
  });

  it("pf_next 없이 바로 보고해도 같은 전환을 탄다(재시도 리셋·reverify 이벤트)", async () => {
    const store = createMemoryStore();
    const s = svc(store);
    const { session } = await s.pfStart({ request: "직접 보고", toolCatalog: catalog });
    const sid = session.id;
    await s.pfResolve({
      sessionId: sid,
      nodeId: "1",
      decision: "split",
      children: [{ goal: "a" }],
      reason: "타임라인 확인용 분해. 자식 하나를 만든다.",
    });
    await s.pfReport({ ...rep(), sessionId: sid, nodeId: "1.1" });
    await s.pfResolve({
      sessionId: sid,
      nodeId: "1.1",
      decision: "leaf",
      tool: { server: "fs", name: "read" },
      argSpecs: { file_path: { kind: "fixed", value: "a" } },
    });
    // 재시도 한도를 소진시킨 상태로 만든다(저장소 직접 조정 — 시험용).
    const before = store.getNode(sid, "1.1")!;
    store.saveNode(sid, { ...before, retries: 2 });
    await s.pfAdvise({
      sessionId: sid,
      nodeId: "1.1",
      text: "파일 out.json 생성",
    });
    const waiting = await s.getNode(sid, "1.1");
    expect(waiting.status).toBe("needs_reverify");
    expect(waiting.retries).toBe(2);
    const reported = await s.pfReport({ ...rep(), sessionId: sid, nodeId: "1.1" });
    expect(reported.verdict).toBe("pass");
    const after = await s.getNode(sid, "1.1");
    expect(after.status).toBe("probing");
    expect(after.retries).toBe(0);
    const rounds = await s.getDecompositionHistory({ sessionId: sid });
    const events = rounds[0]?.events ?? [];
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("advise");
    expect(kinds).toContain("reverify");
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

  it("나중에 준 의견도 그 노드를 만든 라운드 아래에 표시된다", async () => {
    // R1: 1 → 1.1~1.4, R2: 1.2 재분해 → 1.2.1·1.2.2, 그 뒤 1.3에 의견.
    // 예전 구현은 "다음 분해 라운드 직전까지"로 잘라 1.3 의견이 사라졌다.
    const s = svc();
    const { session } = await s.pfStart({ request: "귀속", toolCatalog: catalog });
    const sid = session.id;
    await s.pfResolve({
      sessionId: sid,
      nodeId: "1",
      decision: "split",
      children: [{ goal: "a" }, { goal: "b" }, { goal: "c" }, { goal: "d" }],
      reason: "첫 분해. 네 단계를 만든다.",
    });
    await s.pfResolve({
      sessionId: sid,
      nodeId: "1.2",
      decision: "split",
      children: [{ goal: "b1" }, { goal: "b2" }],
      reason: "두 번째 분해. 1.2를 다시 나눈다.",
    });
    await s.pfAdvise({
      sessionId: sid,
      nodeId: "1.3",
      text: "방향을 더 다듬자.",
    });

    const rounds = await s.getDecompositionHistory({ sessionId: sid });
    expect(rounds.length).toBe(2);
    const r1 = rounds[0]!;
    const r2 = rounds[1]!;
    expect(r1.parentId).toBe("1");
    expect(r1.childIds).toEqual(["1.1", "1.2", "1.3", "1.4"]);
    expect(r2.parentId).toBe("1.2");
    // 1.3 의견은 1.3을 만든 R1 아래에 표시된다.
    const adviseInR1 = (r1.events ?? []).filter((e) => e.kind === "advise");
    expect(adviseInR1.length).toBe(1);
    expect(adviseInR1[0]!.nodeIds).toEqual(["1.3"]);
    expect(r2.events ?? []).toHaveLength(0);
  });

  it("라운드의 부모 노드에 달린 의견은 그 라운드의 parentEvents 로 보인다", async () => {
    const s = svc();
    const { session } = await s.pfStart({ request: "부모", toolCatalog: catalog });
    const sid = session.id;
    await s.pfResolve({
      sessionId: sid,
      nodeId: "1",
      decision: "split",
      children: [{ goal: "a" }, { goal: "b" }],
      reason: "첫 분해. 둘로 나눈다.",
    });
    // 부모(1.1)에 의견 → 그 의견이 이후의 분해 계기다.
    await s.pfAdvise({
      sessionId: sid,
      nodeId: "1.1",
      text: "이 부분은 두 단계로 쪼개라",
    });
    await s.pfResolve({
      sessionId: sid,
      nodeId: "1.1",
      decision: "split",
      children: [{ goal: "x" }, { goal: "y" }],
      reason: "의견에 따라 1.1을 다시 나눈다.",
    });

    const rounds = await s.getDecompositionHistory({ sessionId: sid });
    expect(rounds.length).toBe(2);
    const advise = rounds[1]?.parentEvents?.filter((e) => e.kind === "advise") ?? [];
    expect(advise.length).toBe(1);
    expect(advise[0]!.nodeIds).toEqual(["1.1"]);
    // 부모 의견은 그 라운드의 events 가 아니라 parentEvents 로 표시한다.
    expect(rounds[1]?.events ?? []).toHaveLength(0);
  });

  it("같은 노드 두 번 분해(id 재사용) — 세대별로 이벤트가 갈라진다", async () => {
    // 1.1 을 열고 split(1.1.1·1.1.2) → reopen → 다시 split(1.1.1 재사용) →
    // 새 1.1.1 에 의견. 예전 구현은 생성 구간을 id 단위로 계산해 새 세대의
    // 의견이 첫 라운드에 섞였다(또는 사라졌다).
    const s = svc();
    const { session } = await s.pfStart({ request: "재사용", toolCatalog: catalog });
    const sid = session.id;
    await s.pfResolve({
      sessionId: sid,
      nodeId: "1",
      decision: "split",
      children: [{ goal: "a" }, { goal: "b" }],
      reason: "첫 분해. 둘로 나눈다.",
    });
    await s.pfResolve({
      sessionId: sid,
      nodeId: "1.1",
      decision: "split",
      children: [{ goal: "x" }, { goal: "y" }],
      reason: "1.1 을 나눈다. 세대 1.",
    });
    await s.pfReopen({ sessionId: sid, nodeId: "1.1" });
    await s.pfResolve({
      sessionId: sid,
      nodeId: "1.1",
      decision: "split",
      children: [{ goal: "z" }],
      reason: "1.1 을 다시 나눈다. 세대 2 — 1.1.1 이 재사용된다.",
    });
    // 새 세대( reused 1.1.1)에 의견
    await s.pfAdvise({
      sessionId: sid,
      nodeId: "1.1.1",
      text: "새 1.1.1 에 준 의견이다",
    });

    const rounds = await s.getDecompositionHistory({ sessionId: sid });
    const gen1 = rounds.find((r) => r.parentId === "1.1" && r.childIds.length === 2)!;
    const gen2 = rounds.find((r) => r.parentId === "1.1" && r.childIds.length === 1)!;
    // 새 세대의 의견은 두 번째 분해 라운드 아래에 표시된다.
    const inGen2 = gen2.events?.filter((e) => e.kind === "advise") ?? [];
    expect(inGen2.length).toBe(1);
    expect(inGen2[0]!.nodeIds).toEqual(["1.1.1"]);
    // 첫 세대 라운드에는 새 의견이 섞이지 않는다.
    expect(gen1.events?.filter((e) => e.kind === "advise") ?? []).toHaveLength(0);
  });

  it("미리보기: 확정 leaf에 의견을 저장하면 selfReverify:true (저장 전 확인용)", async () => {
    const s = svc();
    const sid = await leafed(s);
    const pv = await s.previewEdit({
      sessionId: sid,
      nodeId: "1",
      change: { advice: "파일 out.json 생성" },
    });
    expect(pv.selfReverify).toBe(true);
    // 미리보기는 상태를 바꾸지 않는다
    expect((await s.getNode(sid, "1")).status).toBe("leaf");
  });

  it("미리보기: 빈 의견·변경 없음은 selfReverify:false", async () => {
    const s = svc();
    const sid = await leafed(s);
    const pv = await s.previewEdit({
      sessionId: sid,
      nodeId: "1",
      change: { advice: "   " },
    });
    expect(pv.selfReverify).toBe(false);
  });
});
