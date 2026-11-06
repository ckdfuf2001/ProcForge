import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createUiServer, type UiServer } from "../src/app/ui-server.js";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

useTmpCleanup();

// M10-3-e2e: M10 확인 화면 데이터 완결성 (HTTP 경유).
// tree(why 포함) + events(4종) + similar(session) + draft 조회·적용 + run phase.

const CAT = [
  { server: "t", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;

let root: string;
let pfdir: string;
let app: ProcForgeApp;
let srv: UiServer;

beforeEach(async () => {
  root = makeTmp("pf-m103gd-");
  pfdir = join(root, ".procforge");
  const { client } = testStack(pfdir);
  app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
  srv = await createUiServer({ app, staticDir: makeTmp("pf-m103gde-") });
});

afterEach(async () => {
  await srv.close();
});

function h() {
  return {
    "content-type": "application/json",
    "x-procforge-token": srv.token,
  };
}

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${srv.url}${path}`, { headers: { "x-procforge-token": srv.token } });
  return { status: r.status, body: await r.json() };
}

async function postJson(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${srv.url}${path}`, { method: "POST", headers: h(), body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

describe("M10-3-e2e 확인 화면 데이터", () => {
  it("tree why → lane 이벤트 → 메모리 → 초안 적용 → run phase", async () => {
    // 1) 세션+분해(why 포함) → tree 행에 why가 그대로 온다 (그래프 카드 1줄).
    const s = await app.start({ request: "r", toolCatalog: CAT });
    const sid = s.sessionId;
    await app.split({
      sessionId: sid,
      nodeId: "1",
      reason: "분해 사유입니다 0123456789",
      children: [{ goal: "a", why: "나눈 이유 한 줄" }, { goal: "b" }],
    } as never);
    const tree = (await getJson(`/api/sessions/${sid}/tree`)).body as {
      nodes: { nodes: { id: string; goal: string; why: string | null }[] };
    };
    const row11 = tree.nodes.nodes.find((n) => n.id === "1.1");
    expect(row11?.why).toBe("나눈 이유 한 줄");

    // 2) 레인 이벤트 → 노드 이력에 method가 보인다 (레인 스트립 구동원).
    await app.notifySessionEvent({
      sessionId: sid,
      method: "lane.started",
      summary: "분석 레인 시작",
      nodeIds: ["1.1"],
    });
    const node = (await getJson(`/api/sessions/${sid}/nodes/1.1`)).body as {
      detail: { why: string | null };
      events: { method: string; summary: string }[];
    };
    expect(node.detail.why).toBe("나눈 이유 한 줄");
    expect(node.events.some((e) => e.method === "lane.started")).toBe(true);

    // 3) 왜 수정 → 200, 트리 재조회 없이 상세에 반영.
    const whyRes = await postJson(`/api/sessions/${sid}/nodes/1.1/why`, { why: "바꾼 이유" });
    expect(whyRes.status).toBe(200);
    const node2 = (await getJson(`/api/sessions/${sid}/nodes/1.1`)).body as {
      detail: { why: string | null };
    };
    expect(node2.detail.why).toBe("바꾼 이유");

    // 4) 메모리: 절차서 등록 후 similar+sessionId → memory.loaded 1건.
    const raw = JSON.stringify({
      format: "procforge-procedure",
      version: 1,
      name: "memo",
      sourceSession: "s",
      createdAt: new Date(0).toISOString(),
      params: {},
      toolCatalog: [],
      nodes: [{ id: "1", goal: "분석 작업", depth: 0 }],
    });
    mkdirSync(join(pfdir, "procedures", "memo"), { recursive: true });
    writeFileSync(join(pfdir, "procedures", "memo", "procedure.json"), raw);
    const sim = (await getJson(`/api/procedures/similar?query=${encodeURIComponent("분석")}&limit=5&sessionId=${sid}`)).body as {
      procedures: { name: string }[];
    };
    expect(sim.procedures.some((p) => p.name === "memo")).toBe(true);

    // 5) 초안 조회·적용: sourceHash 일치 시 200, 불일치 시 409.
    const hash = createHash("sha256").update(raw, "utf8").digest("hex");
    const draftId = "d1";
    mkdirSync(join(pfdir, "drafts", draftId), { recursive: true });
    writeFileSync(
      join(pfdir, "drafts", draftId, "draft.json"),
      JSON.stringify({
        draftId,
        procedure: "memo",
        request: "req",
        sourceHash: hash,
        status: "ready",
        ops: [{ op: "edit_goal", nodeId: "1", goal: "분석 작업 v2", reason: "다듬기" }],
        diff: [],
        reason: "r",
      }),
    );
    const draft = (await getJson(`/api/drafts/${draftId}`)).body as {
      procedure: string;
      ops: unknown[];
    };
    expect(draft.procedure).toBe("memo");
    expect(draft.ops.length).toBe(1);
    const applied = await postJson(`/api/drafts/${draftId}/apply`, { opIds: [0] });
    expect(applied.status).toBe(200);

    // 6) run phase: 실행 시작 로그에 phase 마커 (실시간 로그 구동원).
    const dir = join(pfdir, "procedures", "demo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "procedure.json"),
      JSON.stringify({
        format: "procforge-procedure",
        version: 1,
        name: "demo",
        sourceSession: "11111111-1111-4111-8111-111111111111",
        createdAt: new Date(0).toISOString(),
        params: {},
        toolCatalog: CAT,
        tree: { rootId: "1", nodes: [] },
        nodes: [],
      }),
    );
    const run = await app.uiRun({ procedure: "demo", params: {} });
    const log = await app.uiRunLog({ runId: run.runId });
    expect(log.entries[0].message).toContain("phase:started");
    await app.uiRunCancel({ runId: run.runId });
  }, 30000);
});
