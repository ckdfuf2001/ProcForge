import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createUiServer } from "../src/app/ui-server.js";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { readEvents } from "../src/trace.js";

// M7-ui4: previewEdit 무쓰기·409 흐름·actor:"ui"·신호 실패에도 저장 유지.

const catalog = [
  { server: "t", name: "read", inputSchema: { type: "object" }, schemaHash: "h" },
];

let pfdir: string;
beforeEach(() => {
  pfdir = join(mkdtempSync(join(tmpdir(), "pf-ui4-")), ".procforge");
});

async function started() {
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: pfdir });
  const s = await app.start({ request: "r", toolCatalog: catalog as never });
  await app.split({
    sessionId: s.sessionId,
    nodeId: "1",
    children: [{ goal: "a" }, { goal: "b" }],
    expectedRevision: 0,
  });
  // 1.1 → 1.2 의존을 만든다 (편집 전파 확인용)
  await app.editNode({
    sessionId: s.sessionId,
    nodeId: "1.1",
    dependsOn: ["1.2"],
    expectedRevision: (await app.readSession(s.sessionId)).revision,
  });
  return { app, sid: s.sessionId };
}

function json(srv: { url: string; token: string }, path: string, body: unknown) {
  return fetch(`${srv.url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-procforge-token": srv.token,
    },
    body: JSON.stringify(body),
  });
}

describe("M7-ui4 core.previewEdit", () => {
  it("무쓰기: 저장소 바이트 불변 + wouldStale 계산", async () => {
    const { app, sid } = await started();
    const sf = join(pfdir, "sessions", sid, "session.json");
    const before = existsSync(sf) ? readFileSync(sf, "utf8") : "";
    const mt = existsSync(sf) ? statSync(sf).mtimeMs : 0;
    const r = await app.previewEdit({
      sessionId: sid,
      nodeId: "1.2",
      change: { goal: "b 바뀜" },
    });
    // 1.2 를 dependsOn 하는 하류 = 1.1
    expect(r.wouldStale).toContain("1.1");
    expect(r.newHash).toMatch(/^[0-9a-f]/);
    // 저장소는 그대로
    if (existsSync(sf)) {
      expect(readFileSync(sf, "utf8")).toBe(before);
      expect(statSync(sf).mtimeMs).toBe(mt);
    }
    // 실제 저장 후에는 동일 노드가 stale 표시된다
    const rev = (await app.readSession(sid)).revision;
    await app.uiEditNode({
      sessionId: sid,
      nodeId: "1.2",
      goal: "b 바뀜",
      expectedRevision: rev,
    });
    expect((await app.readNode(sid, "1.1")).staleSince).toBeDefined();
  }, 30000);

  it("잠긴 노드·빈 변경 거부", async () => {
    const { app, sid } = await started();
    await expect(
      app.previewEdit({ sessionId: sid, nodeId: "1.1", change: {} }),
    ).rejects.toThrow();
    await app.lock({ sessionId: sid, nodeId: "1.1" });
    await expect(
      app.previewEdit({
        sessionId: sid,
        nodeId: "1.1",
        change: { goal: "x" },
      }),
    ).rejects.toThrow();
  }, 30000);
});

describe("M7-ui4 UI 쓰기 API", () => {
  it("POST+JSON만·expectedRevision 필수·actor ui", async () => {
    const { app, sid } = await started();
    const srv = await createUiServer({ app });
    try {
      const rev = (await app.readSession(sid)).revision;
      // 1) GET으로는 못 쓴다
      expect(
        (await fetch(`${srv.url}/api/sessions/${sid}/edit-node`, {
          headers: { "x-procforge-token": srv.token },
        })).status,
      ).toBe(404);
      // 2) content-type 없으면 415
      const noCt = await fetch(`${srv.url}/api/sessions/${sid}/edit-node`, {
        method: "POST",
        headers: { "x-procforge-token": srv.token },
        body: "{}",
      });
      expect(noCt.status).toBe(415);
      // 3) expectedRevision 없으면 400
      const noRev = await json(srv, `/api/sessions/${sid}/edit-node`, {
        nodeId: "1",
        goal: "x",
      });
      expect(noRev.status).toBe(400);
      // 4) 정상 저장 → calls.jsonl 에 actor "ui"
      const ok = await json(srv, `/api/sessions/${sid}/edit-node`, {
        nodeId: "1.1",
        goal: "a 새 목표",
        expectedRevision: rev,
      });
      expect(ok.status).toBe(200);
      const calls = readEvents(pfdir, sid).filter((e) => e.actor === "ui");
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.some((c) => c.tool === "pf_edit_node")).toBe(true);
      expect(calls.some((c) => (c.connectionId ?? "").startsWith("ui-"))).toBe(true);
    } finally {
      srv.close();
    }
  }, 30000);

  it("409: 초안 유지 (자동 재시도 없음)", async () => {
    const { app, sid } = await started();
    const srv = await createUiServer({ app });
    try {
      const stale = 0; // 실제 revision보다 오래된 값
      const r = await json(srv, `/api/sessions/${sid}/edit-node`, {
        nodeId: "1.1",
        goal: "옛 값",
        expectedRevision: stale,
      });
      expect(r.status).toBe(409);
      // 상태는 그대로 (goal 미변경)
      expect((await app.readNode(sid, "1.1")).goal).toBe("a");
    } finally {
      srv.close();
    }
  }, 30000);

  it("의견 저장 후 신호 실패 → 저장분은 유지", async () => {
    const { app, sid } = await started();
    const srv = await createUiServer({ app });
    try {
      const rev = (await app.readSession(sid)).revision;
      // 연결 불가한 OpenCode (버전 미지정 → C)
      const r = await json(srv, `/api/sessions/${sid}/advise-and-signal`, {
        nodeId: "1.1",
        text: "Show HN 제외",
        expectedRevision: rev,
        link: {
          baseUrl: "http://127.0.0.1:1",
          openCodeSessionId: "oc-x",
          mode: "b",
        },
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as {
        advise: { constraints: unknown[] };
        signal: { delivered: boolean; degraded: string } | null;
      };
      // 신호는 실패하지만 저장은 됐다
      expect(body.signal?.delivered).toBe(false);
      expect(body.signal?.degraded).toMatch(/버전 미확인|전송 실패|미확인/);
      const node = await app.readNode(sid, "1.1");
      expect(node.advice.length).toBeGreaterThan(0);
      expect(node.constraints.length).toBeGreaterThan(0);
      const calls = readEvents(pfdir, sid).filter(
        (e) => e.actor === "ui" && e.tool === "pf_advise",
      );
      expect(calls.length).toBeGreaterThan(0);
    } finally {
      srv.close();
    }
  }, 30000);
});