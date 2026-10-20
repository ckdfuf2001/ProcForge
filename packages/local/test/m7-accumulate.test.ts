import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runProcedureTest } from "../src/runner/procedure-run.js";
import {
  approvalPins,
  buildApprovalEntry,
  checkApproval,
  computeApprovalHash,
  toHashable,
} from "../src/services/approvals.js";
import {
  resolveStateDir,
  seedAccumulate,
  writeBackAccumulate,
} from "../src/services/accumulate.js";
import { readRunLog } from "../src/services/run-log.js";
import { computeNodeHash } from "@procforge/shared/schema.js";

// M7-close-i: accumulate(B) — run 사이 누적 보존/실패 시 불변/충돌/테스트 모드.

let root: string;
let pfdir: string;
let procDir: string;
let stateRoot: string;

const SCRIPT = `import json, os, sys
a = json.load(sys.stdin)
day = a.get("day", "D")
p = "data.csv"
rows = []
if os.path.exists(p):
    rows = open(p, encoding="utf-8").read().splitlines()
if not rows:
    rows.append("day")
rows.append(day)
open(p, "w", encoding="utf-8").write("\\n".join(rows) + "\\n")
print(json.dumps({"summary": day + " total " + str(len(rows) - 1), "json": {"day": day, "total": len(rows) - 1}}))
if day == "FAIL":
    sys.exit(3)
`;

function node() {
  return {
    id: "1.1",
    parentId: "1",
    goal: "append",
    depth: 1,
    dependsOn: [],
    children: [],
    tool: { server: "host", name: "script", schemaHash: "s" },
    args: {
      script: { kind: "script", file: "scripts/append.py" },
      day: { kind: "var", ref: "${params.day}" },
    },
    sideEffect: "external",
    constraints: [
      {
        id: "c1",
        kind: "csv_rows",
        spec: { path: "data.csv", op: "ge", value: 1, skipHeader: true },
        source: "human",
      },
    ],
    golden: {
      fixtures: ["fixtures/data.csv"],
      output: '{"total":1}',
      ignore: [],
    },
  };
}

function writeProcedure(accumulate = [{ path: "data.csv", node: "1.1" }]) {
  procDir = join(pfdir, "procedures", "acc");
  mkdirSync(join(procDir, "scripts"), { recursive: true });
  mkdirSync(join(procDir, "tests", "fixtures"), { recursive: true });
  writeFileSync(join(procDir, "scripts", "append.py"), SCRIPT);
  writeFileSync(join(procDir, "tests", "fixtures", "data.csv"), "day\nfixture\n");
  writeFileSync(
    join(procDir, "tests", "fixtures-manifest.json"),
    JSON.stringify({ "fixtures/data.csv": "data.csv" }),
  );
  const doc = {
    format: "procforge-procedure",
    version: 1,
    name: "acc",
    sourceSession: "test",
    createdAt: new Date().toISOString(),
    params: { day: { type: "string", required: true, description: "" } },
    toolCatalog: [
      { server: "host", name: "script", inputSchema: {}, schemaHash: "s" },
    ],
    nodes: [
      {
        id: "1",
        parentId: null,
        goal: "root",
        depth: 0,
        dependsOn: [],
        children: ["1.1"],
        sideEffect: "none",
        constraints: [],
      },
      node(),
    ],
    accumulate,
  };
  writeFileSync(join(procDir, "procedure.json"), JSON.stringify(doc, null, 2));
  return doc;
}

function run(day: string, mode: "live" | "replay" = "live") {
  return runProcedureTest(pfdir, root, "acc", {
    procforgeDir: pfdir,
    projectRoot: root,
    mode,
    params: { day },
    stateRoot,
  });
}

function stateFile(): string {
  return join(stateRoot, "acc", "data.csv");
}

function rows(path: string): string[] {
  return readFileSync(path, "utf8").split(/\r?\n/).filter((x) => x.length > 0);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m7acc-"));
  pfdir = join(root, ".procforge");
  stateRoot = join(root, "state");
  writeProcedure();
});

afterEach(() => {
  // mkdtemp는 OS temp라 별도 정리 불필요
});

