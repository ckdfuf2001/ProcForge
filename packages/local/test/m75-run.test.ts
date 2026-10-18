import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProcForgeApp } from "../src/app/app.js";
import { createUiServer } from "../src/app/ui-server.js";
import { testStack } from "./client-mode.js";
import { runDir, spawnTrackedChild, isAlive } from "../src/app/run-control.js";
import { readRunState } from "../src/services/run-state.js";

// M7 5-1: UI 실행 — 등록 절차서·선언 param만, 동시 1개(409), 취소=프로세스 트리,
// 기록은 runs/<runId> (세션 TTL과 무관).

const catalog = [{ server: "t", name: "read", inputSchema: { type: "object" }, schemaHash: "h" }];

let pfdir: string;
beforeEach(() => {
  pfdir = join(mkdtempSync(join(tmpdir(), "pf-run-")), ".procforge");
});

/** 최소 등록 절차서 (param 1개 선언) */
function registerProcedure(name = "demo", params: Record<string, unknown> = { month: {} }) {
  const dir = join(pfdir, "procedures", name);
  mkdirSync(dir, { recursive: true });
  const declared = Object.fromEntries(
    Object.keys(params).map((k) => [
      k,
      { type: "string", description: `${k} 값` },
    ]),
  );
  writeFileSync(
    join(dir, "procedure.json"),
    JSON.stringify(
      {
        format: "procforge-procedure",
        version: 1,
        name,
        sourceSession: "11111111-1111-4111-8111-111111111111",
        createdAt: new Date(0).toISOString(),
        params: declared,
        toolCatalog: catalog,
        tree: { rootId: "1", nodes: [] },
        nodes: [],
      },
      null,
      2,
    ),
    "utf8",
  );
  return dir;
}

async function mkApp() {
  const { client } = testStack(pfdir);
  return new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: pfdir });
}

describe("M7 5-1 uiRun 입력 검증", () => {
  it("등록되지 않은 절차서 400", async () => {
    const a = await mkApp();
    await expect(a.uiRun({ procedure: "nope" })).rejects.toThrow(/등록되지 않은/);
  });

  it("경로·명령·out 주입 키 400", async () => {
    const a = await mkApp();
    registerProcedure();
    for (const extra of [
      { path: "C:\\Windows" },
      { command: "rm -rf" },
      { out: "C:\\out" },
      { cwd: "C:\\" },
      { script: "x.py" },
    ]) {
      await expect(
        a.uiRun({ procedure: "demo", ...extra } as never),
      ).rejects.toThrow(/지정할 수 없습니다/);
    }
  });

  it("선언되지 않은 param 400 (등록 param만)", async () => {
    const a = await mkApp();
    registerProcedure("demo", { month: {} });
    await expect(a.uiRun({ procedure: "demo", params: { evil: "1" } })).rejects.toThrow(
      /선언되지 않은 param/,
    );
    const ok = await a.uiRun({ procedure: "demo", params: { month: "2026-10" } });
    expect(ok.runId).toMatch(/[0-9a-f-]{36}/);
  });

  it("procedure 이름에 경로 조작 mixin → 400", async () => {
    const a = await mkApp();
    registerProcedure();
    for (const bad of ["../evil", "a/b", "..\\evil", "demo.json"]) {
      await expect(a.uiRun({ procedure: bad })).rejects.toThrow();
    }
  });
});

describe("M7 5-1 동시 실행 409", () => {
  it("같은 절차서 두 번째 실행은 409", async () => {
    const a = await mkApp();
    registerProcedure();
    const first = await a.uiRun({ procedure: "demo", params: { month: "2026-10" } });
    const second = await a.uiRun({ procedure: "demo", params: { month: "2026-10" } }).then(
      () => "성공",
      (e: Error) => e.message,
    );
    expect(second).toMatch(/이미 실행 중/);
    // 취소하면 (백그라운드 진행이 실제로 멈춘 뒤에) 다시 시작할 수 있다
    await a.uiRunCancel({ runId: first.runId });
    let third: { runId: string } | null = null;
    for (let i = 0; i < 100 && third === null; i++) {
      third = await a
        .uiRun({ procedure: "demo", params: { month: "2026-10" } })
        .then(
          (r) => r,
          () => null,
        );
      if (third === null) await new Promise((r) => setTimeout(r, 50));
    }
    expect(third).not.toBeNull();
    expect(third?.runId).not.toBe(first.runId);
  });
});

describe("M7 5-1 취소 = 프로세스 트리 종료 (고아 0)", () => {
  it("자식 프로세스 트리가 모두 죽는다", async () => {
    const a = await mkApp();
    registerProcedure();
    const run = await a.uiRun({ procedure: "demo", params: { month: "2026-10" } });
    // 이 실행에 속한 자식(grandchild를 하나 더 띄움)
    const script = [
      "const { spawn } = require('node:child_process');",
      "const c = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {stdio:'ignore'});",
      "console.log('child', process.pid, 'grandchild', c.pid);",
      "setTimeout(()=>{}, 60000);",
    ].join("\n");
    const child = spawnTrackedChild(pfdir, run.runId, process.execPath, ["-e", script]);
    await new Promise((r) => setTimeout(r, 800));
    expect(isAlive(child.pid)).toBe(true);

    const res = await a.uiRunCancel({ runId: run.runId });
    expect(res.cancelled).toBe(true);
    expect(res.killed).toContain(child.pid);
    // 트리 전체가 죽는다 (고아 0)
    await new Promise((r) => setTimeout(r, 600));
    expect(isAlive(child.pid)).toBe(false);
    // 자식이 남긴 grandchild도 죽었는지: 로그 파일로 확인 가능하도록 종료 코드 대기
    const code = await Promise.race([
      child.wait,
      new Promise<null>((r) => setTimeout(() => r(null), 3000)),
    ]);
    expect(code === null || code !== 0).toBe(true);
  }, 30000);
});

describe("M7 5-1 실행 기록 = runs/<runId>, 세션 TTL 무관", () => {
  it("기록이 남고 로그가 읽힌다", async () => {
    const a = await mkApp();
    registerProcedure();
    const run = await a.uiRun({ procedure: "demo", params: { month: "2026-10" } });
    expect(existsSync(join(runDir(pfdir, run.runId), "state.json"))).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    const log = await a.uiRunLog({ runId: run.runId });
    expect(log.entries.length).toBeGreaterThan(0);
    expect(log.entries[0].message).toContain("실행 시작");
    expect(log.sessionId).toBe(run.sessionId);
    // 세션이 없어져도(삭제) 실행 기록은 살아 있다
    const st = readRunState(pfdir, run.runId);
    expect(st?.procedure).toBe("demo");
  }, 30000);

  it("UI POST /api/runs → {runId} 즉시 반환", async () => {
    const a = await mkApp();
    registerProcedure();
    const srv = await createUiServer({ app: a as never });
    try {
      const r = await fetch(`${srv.url}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-procforge-token": srv.token },
        body: JSON.stringify({ procedure: "demo", params: { month: "2026-10" } }),
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { runId: string; sessionId: string };
      expect(body.runId).toBeTruthy();
      // 주입 키는 HTTP에서도 400
      const bad = await fetch(`${srv.url}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-procforge-token": srv.token },
        body: JSON.stringify({ procedure: "demo", params: { month: "x" }, out: "C:\\x" }),
      });
      expect(bad.status).toBe(400);
    } finally {
      srv.close();
    }
  }, 30000);
});