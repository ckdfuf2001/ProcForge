import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_NAMES } from "../src/server.js";
import { APP_METHODS } from "../src/app/tools.js";
import { ProcForgeApp } from "../src/app/app.js";
import * as dto from "@procforge/shared/dto.js";

// M4.2-4-6: 도구 설명·핸들러(App 메서드)에서 쓰는 인자는 inputSchema에 있어야 한다.
// server 소스를 정적으로 파싱해 도구↔inputSchema 대응을 구한다 (드리프트 방지).

const here = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(resolve(here, "../src/server.ts"), "utf8").replace(/\r\n/g, "\n");

function blockStart(tool: string): number {
  const start = serverSrc.indexOf(`R(\n    "${tool}",`);
  if (start !== -1) return start;
  const alt = serverSrc.indexOf(`R("${tool}",`);
  if (alt === -1) throw new Error(`R( block not found: ${tool}`);
  return alt;
}

function schemaNameOf(tool: string): string {
  const at = blockStart(tool);
  const m = /inputSchema:\s*(\w+)/.exec(serverSrc.slice(at, at + 4000));
  if (!m) throw new Error(`inputSchema not found: ${tool}`);
  return m[1];
}

function schemaKeys(name: string): string[] {
  const schema = (dto as unknown as Record<string, unknown>)[name] as
    | { shape: Record<string, unknown> }
    | undefined;
  if (!schema || typeof schema.shape !== "object") throw new Error(`schema not found: ${name}`);
  return Object.keys(schema.shape);
}

function descriptionOf(tool: string): string {
  const at = blockStart(tool);
  const m = /description:\s*\[([\s\S]*?)\]\.join/.exec(serverSrc.slice(at, at + 4000));
  return m ? m[1] : "";
}

describe("인자-스키마 정합", () => {
  it("R( 블록 전 도구가 inputSchema를 가진다", () => {
    for (const tool of TOOL_NAMES) {
      // 존재 확인 (빈 스키마 허용 — RefreshCatalogInputSchema 등)
      expect(Array.isArray(schemaKeys(schemaNameOf(tool))), tool).toBe(true);
    }
  });

  it("핸들러(App 메서드)가 읽는 a.* 는 inputSchema 키", () => {
    for (const tool of TOOL_NAMES) {
      const method = APP_METHODS[tool as keyof typeof APP_METHODS] as string;
      const src = (ProcForgeApp.prototype as Record<string, (...a: never[]) => unknown>)[method].toString();
      const used = new Set<string>();
      for (const m of src.matchAll(/\ba\.([A-Za-z_$][\w$]*)/g)) used.add(m[1]);
      const keys = new Set(schemaKeys(schemaNameOf(tool)));
      for (const k of used) {
        expect(keys.has(k), `${tool}: handler reads a.${k}`).toBe(true);
      }
    }
  });

  it("설명서에 (필수/선택)으로 적힌 인자는 inputSchema 키", () => {
    for (const tool of TOOL_NAMES) {
      const desc = descriptionOf(tool);
      const mentioned = new Set<string>();
      for (const m of desc.matchAll(/([A-Za-z_][\w]*)\((필수|선택)/g)) mentioned.add(m[1]);
      const keys = new Set(schemaKeys(schemaNameOf(tool)));
      for (const k of mentioned) {
        expect(keys.has(k), `${tool}: description mentions ${k}`).toBe(true);
      }
    }
  });
});
