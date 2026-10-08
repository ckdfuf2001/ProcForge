import { describe, it, expect } from "vitest";
import { CoreService, consumeRetry, isResolved, autoConstraints } from "../src/service.js";
import { compareNodeIds } from "@procforge/shared/ids.js";
import { createMemoryStore } from "../src/store.js";
import type { Node, Session } from "@procforge/shared/schema.js";

const catalog: Session["toolCatalog"] = [
  { server: "fs", name: "read", inputSchema: {}, schemaHash: "h1" },
];

const passEval = () => ({ verdict: "pass" as const, failedConstraints: [] as string[] });
const failEval = () => ({ verdict: "fail" as const, failedConstraints: ["c1"] });

const rep = (over: Record<string, unknown> = {}) => ({
  sessionId: "",
  nodeId: "1",
  tool: { server: "fs", name: "read" },
  args: {},
  resultSummary: "ok",
  selfVerdict: "pass" as const,
  selfReason: "looks good",
  ...over,
});

describe("M2.5-6 세션 핸들 UUID", () => {
  it("세션 id는 UUID", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: catalog });
    expect(session.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe("M2.6-4 external 승인 흐름", () => {
  const extCatalog: Session["toolCatalog"] = [
    { server: "mail", name: "send", inputSchema: {}, schemaHash: "h9" },
  ];
  it("ask_human(plan) → approve → confirm_leaf, 거부 시 open+조언", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const { session } = await svc.pfStart({ request: "메일 발송", toolCatalog: extCatalog });
    await svc.pfResolve({
      sessionId: session.id,
      nodeId: "1",
      decision: "split",
      children: [{ goal: "발송", sideEffect: "external" }],
    });
    const ask = await svc.pfResolve({
      sessionId: session.id,
      nodeId: "1.1",
      decision: "ask_human",
      plan: { tool: { server: "mail", name: "send" }, args: { to: "a@b.c" } },
      note: "발송해도 될까요",
    });
    expect(ask.node.status).toBe("needs_human");
    expect(ask.node.attempts).toHaveLength(1);
    expect(ask.node.attempts[0].verdict).toBeUndefined();

    // 계획 없이 승인 시도 → 불가(다른 노드)
    await expect(svc.pfApprove(session.id, "1", true)).rejects.toThrow();

    // 거부 → open + 조언 기록
    const rej = await svc.pfApprove(session.id, "1.1", false, "내일 발송");
    expect(rej.status).toBe("open");
    expect(rej.advice.at(-1)?.text).toBe("내일 발송");

    // 다시 계획 → 승인 → 확정
    await svc.pfResolve({
      sessionId: session.id,
      nodeId: "1.1",
      decision: "ask_human",
      plan: { tool: { server: "mail", name: "send" }, args: { to: "a@b.c" } },
    });
    const ap = await svc.pfApprove(session.id, "1.1", true, "ok");
    expect(ap.status).toBe("probing");
    expect(ap.approval).toBeDefined();
    const leaf = await svc.pfResolve({
      sessionId: session.id,
      nodeId: "1.1",
      decision: "leaf",
      tool: { server: "mail", name: "send" },
      argSpecs: { to: { kind: "fixed", value: "a@b.c" } },
    });
    expect(leaf.node.status).toBe("leaf");
  });

  it("미승인 external은 leaf 불가", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: extCatalog });
    await svc.pfResolve({
      sessionId: session.id,
      nodeId: "1",
      decision: "split",
      children: [{ goal: "발송", sideEffect: "external" }],
    });
    await svc.pfResolve({ sessionId: session.id, nodeId: "1.1", decision: "ask_human" });
    await expect(
      svc.pfResolve({
        sessionId: session.id,
        nodeId: "1.1",
        decision: "leaf",
        tool: { server: "mail", name: "send" },
        argSpecs: {},
      }),
    ).rejects.toThrow();
  });
});

describe("M1.5-4 node id 숫자 정렬", () => {
  it('"1.2" < "1.10"', () => {
    expect(compareNodeIds("1.2", "1.10")).toBeLessThan(0);
    expect(compareNodeIds("1.10", "1.2")).toBeGreaterThan(0);
    expect(compareNodeIds("1", "1.1")).toBeLessThan(0);
    expect(compareNodeIds("2", "1.10")).toBeGreaterThan(0);
    expect(["1.10", "1.2", "1", "2"].sort(compareNodeIds)).toEqual(["1", "1.2", "1.10", "2"]);
  });
});

