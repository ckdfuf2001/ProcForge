import { describe, it, expect, beforeEach } from "vitest";
import {
  mkdtempSync,
  cpSync,
  readFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { FileStore } from "../src/filestore.js";
import { loadProcedureDoc } from "../src/runner/procedure-run.js";
import {
  testStack,
  importProc,
  metaStore,
  serverSessionDir,
} from "./client-mode.js";
import {
  computeApprovalHash,
  toHashable,
  toHashableMap,
} from "../src/services/approvals.js";

// M5.5-4.4-5: toHashable 단일 변환. examples/procedures/* 전 노드에서
// doc approvalHash == 세션 approvalHash (캐스팅 없이 동일 공식).

const EXAMPLES = resolve(__dirname, "..", "..", "..", "examples", "procedures");

let pfdir: string;

beforeEach(() => {
  pfdir = join(mkdtempSync(join(tmpdir(), "pf-m544h-")), ".procforge");
});

function exampleNames(): string[] {
  return readdirSync(EXAMPLES, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() && existsSync(join(EXAMPLES, e.name, "procedure.json")),
    )
    .map((e) => e.name);
}

function readOpt(base: string): {
  readScript: (rel: string) => string | undefined;
} {
  return {
    readScript: (rel: string) => {
      try {
        return readFileSync(join(base, rel), "utf8");
      } catch {
        return undefined;
      }
    },
  };
}

describe("M5.5-4.4-5 toHashable doc·세션 일치", () => {
  it("examples/procedures/* 전 노드 approvalHash 동일", async () => {
    const { client } = testStack(pfdir);
    const names = exampleNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      cpSync(join(EXAMPLES, name), join(pfdir, "procedures", name), {
        recursive: true,
      });
      const { doc, dir } = loadProcedureDoc(pfdir, name);
      const docById = toHashableMap(new Map(doc.nodes.map((n) => [n.id, n])));
      // 필수 params는 더미값 (값 자체는 해시에 들어가지 않고 ref 문자열만 사용).
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(
        (doc as { params?: Record<string, { default?: string }> }).params ?? {},
      )) {
        params[k] = v.default ?? "test";
      }
      const { sessionId } = await importProc(client, pfdir, doc, params);
      const sessById = toHashableMap(metaStore(pfdir).getNodes(sessionId));
      const docRead = readOpt(dir);
      // 스크립트 파일은 로컬 세션 dir 복사본 (copyImportFiles, 양 모드 동일).
      const sessRead = readOpt(join(pfdir, "sessions", sessionId));
      for (const n of doc.nodes) {
        const a = computeApprovalHash(
          docById.get(n.id)!,
          docById,
          new Set(),
          docRead,
        );
        const b = computeApprovalHash(
          sessById.get(n.id)!,
          sessById,
          new Set(),
          sessRead,
        );
        expect(b, `${name}/${n.id}`).toBe(a);
      }
    }
  });
});
