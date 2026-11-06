import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup, settleRun } from "./tmp-hooks.js";

useTmpCleanup();

// M10-3-events: 부족한 이벤트 4종 (lane.started/finished, run.phase,
// memory.loaded, draft.ready). 세션 3종은 pfNotify 경유 revision+1,
// run.phase는 실행 로그 `phase:` 마커로 SSE에 탄다.

const CAT = [
  { server: "t", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;

let root: string;
let pfdir: string;
let app: ProcForgeApp;

beforeEach(() => {
  root = makeTmp("pf-m103ev-");
  pfdir = join(root, ".procforge");
  const { client } = testStack(pfdir);
  app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
});

const liveRuns: { app: ProcForgeApp; pfdir: string; runId: string }[] = [];
afterEach(async () => {
  for (const t of liveRuns.splice(0)) await settleRun(t.app, t.pfdir, t.runId);
}, 30000);

async function startSession() {
  const s = await app.start({ request: "r", toolCatalog: CAT });
  return s.sessionId;
}

describe("M10-3-events pfNotify", () => {
  it("① 4종 method가 events에 남고 revision이 1씩 오른다", async () => {
    const sid = await startSession();
    const r0 = (await app.getBlocked({ sessionId: sid })).revision;
    const methods = [
      "lane.started",
      "lane.finished",
      "memory.loaded",
      "draft.ready",
    ] as const;
    for (let i = 0; i < methods.length; i++) {
      const out = await app.notifySessionEvent({
        sessionId: sid,
        method: methods[i],
        summary: `알림 ${i}`,
      });
      expect(out.revision).toBe(r0 + i + 1);
      expect(out.changedNodeIds).toEqual([]);
    }
    const page = await app.getEventsPage({ sessionId: sid, afterRevision: r0 });
    expect(page.events.map((e) => e.method)).toEqual([...methods]);
    for (let i = 0; i < methods.length; i++) {
      const e = page.events[i];
      expect(e.seq).toBe(r0 + i + 1);
      expect(e.revision).toBe(r0 + i + 1);
      expect(e.summary).toBe(`알림 ${i}`);
    }
    expect(page.lastRevision).toBe(r0 + methods.length);
  });

  it("② nodeIds 귀속: 노드 이력 필터에 보이고 트리는 그대로", async () => {
    const sid = await startSession();
    await app.split({
      sessionId: sid,
      nodeId: "1",
      reason: "분해 사유입니다 0123456789",
      children: [{ goal: "a" }],
    } as never);
    const before = await app.nodeDetail({ sessionId: sid, nodeId: "1.1" });
    const out = await app.notifySessionEvent({
      sessionId: sid,
      method: "lane.started",
      summary: "분석 레인 시작",
      nodeIds: ["1.1"],
      reason: "분석",
    });
    expect(out.changedNodeIds).toEqual(["1.1"]);
    // 노드 내용은 그대로 (goal·status 불변).
    const after = await app.nodeDetail({ sessionId: sid, nodeId: "1.1" });
    expect(after.goal).toBe(before.goal);
    expect(after.status).toBe(before.status);
    // 노드 이력 필터에 알림이 보인다.
    const evs = await app.getEventsPage({
      sessionId: sid,
      nodeId: "1.1",
      afterRevision: 0,
      limit: 200,
      tail: true,
    });
    const found = evs.events.filter((e) => e.method === "lane.started");
    expect(found.length).toBe(1);
    expect(found[0].summary).toBe("분석 레인 시작");
  });

  it("③ 거부: unknown method·빈 summary·없는 세션·revision 충돌", async () => {
    const sid = await startSession();
    await expect(
      app.notifySessionEvent({
        sessionId: sid,
        method: "nope.event",
        summary: "x",
      } as never),
    ).rejects.toThrow(/알 수 없는 알림/);
    await expect(
      app.notifySessionEvent({ sessionId: sid, method: "lane.started", summary: "  " }),
    ).rejects.toThrow(/summary/);
    await expect(
      app.notifySessionEvent({
        sessionId: "00000000-0000-4000-8000-000000000000",
        method: "lane.started",
        summary: "x",
      }),
    ).rejects.toThrow(/세션/);
    await expect(
      app.notifySessionEvent({
        sessionId: sid,
        method: "lane.started",
        summary: "x",
        expectedRevision: 9999,
      }),
    ).rejects.toThrow(/revision mismatch/);
    // 거부된 호출은 revision을 올리지 않는다.
    expect((await app.getBlocked({ sessionId: sid })).revision).toBe(0);
  });
});

describe("M10-3-events 연결 고리", () => {
  it("④ similarProcedures+sessionId → memory.loaded, 없으면 조용", async () => {
    const sid = await startSession();
    const r0 = (await app.getBlocked({ sessionId: sid })).revision;
    await app.similarProcedures({ query: "분석", sessionId: sid });
    const page = await app.getEventsPage({ sessionId: sid, afterRevision: r0 });
    expect(page.events.map((e) => e.method)).toEqual(["memory.loaded"]);
    expect(page.events[0].summary).toMatch(/memory loaded/);
    // sessionId 없으면 이벤트 없음 (읽기 전용 유지).
    const r1 = page.lastRevision;
    await app.similarProcedures({ query: "분석" });
    expect((await app.getBlocked({ sessionId: sid })).revision).toBe(r1);
  });

  it("⑤ createRedraft 실패(OpenCode 없음)는 draft.ready 없이 거부", async () => {
    const sid = await startSession();
    const r0 = (await app.getBlocked({ sessionId: sid })).revision;
    await expect(
      app.createRedraft({ procedure: "demo", request: "req", sessionId: sid }),
    ).rejects.toThrow(/OpenCode|기본 모델/);
    expect((await app.getBlocked({ sessionId: sid })).revision).toBe(r0);
  });

  it("⑥ run.phase: 시작 로그에 phase:started, 종료에 phase:done/failed", async () => {
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
        params: { month: { type: "string", description: "월" } },
        toolCatalog: CAT,
        tree: { rootId: "1", nodes: [] },
        nodes: [],
      }),
    );
    const run = await app.uiRun({ procedure: "demo", params: { month: "2026-10" } });
    liveRuns.push({ app, pfdir, runId: run.runId });
    const first = await app.uiRunLog({ runId: run.runId });
    expect(first.entries[0].message).toContain("phase:started");
    // 백그라운드 종료까지 대기 (최대 10초) 후 종료 마커 확인.
    let last = first;
    for (let i = 0; i < 100; i++) {
      last = await app.uiRunLog({ runId: run.runId });
      if (last.status === "done" || last.status === "failed") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(["done", "failed"]).toContain(last.status);
    expect(
      last.entries.some((e) => e.message.includes(`(phase:${last.status})`)),
    ).toBe(true);
  });
});
