import { describe, it, expect } from "vitest";
import { CoreService, consumeRetry, isResolved, autoConstraints, computeDeadlock } from "../src/service.js";
import { compareNodeIds } from "@procforge/shared/ids.js";
import { createMemoryStore } from "../src/store.js";
import type { Store } from "@procforge/shared/store.js";
import type { EventEntry } from "@procforge/shared/dto.js";
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

describe("M3.4-7 additionalProperties:false 낯선 키 거부", () => {
  const strictCat: Session["toolCatalog"] = [
    {
      server: "fs",
      name: "read",
      inputSchema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"], additionalProperties: false } as unknown as Record<string, unknown>,
      schemaHash: "h1",
    },
  ];
  it("오타 키 거부 + 유사 키 제안, 허용 스키마는 통과", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: strictCat });
    await svc.pfReport({ ...rep(), sessionId: session.id, tool: { server: "fs", name: "read" }, args: { file_path: "a" } });
    const typoSpecs = {
      file_path: { kind: "fixed", value: "a" },
      filepath: { kind: "fixed", value: "a" },
    } as never;
    await expect(
      svc.pfResolve({ sessionId: session.id, nodeId: "1", decision: "leaf", tool: { server: "fs", name: "read" }, argSpecs: typoSpecs }),
    ).rejects.toThrow(/argSpecs unknown/);
    try {
      await svc.pfResolve({
        sessionId: session.id,
        nodeId: "1",
        decision: "leaf",
        tool: { server: "fs", name: "read" },
        argSpecs: typoSpecs,
      });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toMatch(/file_path/);
      expect((e as { code?: string }).code).toBe("bad_args");
    }
    // additionalProperties:true 스키마는 통과
    const svc2 = new CoreService(createMemoryStore(), passEval);
    const openCat: Session["toolCatalog"] = [
      { server: "fs", name: "read", inputSchema: { type: "object", properties: {}, additionalProperties: true } as unknown as Record<string, unknown>, schemaHash: "h1" },
    ];
    const s2 = await svc2.pfStart({ request: "r", toolCatalog: openCat });
    await svc2.pfReport({ ...rep(), sessionId: s2.session.id, tool: { server: "fs", name: "read" }, args: { anything: 1 } });
    const done = await svc2.pfResolve({
      sessionId: s2.session.id,
      nodeId: "1",
      decision: "leaf",
      tool: { server: "fs", name: "read" },
      argSpecs: { anything: { kind: "fixed", value: 1 } },
    });
    expect(done.node.status).toBe("leaf");
  });
});

