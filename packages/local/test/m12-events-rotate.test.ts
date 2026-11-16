import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";
import { appendEvent, appendEventWithLimit, readEventsText, eventsLogPath, eventsLogBackupPath } from "../src/services/events-log.js";
import { aggregate } from "../src/services/lessons-agg.js";

// M12-1: events 회전 (3모드 — testStack을 쓰는 ③만 모드 의존, 나머지는 fs 직접).
useTmpCleanup();

const CAT = [
  { server: "t", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function nonEmptyLines(pfdir: string, proc: string): string[] {
  return readEventsText(pfdir, proc).split("\n").filter((l) => l.length > 0);
}

function runEnd(runId: string, mark: string) {
  return { kind: "run_end", runId, status: "done", mode: "live", nodes: [], mark };
}

describe("M12-1 events 회전", () => {
  it("① 작은 상한으로 회전해도 줄이 하나도 사라지지 않는다", () => {
    const root = makeTmp("pf-m12-rot-");
    const pfdir = join(root, ".procforge");
    for (let i = 0; i < 4; i++) appendEvent(pfdir, "p", runEnd(`r-${i}`, `g-${i}`));
    // 마지막 1줄만 작은 상한으로 넣어 정확히 1회만 회전시킨다.
    appendEventWithLimit(pfdir, "p", runEnd("r-4", "g-4"), 10);
    const cur = join(pfdir, "runs", "by-procedure", "p", "events.ndjson");
    const bak = cur + ".1";
    let hasCur = false;
    try { readFileSync(cur, "utf8"); hasCur = true; } catch { hasCur = false; }
    let hasBak = false;
    try { readFileSync(bak, "utf8"); hasBak = true; } catch { hasBak = false; }
    expect(hasCur).toBe(true);
    expect(hasBak).toBe(true);
    const got = nonEmptyLines(pfdir, "p");
    expect(got.length).toBe(5);
    for (let i = 0; i < 5; i++) expect(got.some((l) => l.includes(`g-${i}`))).toBe(true);
  });

  it("② 회전 전후로 보존 구간 안의 aggregate 결과가 같다", () => {
    const mk = () => {
      const root = makeTmp("pf-m12-rot-");
      return join(root, ".procforge");
    };
    const pf1 = mk();
    const pf2 = mk();
    // 같은 이벤트 4건을, 한쪽은 회전 없이, 한쪽은 중간에 1회 회전시켜 쓴다.
    for (let i = 0; i < 4; i++) appendEvent(pf1, "p", runEnd(`r-${i}`, "M"));
    for (let i = 0; i < 2; i++) appendEvent(pf2, "p", runEnd(`r-${i}`, "M"));
    appendEventWithLimit(pf2, "p", runEnd("r-2", "M"), 10);
    appendEvent(pf2, "p", runEnd("r-3", "M"));
    const a1 = aggregate(pf1, "p");
    const a2 = aggregate(pf2, "p");
    expect(a2).toEqual(a1);
    expect(a2.runs).toBe(4);
  });

  it("③ 회전 뒤에도 최신 live run 진행률이 같다", async () => {
    const root = makeTmp("pf-m12-rot-");
    const pfdir = join(root, ".procforge");
    mkdirSync(pfdir, { recursive: true });
    const dir = join(pfdir, "procedures", "rot");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "job.py"), "print('{\"ok\": true}')\n", "utf8");
    writeFileSync(join(dir, "procedure.json"), JSON.stringify({
      format: "procforge-procedure", version: 1, name: "rot", sourceSession: "s",
      createdAt: new Date(0).toISOString(), params: {}, toolCatalog: CAT,
      tree: { rootId: "1", nodes: [] },
      nodes: [{
        id: "1", parentId: null, goal: "g", depth: 0, children: [],
        tool: { server: "t", name: "echo", schemaHash: "h" },
        args: { script: { kind: "script", file: "scripts/job.py", runtime: "python" } },
        sideEffect: "external", dependsOn: [], constraints: [],
      }],
    }));
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const r = await app.uiRun({ procedure: "rot" });
    let st = "";
    for (let i = 0; i < 60; i++) {
      st = (await app.uiRunInfo({ runId: r.runId })).status;
      if (st === "done" || st === "failed" || st === "cancelled") break;
      await sleep(1000);
    }
    expect(st).toBe("done");
    const before = await app.listProcedureProgress();
    appendEventWithLimit(pfdir, "rot", { kind: "note-test", x: 1 }, 10);
    const after = await app.listProcedureProgress();
    expect(after).toEqual(before);
    const row = after.find((x) => x.name === "rot");
    expect(row?.progress).toBe(1);
  }, 120000);

  it("④ 두 번째 회전 뒤에는 가장 오래된 세대가 버려진다", () => {
    const root = makeTmp("pf-m12-rot-");
    const pfdir = join(root, ".procforge");
    // 각 배치의 첫 1줄만 작은 상한으로 넣어 세대 단위로 정확히 1회씩 회전시킨다.
    for (let i = 0; i < 3; i++) appendEvent(pfdir, "p", runEnd(`a-${i}`, "gen-A"));
    appendEventWithLimit(pfdir, "p", runEnd("b-0", "gen-B"), 10);
    for (let i = 1; i < 3; i++) appendEvent(pfdir, "p", runEnd(`b-${i}`, "gen-B"));
    appendEventWithLimit(pfdir, "p", runEnd("c-0", "gen-C"), 10);
    for (let i = 1; i < 3; i++) appendEvent(pfdir, "p", runEnd(`c-${i}`, "gen-C"));
    const names = readdirSync(join(pfdir, "runs", "by-procedure", "p"));
    expect(names.sort()).toEqual(["events.ndjson", "events.ndjson.1"]);
    const got = nonEmptyLines(pfdir, "p");
    expect(got.length).toBe(6);
    expect(got.some((l) => l.includes("gen-A"))).toBe(false);
    expect(got.some((l) => l.includes("gen-B"))).toBe(true);
    expect(got.some((l) => l.includes("gen-C"))).toBe(true);
  });

  it("⑤ rename 실패를 주입해도 append는 성공하고 warn이 1건 남는다", () => {
    const root = makeTmp("pf-m12-rot-");
    const pfdir = join(root, ".procforge");
    appendEvent(pfdir, "p", runEnd("r-0", "g-0"));
    const bakDir = eventsLogBackupPath(pfdir, "p");
    mkdirSync(bakDir, { recursive: true });
    writeFileSync(join(bakDir, "lock"), "x");
    const lines: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: unknown }).write = ((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      appendEventWithLimit(pfdir, "p", runEnd("r-1", "g-1"), 10);
    } finally {
      (process.stderr as unknown as { write: unknown }).write = origWrite;
      rmSync(bakDir, { recursive: true, force: true });
    }
    const warns = lines.filter((l) => l.includes("events rotate 실패"));
    expect(warns.length).toBe(1);
    const got = nonEmptyLines(pfdir, "p");
    expect(got.some((l) => l.includes("g-1"))).toBe(true);
  });
});
