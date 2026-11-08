import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

useTmpCleanup();

// M10-entry-fix 결함 2: 승인 게이트 통과 판정.
// (a) 승인된 script는 무인 실행이 통과한다.
// (b) goal을 바꾸면 stale로 fail["approval"]이 난다.

const CAT = [
  { server: "t", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;

let root: string;
let pfdir: string;
let app: ProcForgeApp;

function writeProc(name: string, goal: string) {
  const dir = join(pfdir, "procedures", name);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "job.py"), "print('{\"ok\": true}')\n", "utf8");
  writeFileSync(
    join(dir, "procedure.json"),
    JSON.stringify({
      format: "procforge-procedure",
      version: 1,
      name,
      sourceSession: "s",
      createdAt: new Date(0).toISOString(),
      params: {},
      toolCatalog: CAT,
      tree: { rootId: "1", nodes: [] },
      nodes: [
        {
          id: "1", parentId: null, goal, depth: 0, children: [],
          tool: { server: "t", name: "echo", schemaHash: "h" },
          args: { script: { kind: "script", file: "scripts/job.py", runtime: "python" } },
          sideEffect: "external", dependsOn: [], constraints: [],
        },
      ],
    }),
  );
}

beforeEach(() => {
  root = makeTmp("pf-m10gate-");
  pfdir = join(root, ".procforge");
  const { client } = testStack(pfdir);
  app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
});

describe("M10-entry gate", () => {
  it("(a) 승인된 script는 무인 실행이 통과", async () => {
    writeProc("g-ok", "밤 집계");
    await app.approveProcedureNode({ procedure: "g-ok", nodeId: "1", allowWildcard: [] });
    const r = await app.runProcedure({ procedure: "g-ok", params: {}, unattended: true });
    expect(r.failed).toBe(0);
    expect(r.passed).toBe(1);
  }, 120000);

  it("(b) goal 변경 후 무인 실행은 stale로 fail", async () => {
    writeProc("g-st", "밤 집계");
    await app.approveProcedureNode({ procedure: "g-st", nodeId: "1", allowWildcard: [] });
    const dir = join(pfdir, "procedures", "g-st");
    const raw = JSON.parse(
      (await import("node:fs")).readFileSync(join(dir, "procedure.json"), "utf8"),
    ) as { nodes: { id: string; goal?: string }[] };
    const n = raw.nodes.find((x) => x.id === "1");
    if (!n) throw new Error("node 없음");
    n.goal = "밤 집계 v2";
    writeFileSync(join(dir, "procedure.json"), JSON.stringify(raw));
    const r = await app.runProcedure({ procedure: "g-st", params: {}, unattended: true });
    expect(r.failed).toBe(1);
    expect(JSON.stringify(r)).toContain("approval");
  }, 120000);
});