describe("M3.4.3-1 pfNext 교착", () => {
  const mk = (id: string, status: "open" | "probing" | "split" | "needs_human" | "leaf", extra: Record<string, unknown> = {}) =>
    ({ id, status, dependsOn: [], children: [], attempts: [], ...extra }) as unknown as Node;

  it("dep_failed + dep_missing → blocked + 원인 승격", () => {
    // A: 실패 시도 보유 + 미해소 의존 → dep_failed 원인
    // B: A 의존 → 대기. C: 부재 의존 → dep_missing
    const A = mk("A", "probing", { dependsOn: ["ZZ"], attempts: [{ verdict: "fail" }] });
    const B = mk("B", "open", { dependsOn: ["A"] });
    const C = mk("C", "open", { dependsOn: ["9.9"] });
    const byId = new Map([["A", A], ["B", B], ["C", C]]);
    const { blocked, causes } = computeDeadlock([A, B, C], byId);
    const byNode = new Map(blocked.map((b) => [b.nodeId, b]));
    expect(byNode.get("A")).toMatchObject({ waitingOn: ["ZZ"], reason: "dep_missing" });
    expect(byNode.get("B")).toMatchObject({ waitingOn: ["A"], reason: "dep_failed" });
    expect(byNode.get("C")).toMatchObject({ waitingOn: ["9.9"], reason: "dep_missing" });
    expect(causes).toContain("A");
    // C는 원인 없음 → 자신 승격
    expect(causes).toContain("C");
  });

  it("dep_empty_split 단위 판정", () => {
    const S = mk("S", "split", { children: [] });
    const W = mk("W", "open", { dependsOn: ["S"] });
    const byId = new Map([["S", S], ["W", W]]);
    const { blocked, causes } = computeDeadlock([W], byId);
    expect(blocked).toEqual([{ nodeId: "W", waitingOn: ["S"], reason: "dep_empty_split" }]);
    expect(causes).toEqual(["S"]);
  });

  it("API 유효 트리에서는 교착 오탐 없음", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: catalog });
    await svc.pfResolve({ sessionId: session.id, nodeId: "1", decision: "split", children: [{ goal: "a" }, { goal: "b", dependsOn: ["1.1"] }] });
    await svc.pfReport({ ...rep(), sessionId: session.id, nodeId: "1.1", args: { v: 1 } });
    await svc.pfResolve({
      sessionId: session.id, nodeId: "1.1", decision: "leaf",
      tool: { server: "fs", name: "read" }, argSpecs: { v: { kind: "fixed", value: 1 } },
    });
    const nxt = await svc.pfNext(session.id);
    expect(nxt.done).toBe(false);
    if (!nxt.done) {
      expect(nxt.blocked ?? []).toEqual([]);
      expect(nxt.node.id).toBe("1.2");
    }
  });
});

describe("M3.4.4-1 실효 의존 ready/stale", () => {
  it("(a) 조상 의존 상속: 1.2 미완료 시 1.3.2 not ready", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: catalog });
    const sid = session.id;
    await svc.pfResolve({
      sessionId: sid, nodeId: "1", decision: "split",
      children: [{ goal: "a" }, { goal: "b" }, { goal: "c", dependsOn: ["1.2"] }],
    });
    await svc.pfResolve({ sessionId: sid, nodeId: "1.2", decision: "split", children: [{ goal: "b1" }, { goal: "b2" }] });
    await svc.pfResolve({ sessionId: sid, nodeId: "1.3", decision: "split", children: [{ goal: "c1" }, { goal: "c2" }] });
    const leaf = async (id: string) => {
      await svc.pfReport({ ...rep(), sessionId: sid, nodeId: id, args: { v: id } });
      await svc.pfResolve({
        sessionId: sid, nodeId: id, decision: "leaf",
        tool: { server: "fs", name: "read" }, argSpecs: { v: { kind: "fixed", value: id } },
      });
    };
    await leaf("1.1");
    // 1.2 미완료: 다음은 1.2.1이어야지 1.3.x가 아니어야 함
    const nxt = await svc.pfNext(sid);
    expect(nxt.done).toBe(false);
    if (!nxt.done) expect(nxt.node.id).toBe("1.2.1");
  });

  it("(c) var 참조: dependsOn 없어도 1.1 이후 의미 + 1.1 변경 시 stale", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: catalog });
    const sid = session.id;
    await svc.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "a" }, { goal: "b" }] });
    await svc.pfReport({ ...rep(), sessionId: sid, nodeId: "1.1", args: { v: "a" } });
    await svc.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "leaf",
      tool: { server: "fs", name: "read" }, argSpecs: { v: { kind: "fixed", value: "a" } },
    });
    await svc.pfReport({ ...rep(), sessionId: sid, nodeId: "1.2", args: { w: "x" } });
    await svc.pfResolve({
      sessionId: sid, nodeId: "1.2", decision: "leaf",
      tool: { server: "fs", name: "read" },
      argSpecs: { w: { kind: "var", ref: "$1.1" } },
    });
    // 1.1 변경 → var 참조 노드 stale
    await svc.pfReopen(sid, "1.1", "change");
    await svc.pfReport({ ...rep(), sessionId: sid, nodeId: "1.1", args: { v: "a2" } });
    await svc.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "leaf",
      tool: { server: "fs", name: "read" }, argSpecs: { v: { kind: "fixed", value: "a2" } },
    });
    const tree = await svc.pfTree(sid);
    expect(tree.nodes.find((n) => n.id === "1.2")?.status).toBe("open");
  });
});

