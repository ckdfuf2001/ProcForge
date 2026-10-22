import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createUiServer } from "../src/app/ui-server.js";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";

// M7-ui3: 노드 상세 DTO·이벤트 필터·산출물(헤더 3종·경로 탈출·egress 0).

const catalog = [
  { server: "t", name: "read", inputSchema: { type: "object" }, schemaHash: "h" },
];

let pfdir: string;
beforeEach(() => {
  pfdir = join(mkdtempSync(join(tmpdir(), "pf-ui3-")), ".procforge");
});

async function started() {
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: pfdir });
  const s = await app.start({ request: "r", toolCatalog: catalog as never });
  await app.split({
    sessionId: s.sessionId,
    nodeId: "1",
    reason: "M8 테스트용 분해 사유입니다.",
    children: [{ goal: "a" }, { goal: "b" }],
    expectedRevision: 0,
  });
  return { app, sid: s.sessionId };
}

/** attempt 산출물(HTML) 1건을 만든다 */
function putArtifact(sid: string, rel: string, body: string): void {
  const dir = join(pfdir, "sandbox", sid, ...rel.split("/").slice(0, -1));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(pfdir, "sandbox", sid, rel), body, "utf8");
}

describe("M7-ui3 App.nodeDetail", () => {
  it("메타·판정·hash·stale·argSpecs 스냅샷", async () => {
    const { app, sid } = await started();
    const d = await app.nodeDetail({ sessionId: sid, nodeId: "1.1" });
    expect(d.nodeId).toBe("1.1");
    expect(d.status).toBe("open");
    expect(d.hash).toMatch(/^[0-9a-f]/);
    expect(d.retriesLeft).toBe(3);
    expect(d.staleSince).toBeNull();
    expect(d.attempts).toEqual([]);
    expect(d.locked).toBe(false);
    expect(d.sideEffect).toBe("none");
  }, 30000);

  it("nodeId 이벤트 필터 (서버측)", async () => {
    const { app, sid } = await started();
    const rev0 = (await app.readSession(sid)).revision;
    await app.editNode({
      sessionId: sid,
      nodeId: "1.2",
      goal: "b 수정",
      expectedRevision: rev0,
    });
    await app.editNode({
      sessionId: sid,
      nodeId: "1.1",
      goal: "a 수정",
      expectedRevision: (await app.readSession(sid)).revision,
    });
    const all = await app.getEventsPage({ sessionId: sid });
    const only12 = await app.getEventsPage({ sessionId: sid, nodeId: "1.2" });
    const only11 = await app.getEventsPage({ sessionId: sid, nodeId: "1.1" });
    for (const e of only12.events) expect(e.nodeIds).toContain("1.2");
    for (const e of only11.events) expect(e.nodeIds).toContain("1.1");
    // 1.1 편집 이벤트(노드 1.1만)는 1.2 필터에 없다.
    const edit11 = all.events.find(
      (e) => e.method === "pfEditNode" && e.nodeIds.join() === "1.1",
    );
    expect(edit11).toBeDefined();
    expect(only12.events.some((e) => e.revision === edit11!.revision)).toBe(false);
    expect(only11.events.some((e) => e.revision === edit11!.revision)).toBe(true);
  }, 30000);
});

describe("M7-ui3 산출물 API", () => {
  it("헤더 3종 + HTML 원문도 텍스트로만 + 경로 탈출 거부", async () => {
    const { app, sid } = await started();
    const html = "<script>alert(1)</script><p>hi</p>";
    putArtifact(sid, "out/page.html", html);
    await app.report({
      sessionId: sid,
      nodeId: "1.1",
      tool: { server: "t", name: "read" },
      args: {},
      resultSummary: "ok",
      selfVerdict: "pass",
      selfReason: "ok",
      artifacts: ["out/page.html"],
    });
    const d = await app.nodeDetail({ sessionId: sid, nodeId: "1.1" });
    const attempt = d.attempts.at(-1)!;
    const pv = attempt.artifactPreviews.at(0);
    expect(pv?.mime).toBe("text/plain");
    expect(pv?.text).toContain("<script>");

    const srv = await createUiServer({ app });
    try {
      // M7-ui3-a: 경로는 attemptId+idx로만 (클라가 경로를 보내지 않는다).
      const url = `${srv.url}/api/sessions/${sid}/nodes/1.1/artifacts/${attempt.id}/0`;
      const r = await fetch(url, { headers: { "x-procforge-token": srv.token } });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/plain");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("content-disposition")).toContain("attachment");
      // 본문은 그대로지만 text/plain + nosniff라 브라우저가 실행하지 않는다.
      expect(await r.text()).toBe(html);

      // 경로 탈출 시도 (attemptId 슬롯에 경로를 넣는다)
      const esc = await fetch(
        `${srv.url}/api/sessions/${sid}/nodes/1.1/artifacts/..%2f..%2f..%2fsession.json/0`,
        { headers: { "x-procforge-token": srv.token } },
      );
      expect([400, 404]).toContain(esc.status);
      // 토큰 없으면 401
      expect((await fetch(url)).status).toBe(401);
    } finally {
      await srv.close();
    }
  }, 30000);
});

describe("M7-ui3 상세 API", () => {
  it("GET 노드 상세 + 이벤트 동봉", async () => {
    const { app, sid } = await started();
    const srv = await createUiServer({ app });
    try {
      const r = await fetch(`${srv.url}/api/sessions/${sid}/nodes/1.2`, {
        headers: { "x-procforge-token": srv.token },
      });
      const body = (await r.json()) as {
        detail: { nodeId: string; goal: string };
        events: { nodeIds: string[] }[];
      };
      expect(body.detail.nodeId).toBe("1.2");
      expect(body.detail.goal).toBe("b");
      for (const e of body.events) expect(e.nodeIds).toContain("1.2");
    } finally {
      await srv.close();
    }
  }, 30000);
});