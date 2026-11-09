import { describe, it, expect, beforeEach } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

useTmpCleanup();

// M10-gate-unify 추가 테스트: finalize는 잠금을 획득하기 전에 어떤 파일도
// 쓰지 않는다. 검증 실패 시 procedures/ 아래 파일 수와 mtime이 그대로다.

const CAT = [
  { server: "fake-ppt", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;

let root: string;
let pfdir: string;
let app: ProcForgeApp;

function snapProcedures(): Map<string, number> {
  const out = new Map<string, number>();
  const dir = join(pfdir, "procedures");
  const walk = (d: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      const r = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(p, r);
      else out.set(r, statSync(p).mtimeMs);
    }
  };
  walk(dir, "");
  return out;
}

beforeEach(() => {
  root = makeTmp("pf-m10fin-");
  pfdir = join(root, ".procforge");
  const { client } = testStack(pfdir);
  app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
  void app;
});

describe("M10 finalize 무쓰기", () => {
  it("검증 실패 시 procedures/ 파일 수·mtime 그대로", async () => {
    const { client } = testStack(pfdir);
    const app2 = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
    const started = await client.pfStart({ request: "미완성", params: {}, toolCatalog: CAT });
    const sid = started.session.id;
    await client.pfResolve({
      sessionId: sid,
      nodeId: "1",
      decision: "split",
      children: [{ goal: "덜 된 자식" }],
    } as never);
    // 1.1 pending 상태로 finalize → 검증 실패해야 한다.
    const before = snapProcedures();
    let code = "";
    try {
      await app2.finalize({ sessionId: sid, name: "m10-unfinished" });
    } catch (e) {
      code = String((e as { code?: unknown }).code ?? e);
    }
    expect(code).toBe("bad_request");
    const after = snapProcedures();
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [k, mtime] of before) {
      expect(after.get(k)).toBe(mtime);
    }
  }, 120000);
});