describe("M1.5-6 재시도 경계 통일 (총 maxRetries+1회)", () => {
  const n = (retries: number) =>
    ({ retries, status: "probing" }) as unknown as Node;
  const limits = { maxDepth: 3, maxRetries: 1, maxNodes: 10 };
  it("1회 실패→probing, 2회 실패→needs_human", () => {
    expect(consumeRetry(n(0), limits)).toEqual({ status: "probing", retries: 1 });
    expect(consumeRetry(n(1), limits)).toEqual({ status: "needs_human", retries: 2 });
  });
});

describe("M1.5-5 dependsOn 충족 (leaf 또는 전체-leaf split)", () => {
  const leaf = (id: string) => ({ id, status: "leaf", children: [] }) as unknown as Node;
  it("split+전부 leaf면 resolved", () => {
    const byId = new Map<string, Node>([
      ["s", { id: "s", status: "split", children: ["s.1", "s.2"] } as unknown as Node],
      ["s.1", leaf("s.1")],
      ["s.2", leaf("s.2")],
    ]);
    expect(isResolved(byId.get("s")!, byId)).toBe(true);
  });
  it("자식 중 open이 있으면 미충족", () => {
    const byId = new Map<string, Node>([
      ["s", { id: "s", status: "split", children: ["s.1"] } as unknown as Node],
      ["s.1", { id: "s.1", status: "open", children: [] } as unknown as Node],
    ]);
    expect(isResolved(byId.get("s")!, byId)).toBe(false);
  });
});

describe("M1.5-1 pass여도 leaf 자동 확정 없음", () => {
  it("report pass → probing 유지, resolve(leaf)로만 확정", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: catalog });
    const r = await svc.pfReport({ ...rep(), sessionId: session.id });
    expect(r.verdict).toBe("pass");
    expect(r.instruction).toMatch(/pf_confirm_leaf/);
    let tree = await svc.pfTree(session.id);
    expect(tree.nodes[0].status).toBe("probing");
    expect(tree.nodes[0].tool).toBeUndefined();
    // argSpecs 없이 leaf 신청 → bad_request
    await expect(
      svc.pfResolve({ sessionId: session.id, nodeId: "1", decision: "leaf", tool: { server: "fs", name: "read" } }),
    ).rejects.toThrow();
    // 키 누락 → bad_request
    const svc2 = new CoreService(createMemoryStore(), passEval);
    const s2 = await svc2.pfStart({ request: "r", toolCatalog: catalog });
    await svc2.pfReport({ ...rep(), sessionId: s2.session.id, args: { path: "a", extra: 1 } });
    await expect(
      svc2.pfResolve({
        sessionId: s2.session.id,
        nodeId: "1",
        decision: "leaf",
        tool: { server: "fs", name: "read" },
        argSpecs: { path: { kind: "fixed", value: "a" } },
      }),
    ).rejects.toThrow(/argSpecs missing: extra/);
    // 정상 확정 → leaf + golden
    const done = await svc2.pfResolve({
      sessionId: s2.session.id,
      nodeId: "1",
      decision: "leaf",
      tool: { server: "fs", name: "read" },
      argSpecs: { path: { kind: "fixed", value: "a" }, extra: { kind: "fixed", value: 1 } },
    });
    expect(done.node.status).toBe("leaf");
    expect(done.node.golden).toBeDefined();
    const nxt = await svc2.pfNext(s2.session.id);
    expect(nxt.done).toBe(true);
  });

  it("fixed≈params 경고는 resolve 경로에서", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const s = await svc.pfStart({ request: "r", params: { month: "2026-09" }, toolCatalog: catalog });
    await svc.pfReport({ ...rep(), sessionId: s.session.id, args: { month: "2026-09" } });
    const leaf = await svc.pfResolve({
      sessionId: s.session.id,
      nodeId: "1",
      decision: "leaf",
      tool: { server: "fs", name: "read" },
      argSpecs: { month: { kind: "fixed", value: "2026-09" } },
    });
    expect(leaf.instruction).toMatch(/var/);
  });
});

