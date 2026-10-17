import { describe, it, expect, beforeEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createUiServer } from "../src/app/ui-server.js";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";

// M7-ui3 보정 a~d: 산출물 경로(core 결정·realpath·sid 검증)·읽기 무쓰기·
// 4KB 읽기/캐시·이력 200건·헤더·404.

const catalog = [
  { server: "t", name: "read", inputSchema: { type: "object" }, schemaHash: "h" },
];

let pfdir: string;
beforeEach(() => {
  pfdir = join(mkdtempSync(join(tmpdir(), "pf-ui3b-")), ".procforge");
});

async function withArtifact() {
  const { client } = testStack(pfdir);
  const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: pfdir });
  const s = await app.start({ request: "r", toolCatalog: catalog as never });
  await app.split({
    sessionId: s.sessionId,
    nodeId: "1",
    children: [{ goal: "a" }, { goal: "b" }],
    expectedRevision: 0,
  });
  const sandbox = join(pfdir, "sandbox", s.sessionId);
  mkdirSync(join(sandbox, "out"), { recursive: true });
  writeFileSync(join(sandbox, "out", "page.html"), "<script>alert(1)</script>", "utf8");
  await app.report({
    sessionId: s.sessionId,
    nodeId: "1.1",
    tool: { server: "t", name: "read" },
    args: {},
    resultSummary: "ok",
    selfVerdict: "pass",
    selfReason: "ok",
    artifacts: ["out/page.html"],
  });
  const detail = await app.nodeDetail({ sessionId: s.sessionId, nodeId: "1.1" });
  const attempt = detail.attempts.at(-1)!;
  return { app, sid: s.sessionId, attempt, sandbox };
}

describe("M7-ui3-a 산출물 경로", () => {
  it("attemptId+idx로 받고 헤더 3종 + filename*", async () => {
    const { app, sid, attempt } = await withArtifact();
    const srv = await createUiServer({ app });
    try {
      const url = `${srv.url}/api/sessions/${sid}/nodes/1.1/artifacts/${attempt.id}/0`;
      const r = await fetch(url, { headers: { "x-procforge-token": srv.token } });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/plain");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      const cd = r.headers.get("content-disposition") ?? "";
      // fixture 파일명은 ingest가 "0-" 접두어를 붙인다 (basename 그 자체).
      expect(cd).toContain("attachment");
      expect(cd).toContain('filename="0-page.html"');
      expect(cd).toContain("filename*=UTF-8''0-page.html");
      // 경로 조각은 헤더에 없다.
      expect(cd).not.toContain("fixtures");
      expect(await r.text()).toContain("<script>");
    } finally {
      srv.close();
    }
  }, 30000);

  it("sid 탈출(%2e%2e)·session.json·calls.jsonl 접근 불가", async () => {
    const { app, sid, attempt } = await withArtifact();
    const srv = await createUiServer({ app });
    try {
      const H = { "x-procforge-token": srv.token };
      const base = `${srv.url}/api/sessions`;
      // 1) sid 경로 탈출
      const esc1 = await fetch(`${base}/%2e%2e%2f%2e%2e/nodes/1.1/artifacts/${attempt.id}/0`, {
        headers: H,
      });
      expect([400, 404]).toContain(esc1.status);
      // 2) 세션 파일 직접 지정 (attemptId 슬롯이어야 한다) → core가 못 찾으면 404
      for (const target of ["session.json", "calls.jsonl", "..%2fsession.json"]) {
        const r = await fetch(`${base}/${sid}/nodes/1.1/artifacts/${target}/0`, {
          headers: H,
        });
        expect([400, 404]).toContain(r.status);
      }
      // 3) 존재하지 않는 attempt / 인덱스
      expect(
        (await fetch(`${base}/${sid}/nodes/1.1/artifacts/00000000-0000-4000-8000-000000000000/0`, { headers: H }))
          .status,
      ).toBe(404);
      expect(
        (await fetch(`${base}/${sid}/nodes/1.1/artifacts/${attempt.id}/7`, { headers: H }))
          .status,
      ).toBe(404);
      // 4) 세션 없음 → 404
      expect(
        (await fetch(`${base}/123e4567-e89b-42d3-a456-426614174000/nodes/1.1/artifacts/${attempt.id}/0`, { headers: H }))
          .status,
      ).toBe(404);
    } finally {
      srv.close();
    }
  }, 30000);

  it("심링크 탈출 거부", async () => {
    const { app, sid, attempt, sandbox } = await withArtifact();
    const secret = join(pfdir, "secret.txt");
    writeFileSync(secret, "TOP SECRET", "utf8");
    const link = join(sandbox, "out", "link.txt");
    try {
      symlinkSync(secret, link, "file");
    } catch {
      return; // 권한 없음 환경에서는 건너뛴다.
    }
    // attempt.artifacts에 심링크 경로를 넣으려면 core를 거치므로,
    // preview/내부 판정 경계를 직접 검증한다.
    const { assertInsideRoot } = await import("../src/services/artifact-view.js");
    expect(() => assertInsideRoot(sandbox, link)).toThrow();
    expect(() => assertInsideRoot(sandbox, secret)).toThrow();
    // 정상 파일은 통과
    expect(() => assertInsideRoot(sandbox, join(sandbox, "out", "page.html"))).not.toThrow();
    void attempt;
  }, 30000);
});