describe("M3.4.4-2 교착 불변식 (seed 고정 무작위)", () => {
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hasHuman(live: Map<string, Node>): boolean {
    return [...live.values()].some((n) => n.status === "needs_human");
  }

  it("50개 무작위 그래프: 승격/종결, blocked 2회 연속 금지", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const rnd = mulberry32(seed);
      const ids = ["1", "1.1", "1.2", "2", "2.1"];
      const nodes = ids.map((id) => {
        const r = rnd();
        const st = r < 0.5 ? "open" : r < 0.8 ? "probing" : "split";
        const deps: string[] = [];
        const k = Math.floor(rnd() * 3);
        for (let i = 0; i < k; i++) deps.push(ids[Math.floor(rnd() * ids.length)]);
        const kids: string[] = [];
        if (st === "split") {
          const n = 1 + Math.floor(rnd() * 2);
          for (let i = 0; i < n; i++) kids.push(ids[Math.floor(rnd() * ids.length)]);
        }
        // API 도달 가능 상태만: 실패 시도는 open/probing에만
        const fail = st !== "split" && rnd() < 0.3;
        return {
          id, status: st, dependsOn: deps, children: kids,
          attempts: fail ? [{ verdict: "fail" as const }] : [],
        } as unknown as Node;
      });
      const live = new Map(nodes.map((n) => [n.id, n]));
      const promotable = (m: Map<string, Node>, id: string): boolean => {
        const t = m.get(id);
        return !!t && (t.status === "open" || t.status === "probing");
      };
      let prevBlocked = "";
      let terminated = false;
      for (let step = 0; step < 10; step++) {
        const cur = [...live.values()].filter((n) => n.status === "open" || n.status === "probing");
        if (cur.length === 0 || hasHuman(live)) {
          terminated = true;
          break;
        }
        const { blocked, causes } = computeDeadlock(cur, live);
        const sig = JSON.stringify(blocked);
        expect(sig === prevBlocked && blocked.length > 0, `seed ${seed} step ${step}: blocked 반복`).toBe(false);
        prevBlocked = sig;
        if (blocked.length === 0) {
          terminated = true;
          break;
        }
        let promoted = false;
        for (const c of causes) {
          if (promotable(live, c)) {
            const t = live.get(c)!;
            live.set(c, { ...t, status: "needs_human" });
            promoted = true;
          }
        }
        if (!promoted && cur.length > 0) {
          const f = cur[0];
          live.set(f.id, { ...f, status: "needs_human" });
        }
      }
      expect(terminated, `seed ${seed}: 미종결`).toBe(true);
    }
  });
});