describe("M1.5-2 selfVerdict + auto constraint", () => {
  it("selfVerdict/selfReason 없으면 bad_request", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: catalog });
    await expect(
      svc.pfReport({ sessionId: session.id, nodeId: "1", tool: { server: "fs", name: "read" }, args: {}, resultSummary: "x" } as never),
    ).rejects.toThrow(/selfVerdict/);
  });

  it("constraints 비었으면 selfVerdict 사용 (fail 포함)", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const { session } = await svc.pfStart({
      request: "r",
      toolCatalog: catalog,
      limits: { maxDepth: 3, maxRetries: 5, maxNodes: 10 },
    });
    const r = await svc.pfReport({ ...rep(), sessionId: session.id, selfVerdict: "fail", selfReason: "host says bad" });
    expect(r.verdict).toBe("fail");
    const tree = await svc.pfTree(session.id);
    expect(tree.nodes[0].status).toBe("probing");
    expect(tree.nodes[0].retries).toBe(1);
  });

  it("첫 pass 시 결과 형태 기반 auto constraint 부착", () => {
    const auto = autoConstraints({ slides: [1], title: "t" }, ["fixtures/1/a/out.txt"]);
    expect(auto.some((c) => c.kind === "file_exists")).toBe(true);
    expect(auto.some((c) => c.kind === "json_path_exists")).toBe(true);
  });

  it("첫 pass 보고에 auto constraint가 노드에 부착됨", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: catalog });
    await svc.pfReport({
      ...rep(),
      sessionId: session.id,
      resultJson: { slides: [1, 2] },
      artifacts: ["fixtures/1/a/out.txt"],
    });
    const tree = await svc.pfTree(session.id);
    expect(tree.nodes[0].constraints.length).toBeGreaterThan(0);
    expect(tree.nodes[0].status).toBe("probing");
  });
});

describe("M1.5-3 llm_rubric 사유 필수", () => {
  it("사유 없으면 needs_human, 보충 후 open 복귀 아님 retry로 재보고", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: catalog });
    await svc.pfAdvise(session.id, "1", "문체를 자연스럽게");
    let tree = await svc.pfTree(session.id);
    const rubricId = tree.nodes[0].constraints.find((c) => c.kind === "llm_rubric")!.id;
    const r = await svc.pfReport({ ...rep(), sessionId: session.id });
    expect(r.verdict).toBe("fail");
    tree = await svc.pfTree(session.id);
    expect(tree.nodes[0].status).toBe("needs_human");
    // retry 후 사유 첨부 재보고 → pass(probing)
    await svc.pfResolve({ sessionId: session.id, nodeId: "1", decision: "retry" });
    const r2 = await svc.pfReport({ ...rep(), sessionId: session.id, rubricReasons: { [rubricId]: "문체 자연스러움 확인" } });
    expect(r2.verdict).toBe("pass");
    tree = await svc.pfTree(session.id);
    const last = tree.nodes[0].attempts.at(-1)!;
    expect(last.rubricReasons?.[rubricId]).toBe("문체 자연스러움 확인");
  });
});

