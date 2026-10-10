import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProcForgeApp } from "../src/app/app.js";
import { runSession } from "../src/runner/index.js";
import { testStack } from "./client-mode.js";

// M3.5.1-3: resultJson 키를 녹화 응답과 대조. 날조 키는 경고 + auto 미생성.

let root: string;
let pfdir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pf-m351c-"));
  pfdir = join(root, ".procforge");
});

describe("M3.5.1-3 resultJson 대조", () => {
  it("날조 resultJson → 경고 + auto 미생성", async () => {
    const { client } = testStack(pfdir);
    const app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const started = await client.pfStart({
      request: "contrast",
      toolCatalog: [{ server: "opencode", name: "read", inputSchema: {}, schemaHash: "h" }] as never,
    });
    const sid = started.session.id;
    await client.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "a" }] });
    mkdirSync(join(pfdir, "sandbox", sid), { recursive: true });
    writeFileSync(join(pfdir, "sandbox", sid, "data.txt"), "v1");
    const rep = {
      sessionId: sid, nodeId: "1.1",
      tool: { server: "opencode", name: "read" }, args: { path: "data.txt" },
      resultSummary: "v1", resultJson: { text: "v1" }, selfVerdict: "pass" as const, selfReason: "ok",
    };
    const r1 = (await app.report(rep)) as unknown as { warnings: string[] };
    expect(r1.warnings.filter((w) => w.includes("미확인 키"))).toEqual([]);
    await app.confirmLeaf({
      sessionId: sid, nodeId: "1.1",
      tool: { server: "opencode", name: "read" },
      argSpecs: { path: { kind: "fixed", value: "data.txt" } },
    });
    // 녹화 (기준 응답 {text} 확보)
    const rec = await runSession({ procforgeDir: pfdir, projectRoot: root, sessionId: sid, mode: "record" });
    expect(rec.summary.fail).toBe(0);
    // reopen 후 날조 보고
    await client.pfReopen({ sessionId: sid, nodeId: "1.1", reason: "t" });
    const r2 = (await app.report({
      ...rep, resultJson: { text: "v1", hacked: "yes" },
    })) as unknown as { verdict: string; warnings: string[] };
    expect(r2.verdict).toBe("pass");
    expect(r2.warnings.some((w) => w.includes("미확인 키") && w.includes("hacked"))).toBe(true);
    const n = await client.getNode(sid, "1.1");
    const jsonPaths = n.constraints
      .filter((c) => c.kind === "json_path_exists")
      .map((c) => (c.spec as { path: string }).path);
    expect(jsonPaths).toEqual(["text"]);
  });
});