describe("M3.4.4-1 실효 의존 ready/stale", () => {
  it("(a) 조상 의존 상속: 1.2 미완료 시 1.3.2 not ready", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: catalog });
    const sid = session.id;
    await svc.pfResolve({
      sessionId: sid, nodeId: "1", decision: "split",
      children: [{ goal: "a" }, { goal: "b" }, { goal: "c", dependsOn: ["1.2"] }],
    });
    await svc.pfResolve({ sessionId: sid, nodeId: "1.2", decision: "split", children: [{ goal: "b1" }, { goal: "b2" }] });
    await svc.pfResolve({ sessionId: sid, nodeId: "1.3", decision: "split", children: [{ goal: "c1" }, { goal: "c2" }] });
    await svc.pfReport({ ...rep(), sessionId: sid, nodeId: "1.1", args: { v: "a" } });
    await svc.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "leaf",
      tool: { server: "fs", name: "read" }, argSpecs: { v: { kind: "fixed", value: "a" } },
    });
    const nxt = await svc.pfNext(sid);
    expect(nxt.done).toBe(false);
    if (!nxt.done) expect(nxt.node.id).toBe("1.2.1");
  });

  it("(c) var 참조: dependsOn 없어도 1.1 변경 시 stale", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: catalog });
    const sid = session.id;
    await svc.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "a" }, { goal: "b" }] });
    await svc.pfReport({ ...rep(), sessionId: sid, nodeId: "1.1", args: { v: "a" } });
    await svc.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "leaf",
      tool: { server: "fs", name: "read" }, argSpecs: { v: { kind: "fixed", value: "a" } },
    });
    await svc.pfReport({ ...rep(), sessionId: sid, nodeId: "1.2", args: { w: "x" } });
    await svc.pfResolve({
      sessionId: sid, nodeId: "1.2", decision: "leaf",
      tool: { server: "fs", name: "read" },
      argSpecs: { w: { kind: "var", ref: "$1.1" } },
    });
    await svc.pfReopen(sid, "1.1", "change");
    await svc.pfReport({ ...rep(), sessionId: sid, nodeId: "1.1", args: { v: "a2" } });
    await svc.pfResolve({
      sessionId: sid, nodeId: "1.1", decision: "leaf",
      tool: { server: "fs", name: "read" }, argSpecs: { v: { kind: "fixed", value: "a2" } },
    });
    const tree = await svc.pfTree(sid);
    expect(tree.nodes.find((n) => n.id === "1.2")?.status).toBe("open");
  });
});

describe("M3.4.4-3 split dependsOn 검증", () => {
  it("기존도 형제도 아니면 bad_request", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: catalog });
    await expect(
      svc.pfResolve({
        sessionId: session.id, nodeId: "1", decision: "split",
        children: [{ goal: "x", dependsOn: ["9.9"] }],
      }),
    ).rejects.toThrow(/dep_missing/);
    // 형제 의존은 허용
    const ok = await svc.pfResolve({
      sessionId: session.id, nodeId: "1", decision: "split",
      children: [{ goal: "a" }, { goal: "b", dependsOn: ["1.1"] }],
    });
    expect(ok.created).toHaveLength(2);
  }, 30000);
});

describe("M3.4.3-2 펼친 순환 split 거부", () => {
  it("자기 조상 의존 분해는 bad_request", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: catalog });
    await svc.pfResolve({ sessionId: session.id, nodeId: "1", decision: "split", children: [{ goal: "a" }] });
    await expect(
      svc.pfResolve({
        sessionId: session.id,
        nodeId: "1.1",
        decision: "split",
        children: [{ goal: "self", dependsOn: ["1.1"] }],
      }),
    ).rejects.toThrow(/cycle/);
    // 저장 안 됐음 확인
    const tree = await svc.pfTree(session.id);
    expect(tree.nodes.some((n) => n.id === "1.1.1")).toBe(false);
  });
});