describe("M7-ui3-b 읽기 무쓰기 (nodeDetail 포함)", () => {
  it("nodeDetail 10회 후 세션·노드 파일 불변", async () => {
    const { app, sid } = await withArtifact();
    const sf = join(pfdir, "sessions", sid, "session.json");
    const nf = join(pfdir, "sessions", sid, "nodes", "1.1.json");
    if (!existsSync(sf)) return; // remote: 서버 저장소라 이 파일 없음
    const b = {
      s: readFileSync(sf, "utf8"),
      sm: statSync(sf).mtimeMs,
      n: readFileSync(nf, "utf8"),
      nm: statSync(nf).mtimeMs,
    };
    for (let i = 0; i < 10; i++) {
      await app.nodeDetail({ sessionId: sid, nodeId: "1.1" });
      await app.readSession(sid);
    }
    expect(readFileSync(sf, "utf8")).toBe(b.s);
    expect(statSync(sf).mtimeMs).toBe(b.sm);
    expect(readFileSync(nf, "utf8")).toBe(b.n);
    expect(statSync(nf).mtimeMs).toBe(b.nm);
  }, 30000);
});

describe("M7-ui3-c 미리보기", () => {
  it("앞 4KB만 읽고 sha256은 전체와 일치", async () => {
    const { app, sid, sandbox } = await withArtifact();
    const big = join(pfdir, "big.txt");
    writeFileSync(big, "A".repeat(100000), "utf8");
    const { previewArtifact } = await import("../src/services/artifact-view.js");
    const p = await previewArtifact(sandbox, "../big.txt");
    // 세션 디렉터리 밖이라 null이어야 한다.
    expect(p).toBeNull();
    const inside = join(sandbox, "big.txt");
    writeFileSync(inside, "B".repeat(10000), "utf8");
    const p2 = await previewArtifact(sandbox, "big.txt");
    expect(p2?.text?.length).toBe(4096);
    expect(p2?.truncated).toBe(true);
    expect(p2?.size).toBe(10000);
    const { createHash } = await import("node:crypto");
    expect(p2?.sha256).toBe(createHash("sha256").update("B".repeat(10000)).digest("hex"));
    void app; void sid; void big;
  }, 30000);
});

describe("M7-ui3-d 노드 이력", () => {
  it("M7-ui4-g: 이벤트 250건 → 최신 200건이고 마지막 이벤트가 들어 있다", async () => {
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: pfdir });
    const s = await app.start({ request: "r", toolCatalog: catalog as never });
    let rev = (await app.readSession(s.sessionId)).revision;
    for (let i = 0; i < 250; i++) {
      await app.editNode({
        sessionId: s.sessionId,
        nodeId: "1",
        goal: `g${i}`,
        expectedRevision: rev,
      });
      rev = (await app.readSession(s.sessionId)).revision;
    }
    const lastRevision = rev;
    const srv = await createUiServer({ app });
    try {
      const r = await fetch(`${srv.url}/api/sessions/${s.sessionId}/nodes/1`, {
        headers: { "x-procforge-token": srv.token },
      });
      const body = (await r.json()) as { events: { revision: number; nodeIds: string[] }[] };
      expect(body.events).toHaveLength(200);
      // 오래된 것부터 자르면 마지막 사건이 사라진다 — 최신 200이어야 한다
      expect(body.events.some((e) => e.revision === lastRevision)).toBe(true);
      expect(body.events[0].revision).toBeGreaterThan(1);
      // 오름차순 유지 (SSE 증분과 같은 순서)
      const revs = body.events.map((e) => e.revision);
      expect([...revs].sort((a, b) => a - b)).toEqual(revs);
      for (const e of body.events) expect(e.nodeIds).toContain("1");
    } finally {
      srv.close();
    }
  }, 60000);
});
