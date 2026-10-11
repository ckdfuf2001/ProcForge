import { describe, it, expect } from "vitest";
import { deflateRawSync } from "node:zlib";
import { auditContentTexts, collectAuditContent, extractPptxText } from "./audit-content.js";

// M5.3-1: 파일 내용 감사 단위 테스트.

/** 최소 zip 로컬 헤더 1개로 pptx 흉내 */
function fakePptx(slideXml: string): Buffer {
  const name = Buffer.from("ppt/slides/slide1.xml", "utf8");
  const data = deflateRawSync(Buffer.from(slideXml, "utf8"));
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4);
  head.writeUInt16LE(0, 6);
  head.writeUInt16LE(8, 8);
  head.writeUInt32LE(0, 14);
  head.writeUInt32LE(data.length, 18);
  head.writeUInt32LE(name.length, 26);
  return Buffer.concat([head, name, data]);
}

const SLIDE = `<p:sld><p:txBody><a:p><a:r><a:t>월간보고서 2026-09 (초안)</a:t></a:r></a:p></p:txBody></p:sld>`;

describe("extractPptxText", () => {
  it("slide 텍스트 추출", () => {
    expect(extractPptxText(fakePptx(SLIDE))).toContain("월간보고서 2026-09 (초안)");
  });

  it("깨진 입력은 빈 문자열", () => {
    expect(extractPptxText(Buffer.from("not a zip"))).toBe("");
  });
});

describe("auditContentTexts", () => {
  const cas = new Map([["1.1", [{ response: { summary: "total 1500000", json: { total: 1500000 } } }]]]);
  const P = { month: "2026-09" };

  it("스크립트 하드코딩 날짜 → 경고", () => {
    const out = auditContentTexts({
      params: P,
      items: [{ nodeId: "1.1", where: "script:scripts/agg.py", text: 'PERIOD = "2026-09"\nprint("ok")' }],
      cassettes: cas,
    });
    expect(out.some((w) => w.includes("날짜 표현"))).toBe(true);
  });

  it("params 값·녹화 수치 → 경고, 깨끗하면 없음", () => {
    const hit = auditContentTexts({
      params: P,
      items: [{ nodeId: "1.1", where: "script:scripts/agg.py", text: "month = 2026-09\ntotal = 1500000" }],
      cassettes: cas,
    });
    expect(hit.some((w) => w.includes("params"))).toBe(true);
    expect(hit.some((w) => w.includes("녹화 응답 수치"))).toBe(true);
    const clean = auditContentTexts({
      params: P,
      items: [{ nodeId: "1.1", where: "scripts/agg.py", text: "import json\nprint(json.dumps({}))" }],
      cassettes: cas,
    });
    expect(clean).toEqual([]);
  });
});

describe("collectAuditContent", () => {
  it("script 수집 + 바인딩 템플릿 제외 + 고정 템플릿 포함", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(join(tmpdir(), "pf-auditc-"));
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "agg.py"), "print(1)");
    writeFileSync(join(root, "template.j2"), "hello");
    const nodes = [{
      id: "1.1", args: {
        s: { kind: "script", file: "scripts/agg.py" },
        bound: { kind: "var", ref: "sales-${params.month}.xlsx", path: "in" },
        tpl: { kind: "fixed", value: "template.j2", path: "in" },
        out: { kind: "fixed", value: "o.txt", path: "out" },
      },
    }] as never;
    const out = collectAuditContent({ projectRoot: root, nodes });
    expect(out.map((o) => o.where).sort()).toEqual(["script:scripts/agg.py", "template:template.j2 (arg tpl)"]);
  });
});