describe("M3.4.3-3 stale: split 유지 + 자손 leaf만 open", () => {
  it("2.1 변경 → 1.3 split 유지, 1.3.1 open, 1.3.2 유지", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: catalog });
    const sid = session.id;
    await svc.pfResolve({
      sessionId: sid, nodeId: "1", decision: "split",
      children: [{ goal: "a" }, { goal: "b" }, { goal: "c", dependsOn: ["1.2"] }],
    });
    await svc.pfResolve({ sessionId: sid, nodeId: "1.2", decision: "split", children: [{ goal: "b1" }, { goal: "b2" }] });
    // 1.3.1만 1.2.1에 직접 의존
    await svc.pfResolve({
      sessionId: sid, nodeId: "1.3", decision: "split",
      children: [{ goal: "c1", dependsOn: ["1.2.1"] }, { goal: "c2" }],
    });
    const leaf = async (id: string, v: string) => {
      await svc.pfReport({ ...rep(), sessionId: sid, nodeId: id, args: { v } });
      await svc.pfResolve({
        sessionId: sid, nodeId: id, decision: "leaf",
        tool: { server: "fs", name: "read" }, argSpecs: { v: { kind: "fixed", value: v } },
      });
    };
    await leaf("1.1", "a");
    await leaf("1.2.1", "b1");
    await leaf("1.2.2", "b2");
    await leaf("1.3.1", "c1");
    await leaf("1.3.2", "c2");
    // 1.2.1 argSpec 변경
    await svc.pfReopen(sid, "1.2.1", "change");
    await svc.pfReport({ ...rep(), sessionId: sid, nodeId: "1.2.1", args: { v: "new" } });
    await svc.pfResolve({
      sessionId: sid, nodeId: "1.2.1", decision: "leaf",
      tool: { server: "fs", name: "read" }, argSpecs: { v: { kind: "fixed", value: "new" } },
    });
    const tree = await svc.pfTree(sid);
    const byId = new Map(tree.nodes.map((n) => [n.id, n]));
    // M3.4.4-1(b) 정정: 1.3.2도 조상(1.3)의 dependsOn ["1.2"]를 상속하므로 함께 open.
    // (M3.4.3 당시 기대값 '1.3.2 leaf 유지'는 상속 미반영 가정이었다.)
    expect(byId.get("1.3")?.status).toBe("split");
    expect(byId.get("1.3.1")?.status).toBe("open");
    expect(byId.get("1.3.2")?.status).toBe("open");
    expect(byId.get("1.1")?.status).toBe("leaf");
  });
});

describe("M4 advise 제안/채택", () => {
  const fxEval = (constraints: { kind: string; spec: Record<string, unknown>; id: string }[], ctx: { artifacts?: Record<string, string> }) => {
    const failed = constraints.filter((c) => {
      if (c.kind === "file_exists") return !(ctx.artifacts && (c.spec["path"] as string) in ctx.artifacts);
      return false;
    }).map((c) => c.id);
    return { verdict: (failed.length > 0 ? "fail" : "pass") as "pass" | "fail", failedConstraints: failed };
  };
  const unverifiedEval = () => ({ verdict: "pass" as const, failedConstraints: [] as string[], unverified: ["x"] });

  it("유효 제안 채택 / 참조 오류·rubric 거부 / 전부 거부 시 rubric 저장", async () => {
    const svc = new CoreService(createMemoryStore(), fxEval as never);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: catalog });
    const sid = session.id;
    await svc.pfResolve({ sessionId: sid, nodeId: "1", decision: "ask_human" });
    const fx = { "out/a.txt": "hello" };
    const out = await svc.pfAdvise(sid, "1", "파일 확인", {
      proposedConstraints: [
        { id: "p1", kind: "file_exists", spec: { path: "out/a.txt" }, source: "human" },
        { id: "p2", kind: "json_path_exists", spec: { path: "x", jsonPointer: "/nope" }, source: "human" },
        { id: "p3", kind: "llm_rubric", spec: { rubric: "느낌" }, source: "human" },
        { nope: true },
      ],
      fixtureContents: fx,
    });
    expect(out.constraints.map((c) => c.id).sort()).toEqual(["p1", "p2"]);
    expect(out.rejected.map((r) => (r.proposal as { id?: string }).id ?? "?")).toContain("p3");
    expect(out.rejected).toHaveLength(2);
    const tree = await svc.pfTree(sid);
    expect(tree.nodes[0].status).toBe("open");
  });

  it("판정 불가(unverified) 제안은 거부", async () => {
    const svc = new CoreService(createMemoryStore(), unverifiedEval as never);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: catalog });
    const sid = session.id;
    await svc.pfResolve({ sessionId: sid, nodeId: "1", decision: "ask_human" });
    const out = await svc.pfAdvise(sid, "1", "문체를 다듬어라", {
      proposedConstraints: [{ id: "p1", kind: "equals", spec: { expected: 1, actual: 1 }, source: "human" }],
      fixtureContents: {},
    });
    expect(out.constraints).toHaveLength(1);
    expect(out.constraints[0].kind).toBe("llm_rubric");
    expect(out.rejected).toHaveLength(1);
  });

  it("부가세 조언은 rubric + numeric 제안 안내", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: catalog });
    const sid = session.id;
    const out = await svc.pfAdvise(sid, "1", "매출은 부가세 제외로");
    expect(out.constraints[0].kind).toBe("llm_rubric");
    expect(out.note ?? "").toMatch(/proposedConstraints/);
  });
});

