import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ProcForgeApp } from "../src/app/app.js";
import { FileStore } from "../src/filestore.js";
import { runProcedureTest } from "../src/runner/procedure-run.js";
import { testStack } from "./client-mode.js";

// M5.8.1-1: 실행 불가 leaf 확정 거부 + script 대안 run 통과.
// E2E redacted fixture(세션 77c17c91 1.1 형태)로 확정 단계 거부 회귀.

const here = dirname(fileURLToPath(import.meta.url));
const E2E = JSON.parse(
  readFileSync(join(here, "fixtures", "m581-e2e-redacted.json"), "utf-8"),
) as { nodes: { id: string; goal: string; tool: { server: string; name: string }; argSpecs: Record<string, unknown> }[] };

const CAT = [
  { server: "host", name: "script", inputSchema: {}, schemaHash: "s" },
  { server: "opencode", name: "bash", inputSchema: { type: "object", properties: { command: { type: "string" } }, additionalProperties: true }, schemaHash: "b" },
] as never;

const ECHO_PY = `import json,sys,os
a=json.load(sys.stdin)
os.makedirs(os.path.dirname(a["output"]) or ".", exist_ok=True)
open(a["output"],"w").write("tag="+a["tag"]+"\\n")
print(json.dumps({"summary":"wrote "+a["output"],"json":{"wrote":a["output"]}}))
`;

let root: string;
let pfdir: string;
let home: string;
let oldHome: string | undefined;
let oldProfile: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m581r-"));
  pfdir = join(root, ".procforge");
  home = mkdtempSync(join(tmpdir(), "pf-m581rhome-"));
  oldHome = process.env.HOME;
  oldProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts", "echo.py"), ECHO_PY);
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = oldProfile;
});

describe("M5.8.1-1 실행 불가 leaf 확정 거부", () => {
  it("E2E redacted fixture: bash leaf 확정 → bad_request", async () => {
    const fx = E2E.nodes[0];
    expect(fx.tool).toEqual({ server: "opencode", name: "bash" });
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const started = await client.pfStart({ request: "m581", params: {}, toolCatalog: CAT });
    const sid = started.session.id;
    await client.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: fx.goal }] });
    const nxt = await client.pfNext({ sessionId: sid });
    expect(nxt.done).toBe(false);
    await client.pfReport({
      sessionId: sid, nodeId: "1.1", tool: fx.tool as never,
      args: { command: "curl -s https://x" }, resultSummary: "ok", resultJson: { n: 1 },
      selfVerdict: "pass", selfReason: "ok",
    });
    let code = "";
    try {
      await app.confirmLeaf({ sessionId: sid, nodeId: "1.1", tool: fx.tool, argSpecs: fx.argSpecs } as never);
    } catch (e) {
      code = (e as { code?: string }).code ?? "";
      expect(String(e instanceof Error ? e.message : e)).toMatch(/runner에서 실행할 수 없음: opencode\/bash/);
    }
    expect(code).toBe("bad_request");
  }, 60000);

  it("같은 작업 script 확정 → finalize → run pass", async () => {
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const started = await client.pfStart({ request: "m581", params: {}, toolCatalog: CAT });
    const sid = started.session.id;
    await client.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "쓰기" }] });
    await client.pfNext({ sessionId: sid });
    const raw = execFileSync("python", [join(root, "scripts", "echo.py")], {
      input: JSON.stringify({ tag: "t", output: "output/seen.csv" }), encoding: "utf-8", cwd: root,
    });
    const probed = JSON.parse(raw) as { json: { wrote: string } };
    await client.pfReport({
      sessionId: sid, nodeId: "1.1", tool: { server: "host", name: "script" },
      args: { tag: "t", output: "output/seen.csv" }, resultSummary: "wrote output/seen.csv", resultJson: probed.json,
      selfVerdict: "pass", selfReason: "ok",
    });
    const leaf = await app.confirmLeaf({
      sessionId: sid, nodeId: "1.1", tool: { server: "host", name: "script" },
      argSpecs: {
        tag: { kind: "fixed", value: "t" },
        output: { kind: "fixed", value: "output/seen.csv", path: "out" },
        run: { kind: "script", file: "scripts/echo.py", runtime: "python" },
      },
    } as never);
    expect(leaf.node.status).toBe("leaf");
    await app.finalize({ sessionId: sid, name: "m581-script" });
    const { report } = await runProcedureTest(pfdir, root, "m581-script", {
      procforgeDir: pfdir, projectRoot: root, mode: "live", params: {},
    });
    expect(report.summary.fail).toBe(0);
    expect(report.summary.pass).toBeGreaterThanOrEqual(1);
  }, 120000);
});

describe("M5.8.2-2 ref 해석 인자 내려주기", () => {
  it("pf_next resolvedInputs (suggestedArgs 해석)", async () => {
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const started = await client.pfStart({ request: "m582", params: {}, toolCatalog: CAT });
    const sid = started.session.id;
    await client.pfResolve({
      sessionId: sid, nodeId: "1", decision: "split",
      children: [{ goal: "a" }, { goal: "b", dependsOn: ["1.1"] }],
    });
    await client.pfNext({ sessionId: sid });
    await client.pfReport({
      sessionId: sid, nodeId: "1.1", tool: { server: "host", name: "script" },
      args: { x: "a" }, resultSummary: "ok", resultJson: { raw: ["a"] },
      selfVerdict: "pass", selfReason: "ok",
    });
    // M5.8.2 후속: client 직결 보고는 파일을 안 쓰므로(App.report 경로만 기록)
    // 해석용 파일을 직접 심는다.
    {
      const store = new FileStore(pfdir);
      const n1 = await client.getNode(sid, "1.1");
      const aid = n1.attempts[n1.attempts.length - 1].id;
      store.writeResultJson(sid, aid, { raw: ["a"] });
    }
    await app.confirmLeaf({
      sessionId: sid, nodeId: "1.1", tool: { server: "host", name: "script" },
      argSpecs: {
        x: { kind: "fixed", value: "a" },
        run: { kind: "script", file: "scripts/echo.py", runtime: "python" },
      },
    } as never);
    await client.pfNext({ sessionId: sid });
    await client.pfReport({
      sessionId: sid, nodeId: "1.2", tool: { server: "host", name: "script" },
      args: { input: ["a"] }, resultSummary: "ok", resultJson: { n: 1 },
      selfVerdict: "pass", selfReason: "ok",
    });
    await app.confirmLeaf({
      sessionId: sid, nodeId: "1.2", tool: { server: "host", name: "script" },
      argSpecs: {
        input: { kind: "var", ref: "$1.1.raw" },
        run: { kind: "script", file: "scripts/echo.py", runtime: "python" },
      },
    } as never);
    await client.pfEditArgs({
      sessionId: sid, nodeId: "1.2",
      // M8-1-0: hash가 바뀌어야 재검증 대기가 된다(무효 수정은 leaf 유지).
      patch: {
        set: {
          input: { kind: "var", ref: "$1.1.raw" },
          run: { kind: "script", file: "scripts/echo2.py", runtime: "python" },
        },
      },
    } as never);
    const nxt = await app.next({ sessionId: sid });
    expect(nxt.done).toBe(false);
    if (nxt.done) throw new Error("unreachable");
    expect(nxt.node.id).toBe("1.2");
    expect(nxt.resolvedInputs).toEqual({ input: ["a"] });
  }, 120000);
});
