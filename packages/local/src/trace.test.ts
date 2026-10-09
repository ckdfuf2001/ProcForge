import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalStack } from "../src/core-inprocess.js";
import { buildTrace, formatTraceMarkdown, logEvent, readEvents, appendStateEvent, readStateEvents, migrateCallLog } from "../src/trace.js";
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
    // M3.6-1: with-content 조건 = 원본 + 기술자 병행 (원본마다 기술자 쌍 존재)
    const originals = names.filter((n) => !n.endsWith(".redacted.json"));
    expect(originals.length).toBeGreaterThan(0);
    for (const o of originals) {
      expect(names).toContain(`${o}.redacted.json`);
      const meta = JSON.parse(readZipEntry(buf, `${o}.redacted.json`).toString("utf8")) as { redacted: boolean };
      expect(meta.redacted).toBe(true);
    }
  });

  it("export redact: 고유 문자열이 기술자 zip 어디에도 없음", async () => {
    const marker = "UNIQMASK-7f3a-9zqx";
    const started = await client.pfStart({
      request: `마스킹 확인 ${marker}`,
      toolCatalog: [{ server: "opencode", name: "read", inputSchema: {}, schemaHash: "h" }],
    });
    const sid = started.session.id;
    await client.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: `목표 ${marker}` }] });
    await client.pfReport({
      sessionId: sid, nodeId: "1.1",
      tool: { server: "opencode", name: "read" }, args: { path: `x-${marker}` },
      resultSummary: `요약 ${marker}`, resultJson: { ok: marker },
      selfVerdict: "pass", selfReason: "ok",
    });
    const out = join(pfdir, "out-mask.zip");
    exportSession({ procforgeDir: pfdir, sessionId: sid, outPath: out, redact: true });
    const buf = readFileSync(out);
    for (const e of listZip(buf)) {
      expect(e.name).not.toContain(marker);
      expect(readZipEntry(buf, e.name).toString("utf8")).not.toContain(marker);
    }
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

  it("M4.2-0.5 상태 이벤트: seq == revision + 호출 추적과 공존", async () => {
    const sid = await scripted();
    const e1 = appendStateEvent(pfdir, sid, { revision: 1, actor: "host", method: "pfReport", nodeIds: ["1.1"], beforeHash: "a", afterHash: "b", summary: "pass" });
    const e2 = appendStateEvent(pfdir, sid, { revision: 2, actor: "host", method: "pfConfirmLeaf", nodeIds: ["1.1"], beforeHash: "b", afterHash: "c", summary: "leaf" });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    const all = readStateEvents(pfdir, sid);
    // core 트랜잭션 방출분 포함 전부 seq == revision
    for (const e of all) expect(e.seq).toBe(e.revision);
    const mine = all.filter((e) => e.summary === "pass" || e.summary === "leaf");
    expect(mine.map((e) => e.method)).toEqual(["pfReport", "pfConfirmLeaf"]);
    // 호출 추적에는 상태 이벤트가 섞이지 않음
    expect(readEvents(pfdir, sid).length).toBe(1);
    expect(buildTrace(pfdir, sid).callsTotal).toBe(1);
  });

  it("M4.2-0.5-3 calls.jsonl 분리 + 마이그레이션", async () => {
    const sid = await scripted();
    // 신규 기록은 calls.jsonl로
    expect(existsSync(join(pfdir, "sessions", sid, "calls.jsonl"))).toBe(true);
    // 구 혼합 파일 시뮬레이션: events.jsonl에 TraceEvent행 직접 추가
    appendFileSync(
      join(pfdir, "sessions", sid, "events.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), tool: "pf_legacy", sessionId: sid, ok: true }) + "\n",
    );
    migrateCallLog(pfdir, sid);
    expect(readEvents(pfdir, sid).length).toBe(2);
    // 상태 이벤트(split+report 실제분)는 events.jsonl에 유지
    expect(readStateEvents(pfdir, sid).map((e) => e.method)).toEqual(["pfResolve", "pfReport"]);
    const raw = readFileSync(join(pfdir, "sessions", sid, "events.jsonl"), "utf8");
    expect(raw).not.toContain("pf_legacy");
    // 멱등: 재실행해도 calls.jsonl 불변
    const callsBefore = readFileSync(join(pfdir, "sessions", sid, "calls.jsonl"), "utf8");
    migrateCallLog(pfdir, sid);
    expect(readFileSync(join(pfdir, "sessions", sid, "calls.jsonl"), "utf8")).toBe(callsBefore);
    expect(readEvents(pfdir, sid).length).toBe(2);
  });
});