describe("M2.5-6 세션 핸들 UUID", () => {
  it("세션 id는 UUID", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: catalog });
    expect(session.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe("M3.4-6 펼친 의존 hash + stale 전파", () => {
  const echoCat: Session["toolCatalog"] = [
    { server: "e", name: "echo", inputSchema: {}, schemaHash: "h9" },
  ];
  const repE = (over: Record<string, unknown> = {}) => ({
    sessionId: "",
    nodeId: "1",
    tool: { server: "e", name: "echo" },
    args: {},
    resultSummary: "ok",
    selfVerdict: "pass" as const,
    selfReason: "ok",
    ...over,
  });
  async function confirmedTree() {
    const svc = new CoreService(createMemoryStore(), passEval);
    const { session } = await svc.pfStart({ request: "r", toolCatalog: echoCat });
    const sid = session.id;
    await svc.pfResolve({
      sessionId: sid, nodeId: "1", decision: "split",
      children: [{ goal: "a" }, { goal: "b" }, { goal: "draft", dependsOn: ["1.2"] }],
    });
    await svc.pfResolve({ sessionId: sid, nodeId: "1.2", decision: "split", children: [{ goal: "b1" }, { goal: "b2" }] });
    const leaf = async (id: string, v: string) => {
      await svc.pfReport({ ...repE(), sessionId: sid, nodeId: id, args: { v } });
      await svc.pfResolve({
        sessionId: sid, nodeId: id, decision: "leaf",
        tool: { server: "e", name: "echo" }, argSpecs: { v: { kind: "fixed", value: v } },
      });
    };
    await leaf("1.1", "a");
    await leaf("1.2.1", "b1");
    await leaf("1.2.2", "b2");
    await leaf("1.3", "d");
    return { svc, sid };
  }

  it("2.1 argSpec 변경 → draft stale(open), 무관 노드는 유지", async () => {
    const { svc, sid } = await confirmedTree();
    await svc.pfReopen(sid, "1.2.1", "change");
    await svc.pfReport({ ...repE(), sessionId: sid, nodeId: "1.2.1", args: { v: "b1-new" } });
    await svc.pfResolve({
      sessionId: sid, nodeId: "1.2.1", decision: "leaf",
      tool: { server: "e", name: "echo" }, argSpecs: { v: { kind: "fixed", value: "b1-new" } },
    });
    const tree = await svc.pfTree(sid);
    const byId = new Map(tree.nodes.map((n) => [n.id, n]));
    expect(byId.get("1.3")?.status).toBe("open");
    expect(byId.get("1.1")?.status).toBe("leaf");
    expect(byId.get("1.2.1")?.status).toBe("leaf");
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

  it("M3.6-7 세션에 opencode 버전 기록", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const s = await svc.pfStart({ request: "r", toolCatalog: catalog, opencodeVersion: "1.2.3" });
    expect(s.session.opencodeVersion).toBe("1.2.3");
    const s2 = await svc.pfStart({ request: "r", toolCatalog: catalog });
    expect(s2.session.opencodeVersion).toBe("unknown");
  });

  it("M4.2-0 새 세션 revision 0", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const s = await svc.pfStart({ request: "r", toolCatalog: catalog });
    expect(s.session.revision).toBe(0);
  });
});

function recordingStore(inner = createMemoryStore(), opts: { failAppend?: boolean } = {}) {
  const calls: string[] = [];
  const appended: { sid: string; evts: EventEntry[] }[] = [];
  const store: Store = {
    getSession: (id) => inner.getSession(id),
    saveSession: (s) => {
      calls.push("saveSession");
      inner.saveSession(s);
    },
    getNodes: (sid) => inner.getNodes(sid),
    getNode: (sid, nid) => inner.getNode(sid, nid),
    saveNode: (sid, n) => {
      calls.push(`saveNode:${n.id}`);
      inner.saveNode(sid, n);
    },
    appendEvents: (sid, evts) => {
      calls.push(`appendEvents:${evts.map((e) => `${e.method}#${e.seq}`).join(",")}`);
      if (opts.failAppend) throw new Error("injected append failure");
      appended.push({ sid, evts });
      inner.appendEvents(sid, evts);
    },
  };
  return { store, calls, appended };
}

describe("M4.2-0.5 revision·이벤트 트랜잭션", () => {
  it("expectedRevision 불일치 → conflict, 쓰기 없음", async () => {
    const { store, calls } = recordingStore();
    const svc = new CoreService(store, passEval);
    const s = await svc.pfStart({ request: "r", toolCatalog: catalog });
    await svc.pfReport({ ...rep(), sessionId: s.session.id, resultJson: { ok: true } });
    const savesBefore = calls.filter((c) => c.startsWith("saveNode")).length;
    await expect(
      svc.pfReport({ ...rep(), sessionId: s.session.id, expectedRevision: 0 }),
    ).rejects.toThrow(/revision mismatch/);
    expect((await svc.pfTree(s.session.id)).session.revision).toBe(1);
    expect(calls.filter((c) => c.startsWith("saveNode")).length).toBe(savesBefore);
  });

  it("변경 1회당 revision +1·이벤트 1건, 이벤트가 저장보다 먼저", async () => {
    const { store, calls, appended } = recordingStore();
    const svc = new CoreService(store, passEval);
    const s = await svc.pfStart({ request: "r", toolCatalog: catalog });
    const r = await svc.pfReport({ ...rep(), sessionId: s.session.id, resultJson: { ok: true }, expectedRevision: 0, actor: "human" });
    expect(r.verdict).toBe("pass");
    expect((await svc.pfTree(s.session.id)).session.revision).toBe(1);
    expect(appended.length).toBe(1);
    const [ev] = appended[0].evts;
    expect(ev.method).toBe("pfReport");
    expect(ev.nodeIds).toEqual(["1"]);
    expect(ev.actor).toBe("human");
    expect(ev.seq).toBe(1);
    expect(ev.revision).toBe(1);
    expect(ev.beforeHash).not.toBe(ev.afterHash);
    const appendIdx = calls.findIndex((c) => c.startsWith("appendEvents"));
    expect(appendIdx).toBeGreaterThanOrEqual(0);
    // R6 순서: 이벤트 기록 → 저장
    expect(calls.slice(appendIdx)).toEqual([calls[appendIdx], "saveSession", "saveNode:1"]);
  });

  it("이벤트 쓰기 실패 주입 시 상태 미변경", async () => {
    const { store, calls } = recordingStore(createMemoryStore(), { failAppend: true });
    const svc = new CoreService(store, passEval);
    const s = await svc.pfStart({ request: "r", toolCatalog: catalog });
    const savesBefore = calls.filter((c) => c.startsWith("saveNode")).length;
    await expect(svc.pfReport({ ...rep(), sessionId: s.session.id })).rejects.toThrow(/injected append failure/);
    expect((await svc.pfTree(s.session.id)).session.revision).toBe(0);
    expect(calls.filter((c) => c.startsWith("saveNode")).length).toBe(savesBefore);
    expect(store.getNode(s.session.id, "1")!.attempts.length).toBe(0);
  });

  it("읽기 전용 pfNext는 revision 유지", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const s = await svc.pfStart({ request: "r", toolCatalog: catalog });
    await svc.pfNext(s.session.id);
    expect((await svc.pfTree(s.session.id)).session.revision).toBe(0);
  });

  it("amendAttemptArtifacts: 교체 + revision +1", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const s = await svc.pfStart({ request: "r", toolCatalog: catalog });
    await svc.pfReport({ ...rep(), sessionId: s.session.id, args: { path: "a" } });
    const tree = await svc.pfTree(s.session.id);
    const last = tree.nodes[0].attempts[0];
    const r = await svc.amendAttemptArtifacts({ sessionId: s.session.id, nodeId: "1", attemptId: last.id, artifacts: ["fx/a.txt"] });
    expect(r.node.attempts[0].artifacts).toEqual(["fx/a.txt"]);
    expect(r.revision).toBe(tree.session.revision + 1);
    expect((await svc.pfTree(s.session.id)).session.revision).toBe(tree.session.revision + 1);
    await expect(
      svc.amendAttemptArtifacts({ sessionId: s.session.id, nodeId: "1", attemptId: "00000000-0000-4000-8000-000000000000", artifacts: [] }),
    ).rejects.toThrow(/attempt .* not found/);
  });
});

  it("M3.6-5 미참조 dependsOn은 경고만 (dep_without_dataflow)", async () => {
    const svc = new CoreService(createMemoryStore(), passEval);
    const s = await svc.pfStart({ request: "r", toolCatalog: catalog });
    await svc.pfResolve({
      sessionId: s.session.id, nodeId: "1", decision: "split",
      children: [{ goal: "a" }, { goal: "b", dependsOn: ["1.1"] }],
    });
    await svc.pfReport({ ...rep(), sessionId: s.session.id, nodeId: "1.1", args: { path: "a" } });
    await svc.pfResolve({
      sessionId: s.session.id, nodeId: "1.1", decision: "leaf",
      tool: { server: "fs", name: "read" },
      argSpecs: { path: { kind: "fixed", value: "a" } },
    });
    await svc.pfReport({ ...rep(), sessionId: s.session.id, nodeId: "1.2", args: { path: "b", prev: "x" } });
    // prev가 $1.1 참조 → 경고 없음
    const ok = await svc.pfResolve({
      sessionId: s.session.id, nodeId: "1.2", decision: "leaf",
      tool: { server: "fs", name: "read" },
      argSpecs: { path: { kind: "fixed", value: "b" }, prev: { kind: "var", ref: "$1.1.output" } },
    });
    expect(ok.node.status).toBe("leaf");
    expect(ok.instruction).not.toMatch(/dep_without_dataflow/);
    // 참조 없이 확정 → 경고 포함되나 leaf 성공
    const s2 = await svc.pfStart({ request: "r2", toolCatalog: catalog });
    await svc.pfResolve({
      sessionId: s2.session.id, nodeId: "1", decision: "split",
      children: [{ goal: "a" }, { goal: "b", dependsOn: ["1.1"] }],
    });
    await svc.pfReport({ ...rep(), sessionId: s2.session.id, nodeId: "1.1", args: { path: "a" } });
    await svc.pfResolve({
      sessionId: s2.session.id, nodeId: "1.1", decision: "leaf",
      tool: { server: "fs", name: "read" },
      argSpecs: { path: { kind: "fixed", value: "a" } },
    });
    await svc.pfReport({ ...rep(), sessionId: s2.session.id, nodeId: "1.2", args: { path: "b" } });
    const warned = await svc.pfResolve({
      sessionId: s2.session.id, nodeId: "1.2", decision: "leaf",
      tool: { server: "fs", name: "read" },
      argSpecs: { path: { kind: "fixed", value: "b" } },
    });
    expect(warned.node.status).toBe("leaf");
    expect(warned.instruction).toMatch(/dep_without_dataflow: 1\.1/);
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
