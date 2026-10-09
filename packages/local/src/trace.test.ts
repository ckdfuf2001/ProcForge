import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalStack } from "../src/core-inprocess.js";
import { buildTrace, formatTraceMarkdown, logEvent, readEvents } from "../src/trace.js";
import { exportSession, listZip, readZipEntry, writeZip } from "../src/export.js";
import type { CoreClient } from "@procforge/shared/core-client.js";

let pfdir: string;
let client: CoreClient;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "pf-trace-"));
  pfdir = join(root, ".procforge");
  client = createLocalStack(pfdir).client;
});

async function scripted(): Promise<string> {
  const started = await client.pfStart({
    request: "추적",
    toolCatalog: [{ server: "opencode", name: "read", inputSchema: {}, schemaHash: "h" }],
  });
  const sid = started.session.id;
  await client.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "a" }] });
  await client.pfReport({
    sessionId: sid, nodeId: "1.1",
    tool: { server: "opencode", name: "read" }, args: { path: "x" },
    resultSummary: "ok", resultJson: { ok: true },
    selfVerdict: "pass", selfReason: "ok",
  });
  logEvent(pfdir, { at: new Date().toISOString(), tool: "pf_report", sessionId: sid, nodeId: "1.1", ok: true });
  return sid;
}

describe("trace/export", () => {
  it("trace 마크다운: 측정행 포함", async () => {
    const sid = await scripted();
    const r = buildTrace(pfdir, sid);
    expect(r.nodesTotal).toBe(2);
    expect(r.callsTotal).toBeGreaterThanOrEqual(1);
    expect(readEvents(pfdir, sid).length).toBe(1);
    const md = formatTraceMarkdown(r);
    expect(md).toContain("## M3.5 측정행");
    expect(md).toContain("1.1");
  });

  it("export redact: 내용은 기술자로, 구조 유지", async () => {
    const sid = await scripted();
    const out = join(pfdir, "out.zip");
    const r = exportSession({ procforgeDir: pfdir, sessionId: sid, outPath: out, redact: true });
    expect(r.redacted).toBe(true);
    expect(existsSync(out)).toBe(true);
    const buf = readFileSync(out);
    const names = listZip(buf).map((e) => e.name);
    expect(names.some((n) => n === "session.json.redacted.json")).toBe(true);
    const sessionEntry = names.find((n) => n === "session.json.redacted.json")!;
    const meta = JSON.parse(readZipEntry(buf, sessionEntry).toString("utf8")) as { redacted: boolean; sha256: string; size: number };
    expect(meta.redacted).toBe(true);
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("export 원문 포함 옵션", async () => {
    const sid = await scripted();
    const out = join(pfdir, "out2.zip");
    const r = exportSession({ procforgeDir: pfdir, sessionId: sid, outPath: out, redact: true, includeOriginals: true });
    expect(r.redacted).toBe(false);
    const buf = readFileSync(out);
    const names = listZip(buf).map((e) => e.name);
    expect(names.some((n) => n.endsWith(".redacted.json"))).toBe(true);
    expect(names.some((n) => n.endsWith("session.json") && !n.endsWith(".redacted.json"))).toBe(true);
  });

  it("zip UTF-8 플래그는 비ASCII 이름에만 (탐색기 해제 회귀)", () => {
    const ascii = writeZip([{ name: "nodes/1.json", data: Buffer.from("{}") }]);
    expect(ascii.readUInt16LE(8)).toBe(0); // local header flags
    let p = 0;
    while (ascii.readUInt32LE(p) !== 0x02014b50) p++;
    expect(ascii.readUInt16LE(p + 8)).toBe(0); // central flags
    const nonAscii = writeZip([{ name: "작업.json", data: Buffer.from("{}") }]);
    expect(nonAscii.readUInt16LE(8)).toBe(0x0800);
  });
});
