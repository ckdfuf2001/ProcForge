import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createUiServer, type UiServer } from "../src/app/ui-server.js";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

useTmpCleanup();

// M10-entry-fix 결함 1: readOnly에서는 쓰기 경로를 막는다.
// POST /api/drafts/:id/apply, /api/guides, /api/guides/:gid/advance → 4xx,
// procedure.json·guides/ 변경 없음.

let root: string;
let pfdir: string;
let app: ProcForgeApp;
let srv: UiServer;

function writeProcDoc(): string {
  const raw = JSON.stringify({
    format: "procforge-procedure",
    version: 1,
    name: "memo",
    sourceSession: "s",
    createdAt: new Date(0).toISOString(),
    params: {},
    toolCatalog: [],
    tree: { rootId: "1", nodes: [] },
    nodes: [{ id: "1", parentId: null, goal: "g", depth: 0, children: [], dependsOn: [], sideEffect: "none", constraints: [] }],
  });
  const dir = join(pfdir, "procedures", "memo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "procedure.json"), raw);
  return raw;
}

async function postJson(path: string, body: unknown): Promise<{ status: number }> {
  const r = await fetch(`${srv.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-procforge-token": srv.token },
    body: JSON.stringify(body),
  });
  return { status: r.status };
}

beforeEach(async () => {
  root = makeTmp("pf-m10ro-");
  pfdir = join(root, ".procforge");
  const { client } = testStack(pfdir);
  app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
  srv = await createUiServer({ app, staticDir: makeTmp("pf-m10roe-"), readOnly: true });
});

afterEach(async () => {
  await srv.close();
});

describe("M10-entry readOnly", () => {
  it("쓰기 3경로가 4xx + 파일 변경 없음", async () => {
    const raw = writeProcDoc();
    const hashBefore = createHash("sha256").update(raw, "utf8").digest("hex");
    // 초안(ready) 준비 — apply 대상.
    const draftId = "d9";
    mkdirSync(join(pfdir, "drafts", draftId), { recursive: true });
    writeFileSync(
      join(pfdir, "drafts", draftId, "draft.json"),
      JSON.stringify({
        draftId, procedure: "memo", request: "r", sourceHash: hashBefore,
        status: "ready", ops: [{ op: "edit_goal", nodeId: "1", goal: "g2", reason: "r" }],
        diff: [], reason: "r",
      }),
    );
    // 가이드 준비 — advance 대상.
    const g = await app.startGuide({ steps: [{ procedure: "memo", params: {} }] });
    const guidesBefore = existsSync(join(pfdir, "guides"))
      ? readdirSync(join(pfdir, "guides")).length
      : 0;

    const a = await postJson(`/api/drafts/${draftId}/apply`, { opIds: [0] });
    expect(a.status).toBeGreaterThanOrEqual(400);
    const b = await postJson("/api/guides", { steps: [{ procedure: "memo", params: {} }] });
    expect(b.status).toBeGreaterThanOrEqual(400);
    const c = await postJson(`/api/guides/${g.guideId}/advance`, {});
    expect(c.status).toBeGreaterThanOrEqual(400);

    // 파일 변경 없음.
    const rawAfter = readFileSync(join(pfdir, "procedures", "memo", "procedure.json"), "utf8");
    expect(createHash("sha256").update(rawAfter, "utf8").digest("hex")).toBe(hashBefore);
    const guidesAfter = existsSync(join(pfdir, "guides"))
      ? readdirSync(join(pfdir, "guides")).length
      : 0;
    expect(guidesAfter).toBe(guidesBefore);
  });
});