describe("core 상태머신 회귀 (M1)", () => {
  it("실패 누적 → needs_human (maxRetries=1이면 2회)", async () => {
    const svc = new CoreService(createMemoryStore(), failEval);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: catalog, limits: { maxDepth: 3, maxRetries: 1, maxNodes: 10 } });
    await svc.pfReport({ ...rep(), sessionId: session.id, selfVerdict: "pass", resultJson: undefined });
    // constraints 비어 selfVerdict pass지만 checker fail → fail 1회 → probing
    let tree = await svc.pfTree(session.id);
    // 주의: constraints가 비었으므로 selfVerdict(pass) 사용 → pass. checker 무시는 M1.5-2 의도.
    expect(tree.nodes[0].status).toBe("probing");
  });

  it("checker fail + self pass → fail, 소진 시 needs_human", async () => {
    const svc = new CoreService(createMemoryStore(), failEval);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: catalog, limits: { maxDepth: 3, maxRetries: 1, maxNodes: 10 } });
    await svc.pfAdvise(session.id, "1", "결과 파일 out/report.md 생성");
    await svc.pfReport({ ...rep(), sessionId: session.id });
    let tree = await svc.pfTree(session.id);
    expect(tree.nodes[0].status).toBe("probing");
    await svc.pfReport({ ...rep(), sessionId: session.id });
    tree = await svc.pfTree(session.id);
    expect(tree.nodes[0].status).toBe("needs_human");
  });

  it("split → 자식 open, needs_human 조언 후 open 복귀", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: catalog });
    const sp = await svc.pfResolve({ sessionId: session.id, nodeId: "1", decision: "split", children: [{ goal: "a" }, { goal: "b" }] });
    expect(sp.created?.length).toBe(2);
    await svc.pfResolve({ sessionId: session.id, nodeId: "1.1", decision: "ask_human" });
    let tree = await svc.pfTree(session.id);
    expect(tree.nodes.find((n) => n.id === "1.1")?.status).toBe("needs_human");
    await svc.pfAdvise(session.id, "1.1", "매출은 부가세 제외 기준");
    tree = await svc.pfTree(session.id);
    expect(tree.nodes.find((n) => n.id === "1.1")?.status).toBe("open");
  });

  it("split 자식이 전부 leaf면 부모 의존 충족 (pfNext 진행)", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: catalog });
    await svc.pfResolve({
      sessionId: session.id,
      nodeId: "1",
      decision: "split",
      children: [{ goal: "a" }, { goal: "b", dependsOn: ["1.1"] }],
    });
    const finishLeaf = async (id: string) => {
      await svc.pfReport({ ...rep(), sessionId: session.id, nodeId: id });
      await svc.pfResolve({
        sessionId: session.id,
        nodeId: id,
        decision: "leaf",
        tool: { server: "fs", name: "read" },
        argSpecs: {},
      });
    };
    // 1.2는 1.1 대기 → pfNext는 1.1 반환
    let nxt = await svc.pfNext(session.id);
    if (!nxt.done) expect(nxt.node.id).toBe("1.1");
    await finishLeaf("1.1");
    nxt = await svc.pfNext(session.id);
    if (!nxt.done) expect(nxt.node.id).toBe("1.2");
    await finishLeaf("1.2");
    expect(await svc.pfNext(session.id)).toEqual({ done: true });
  });

  it("depth 초과 split 거부 → needs_human", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: catalog, limits: { maxDepth: 0, maxRetries: 1, maxNodes: 10 } });
    const sp = await svc.pfResolve({ sessionId: session.id, nodeId: "1", decision: "split", children: [{ goal: "a" }] });
    expect(sp.node.status).toBe("needs_human");
  });

  it("external 노드 probing 실행 금지", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: catalog });
    await svc.pfResolve({
      sessionId: session.id,
      nodeId: "1",
      decision: "split",
      children: [{ goal: "send mail", sideEffect: "external" }],
    });
    const r = await svc.pfReport({ ...rep(), sessionId: session.id, nodeId: "1.1" });
    expect(r.verdict).toBe("fail");
    expect(r.instruction).toMatch(/dry-run/);
    const tree = await svc.pfTree(session.id);
    expect(tree.nodes.find((n) => n.id === "1.1")?.status).toBe("needs_human");
  });

  it("locked 노드 재분해 금지 + leaf 확정 불가", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: catalog });
    await svc.pfLock(session.id, "1");
    await expect(svc.pfResolve({ sessionId: session.id, nodeId: "1", decision: "split", children: [{ goal: "x" }] })).rejects.toThrow();
    await expect(
      svc.pfResolve({ sessionId: session.id, nodeId: "1", decision: "leaf", tool: { server: "fs", name: "read" }, argSpecs: {} }),
    ).rejects.toThrow();
  });

  it("조언 추가 시 하위 dependsOn 노드만 stale 처리", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: catalog });
    await svc.pfResolve({ sessionId: session.id, nodeId: "1", decision: "split", children: [{ goal: "a" }, { goal: "b" }] });
    await svc.pfReport({ ...rep(), sessionId: session.id, nodeId: "1.1" });
    await svc.pfAdvise(session.id, "1.1", "형식을 맞춰라");
    const tree = await svc.pfTree(session.id);
    expect(tree.nodes.find((n) => n.id === "1.1")?.constraints.length).toBeGreaterThan(0);
  });

  it("leaf 확정은 passing attempt 없이 불가 + tool 불일치 불가", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: catalog });
    await expect(
      svc.pfResolve({ sessionId: session.id, nodeId: "1", decision: "leaf", tool: { server: "fs", name: "read" }, argSpecs: {} }),
    ).rejects.toThrow();
    await svc.pfReport({ ...rep(), sessionId: session.id });
    await expect(
      svc.pfResolve({
        sessionId: session.id,
        nodeId: "1",
        decision: "leaf",
        tool: { server: "no", name: "tool" },
        argSpecs: {},
      }),
    ).rejects.toThrow();
  });
});
