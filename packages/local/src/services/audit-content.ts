import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { ArgSpec, Node } from "@procforge/shared/schema.js";
import { findDateSample, recordedNumbers } from "./finalize-audit.js";

// finalize 감사 확장 (M5.3-1): 절차서에 박히는 파일 내용 검사.
// (a) script-kind 인자의 호스트 스크립트, (b) 바인딩 입력이 아닌 고정 템플릿 파일.
// 바인딩 입력(var/템플릿 경로)은 실행 시점에 해석되므로 제외. pptx는 텍스트 추출.

const MAX_SCRIPT_BYTES = 200 * 1024;
const MAX_TEMPLATE_BYTES = 8 * 1024 * 1024;

export type AuditContentItem = {
  nodeId: string;
  /** "scripts/<rel>" | "template/<rel>" */
  where: string;
  text: string;
};

/**
 * pptx 텍스트 추출 (의존성 없음). zip 로컬 헤더만 순회, slide XML의
 * <a:t> 텍스트 수집. stored/deflate만 지원, 그 외는 건너뜀.
 */
export function extractPptxText(buf: Buffer): string {
  const texts: string[] = [];
  let off = 0;
  while (off + 30 <= buf.length) {
    if (buf.readUInt32LE(off) !== 0x04034b50) break;
    const method = buf.readUInt16LE(off + 8);
    const compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.toString("utf8", off + 30, off + 30 + nameLen);
    const dataStart = off + 30 + nameLen + extraLen;
    if (/^ppt\/slides\/slide\d+\.xml$/.test(name) && compSize > 0) {
      const raw = buf.subarray(dataStart, dataStart + compSize);
      let xml = "";
      try {
        xml = method === 0 ? raw.toString("utf8") : method === 8 ? inflateRawSync(raw).toString("utf8") : "";
      } catch {
        xml = "";
      }
      for (const m of xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)) {
        texts.push(
          m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"'),
        );
      }
    }
    off = dataStart + compSize;
  }
  return texts.join("\n");
}

function readTextFile(abs: string, cap: number): string | null {
  try {
    if (!existsSync(abs) || statSync(abs).size > cap) return null;
    const buf = readFileSync(abs);
    if (abs.toLowerCase().endsWith(".pptx")) return extractPptxText(buf);
    const text = buf.toString("utf8");
    // 바이너리 추정 시 제외
    const bad = (text.match(/�/g) ?? []).length;
    if (bad > text.length / 10) return null;
    return text;
  } catch {
    return null;
  }
}

/** 감사 대상 파일 내용 수집 (읽기 실패·초과는 조용히 제외. 수집 실패는 write 단계에서 거부) */
export function collectAuditContent(input: {
  projectRoot: string;
  nodes: Node[];
}): AuditContentItem[] {
  const out: AuditContentItem[] = [];
  for (const n of input.nodes) {
    for (const [k, spec] of Object.entries(n.args ?? {})) {
      const s = spec as ArgSpec;
      if (s.kind === "script") {
        const rel = String((s as { file: string }).file).split("\\").join("/");
        const text = readTextFile(join(input.projectRoot, rel), MAX_SCRIPT_BYTES);
        if (text !== null) out.push({ nodeId: n.id, where: `script:${rel}`, text });
        continue;
      }
      if (s.kind !== "fixed") continue;
      if ((s as { path?: string }).path !== "in" && (s as { path?: string }).path !== "inout") continue;
      const v = (s as { value: unknown }).value;
      if (typeof v !== "string" || v.includes("${params.")) continue;
      const rel = v.split("\\").join("/");
      const text = readTextFile(join(input.projectRoot, rel), MAX_TEMPLATE_BYTES);
      if (text !== null) out.push({ nodeId: n.id, where: `template:${rel} (arg ${k})`, text });
    }
  }
  return out;
}

/** 파일 내용 감사: 날짜 표현·params 값·녹화 수치 상수. 면제 없음. */
export function auditContentTexts(input: {
  params: Record<string, string>;
  items: AuditContentItem[];
  cassettes: Map<string, { response: { summary: string; json?: unknown } }[]>;
}): string[] {
  const findings: string[] = [];
  const paramEntries = Object.entries(input.params).filter(([, v]) => v.length >= 3);
  const recNums = new Map<string, Set<number>>();
  for (const [nid, entries] of input.cassettes) recNums.set(nid, recordedNumbers(entries));
  for (const item of input.items) {
    for (const [, pv] of paramEntries) {
      if (item.text.includes(pv)) {
        findings.push(`${item.nodeId}.${item.where}: params 값 "${pv}" 포함 (var 후보)`);
        break;
      }
    }
    const dateSample = findDateSample(item.text);
    if (dateSample) {
      findings.push(`${item.nodeId}.${item.where}: 날짜 표현 "${dateSample}"`);
    }
    const own = recNums.get(item.nodeId) ?? new Set<number>();
    const seen = new Set<number>();
    for (const m of item.text.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
      const t = m[0].replace(/,/g, "");
      if (!/^-?\d+$/.test(t)) continue;
      const num = Number(t);
      if (!Number.isSafeInteger(num) || Math.abs(num) < 1000 || seen.has(num)) continue;
      seen.add(num);
      if (own.has(num)) findings.push(`${item.nodeId}.${item.where}: 녹화 응답 수치와 일치 (${num})`);
    }
  }
  return findings;
}