describe("M7 accumulate(B)", () => {
  it("D1→D2→D3 누적이 유실 없이 이어지고 초기화 로그가 남는다", async () => {
    expect(resolveStateDir(pfdir, "acc")).toBe(join(pfdir, "state", "acc"));
    const r1 = await run("D1");
    expect(r1.report.summary.fail).toBe(0);
    expect(rows(stateFile())).toEqual(["day", "fixture", "D1"]);
    expect(existsSync(join(stateRoot, "acc", "data.csv.bak"))).toBe(false);
    const log1 = readRunLog(pfdir, r1.report.runId).map((x) => x.message);
    expect(log1.some((m) => m.includes("초기화: data.csv"))).toBe(true);

    const r2 = await run("D2");
    expect(r2.report.summary.fail).toBe(0);
    expect(rows(stateFile())).toEqual(["day", "fixture", "D1", "D2"]);
    expect(readFileSync(join(stateRoot, "acc", "data.csv.bak"), "utf8")).toContain("D1");

    const r3 = await run("D3");
    expect(r3.report.summary.fail).toBe(0);
    expect(rows(stateFile())).toEqual(["day", "fixture", "D1", "D2", "D3"]);
    const log3 = readRunLog(pfdir, r3.report.runId).map((x) => x.message);
    expect(log3.some((m) => m.includes("누적 상태 로드: data.csv"))).toBe(true);
  }, 180000);

  it("실패 run은 상태 파일을 바꾸지 않는다", async () => {
    await run("D1");
    const before = readFileSync(stateFile(), "utf8");
    const bad = await run("FAIL");
    expect(bad.report.summary.fail).toBeGreaterThanOrEqual(1);
    expect(readFileSync(stateFile(), "utf8")).toBe(before);
    const fsRows = rows(join(pfdir, "runs", bad.report.runId, "fs", "data.csv"));
    expect(fsRows).toEqual(["day", "fixture", "D1", "FAIL"]);
  }, 180000);

  it("시작 sha가 달라진 상태에는 write-back하지 않고 conflict로 실패한다", () => {
    const stateDir = join(stateRoot, "unit");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "data.csv"), "day\nD0\n");
    const specs = [{ path: "data.csv", node: "1.1" }];
    const mk = (runId: string) => {
      const fsDir = join(pfdir, "runs", runId, "fs");
      mkdirSync(fsDir, { recursive: true });
      return { fsDir, state: seedAccumulate({ procforgeDir: pfdir, runId, stateDir, fsDir, specs }) };
    };
    const a = mk("run-a");
    const b = mk("run-b");
    writeFileSync(join(a.fsDir, "data.csv"), "day\nD0\nA\n");
    writeFileSync(join(b.fsDir, "data.csv"), "day\nD0\nB\n");
    writeBackAccumulate({ state: a.state, stateDir, fsDir: a.fsDir });
    expect(rows(join(stateDir, "data.csv"))).toEqual(["day", "D0", "A"]);
    expect(() =>
      writeBackAccumulate({ state: b.state, stateDir, fsDir: b.fsDir }),
    ).toThrow(/accumulate 상태 충돌/);
    expect(rows(join(stateDir, "data.csv"))).toEqual(["day", "D0", "A"]);
  });

  it("--node 부분 실행은 상태를 커밋하지 않는다", async () => {
    await run("D1");
    const before = readFileSync(stateFile(), "utf8");
    const r = await runProcedureTest(pfdir, root, "acc", {
      procforgeDir: pfdir,
      projectRoot: root,
      mode: "live",
      params: { day: "D2" },
      nodeId: "1.1",
      stateRoot,
    });
    expect(r.report.summary.fail).toBe(0);
    expect(readFileSync(stateFile(), "utf8")).toBe(before);
  }, 180000);

  it("test(replay) 모드는 상태를 seed/write-back하지 않고 fixture를 쓴다", async () => {
    await run("D1");
    const before = readFileSync(stateFile(), "utf8");
    const r = await run("REPLAY", "replay");
    expect(r.report.summary.fail).toBe(0);
    expect(readFileSync(stateFile(), "utf8")).toBe(before);
    expect(rows(join(pfdir, "runs", r.report.runId, "fs", "data.csv"))).toEqual([
      "day",
      "fixture",
      "REPLAY",
    ]);
  }, 180000);

  it("accumulate 선언이 approvalHash에 포함되고 변경은 stale이 된다", () => {
    const baseNode = node();
    const n = {
      ...baseNode,
      hash: computeNodeHash({
        goal: baseNode.goal,
        args: baseNode.args as never,
        constraints: baseNode.constraints as never,
        dependsOn: [],
      }),
    };
    const hashable = toHashable(n);
    const byId = new Map([[n.id, hashable]]);
    const readScript = () => SCRIPT;
    const base = computeApprovalHash(hashable, byId, new Set(), { readScript });
    const acc = [{ path: "data.csv", node: "1.1" }];
    const h1 = computeApprovalHash(hashable, byId, new Set(), {
      readScript,
      accumulate: acc,
    });
    const h1again = computeApprovalHash(hashable, byId, new Set(), {
      readScript,
      accumulate: [{ node: "1.1", path: "data.csv" }],
    });
    expect(h1).not.toBe(base);
    expect(h1again).toBe(h1);

    const entry = buildApprovalEntry(n, ["day"], byId, readScript, acc);
    const pins = approvalPins(n, undefined, byId, readScript, acc);
    expect(checkApproval([entry], pins, "host", "script", { day: "D1" })).toBe("ok");
    const changedPins = approvalPins(n, undefined, byId, readScript, [
      { path: "other.csv", node: "1.1" },
    ]);
    expect(
      checkApproval([entry], changedPins, "host", "script", { day: "D1" }),
    ).toBe("stale");
  });
});
