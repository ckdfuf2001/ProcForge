import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { createUiServer, type UiServer } from "../src/app/ui-server.js";
import { ProcForgeApp } from "../src/app/app.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

useTmpCleanup();

// M10-3-api: ui-server 4경로 (why·similar·drafts·apply). 경로마다 정상 1건 + 거부 1건.

const CAT = [
  { server: "t", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;

let root: string;
let pfdir: string;
let app: ProcForgeApp;
let srv: UiServer;

beforeEach(async () => {
  root = makeTmp("pf-m103api-");
  pfdir = join(root, ".procforge");
  const { client } = testStack(pfdir);
  app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
  srv = await createUiServer({ app, staticDir: makeTmp("pf-m103apie-") });
});

afterEach(async () => {
  await srv.close();
});

function h() {
  return {
    "content-type": "application/json",
    "x-procforge-token": srv.token,
  };
}

async function startSplit(children: { goal: string; why?: string }[] = [{ goal: "a" }]) {
  const s = await app.start({ request: "r", toolCatalog: CAT });
  await app.split({
    sessionId: s.sessionId,
    nodeId: "1",
    reason: "분해 사유입니다 0123456789",
    children,
  } as never);
  return s.sessionId;
}

function writeProcedure(name: string, nodes: unknown[]) {
  const dir = join(pfdir, "procedures", name);
  mkdirSync(dir, { recursive: true });
  const raw = JSON.stringify({
    format: "procforge-procedure",
    version: 1,
    name,
    sourceSession: "s",
    createdAt: new Date(0).toISOString(),
    params: {},
    toolCatalog: [],
    nodes,
  });
  writeFileSync(join(dir, "procedure.json"), raw);
  return raw;
}

const DOC_NODE = (id: string, goal: string, extra: Record<string, unknown> = {}) => ({
  id,
  parentId: id.includes(".") ? id.slice(0, id.lastIndexOf(".")) : null,
  goal,
  depth: id.split(".").length - 1,
  dependsOn: [],
  children: [],
  sideEffect: "none",
  constraints: [],
  ...extra,
});

function writeDraft(id: string, draft: Record<string, unknown>) {
  const dir = join(pfdir, "drafts", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "draft.json"), JSON.stringify(draft));
}

describe("M10-3-api", () => {
  it("① POST why: 정상은 저장, 공백은 400", async () => {
    const sid = await startSplit();
    const ok = await fetch(`${srv.url}/api/sessions/${sid}/nodes/1.1/why`, {
      method: "POST",
      headers: h(),
      body: JSON.stringify({ why: "바꾼 이유" }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { node: { why?: string } }).node.why).toBe("바꾼 이유");
    const bad = await fetch(`${srv.url}/api/sessions/${sid}/nodes/1.1/why`, {
      method: "POST",
      headers: h(),
      body: JSON.stringify({ why: "   " }),
    });
    expect(bad.status).toBe(400);
  });

  it("② GET similar: 정상은 목록, limit 문자은 400", async () => {
    writeProcedure("m10-mem", [DOC_NODE("1", "월간보고서 쓰기")]);
    const ok = await fetch(`${srv.url}/api/procedures/similar?query=`, {
      headers: { "x-procforge-token": srv.token },
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { procedures: { name: string }[] };
    expect(body.procedures.map((p) => p.name)).toContain("m10-mem");
    const bad = await fetch(`${srv.url}/api/procedures/similar?limit=abc`, {
      headers: { "x-procforge-token": srv.token },
    });
    expect(bad.status).toBe(400);
  });

  it("③ GET drafts/:id: 정상은 draft, 없으면 404", async () => {
    writeDraft("d1", {
      draftId: "d1",
      procedure: "m10-rd",
      request: "r",
      sourceHash: "h",
      openCodeSessionId: null,
      status: "ready",
      ops: [],
      diff: [],
      at: new Date(0).toISOString(),
    });
    const ok = await fetch(`${srv.url}/api/drafts/d1`, {
      headers: { "x-procforge-token": srv.token },
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { procedure: string }).procedure).toBe("m10-rd");
    const missing = await fetch(`${srv.url}/api/drafts/nope`, {
      headers: { "x-procforge-token": srv.token },
    });
    expect(missing.status).toBe(404);
  });

  it("④ POST drafts/:id/apply: 정상은 대상만 변경, 해시 불일치는 409", async () => {
    const raw = writeProcedure("m10-rd", [
      DOC_NODE("1", "그리기"),
      DOC_NODE("1.1", "선 그리기", { why: "옛 이유", args: { color: { kind: "fixed", value: "red" } } }),
      DOC_NODE("1.2", "채우기"),
    ]);
    const hash = createHash("sha256").update(raw, "utf8").digest("hex");
    writeDraft("d1", {
      draftId: "d1",
      procedure: "m10-rd",
      request: "이유를 바꿔라",
      sourceHash: hash,
      openCodeSessionId: null,
      status: "ready",
      ops: [{ op: "edit_why", nodeId: "1.1", why: "새 이유", reason: "요청 반영" }],
      diff: [{ nodeId: "1.1", kind: "why", before: "옛 이유", after: "새 이유" }],
      at: new Date(0).toISOString(),
    });
    const ok = await fetch(`${srv.url}/api/drafts/d1/apply`, {
      method: "POST",
      headers: h(),
      body: JSON.stringify({ opIds: [0] }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { applied: unknown[] }).applied).toHaveLength(1);
    const after = JSON.parse(readFileSync(join(pfdir, "procedures", "m10-rd", "procedure.json"), "utf8")) as {
      nodes: { id: string; why?: string }[];
    };
    expect(after.nodes.find((n) => n.id === "1.1")?.why).toBe("새 이유");
    expect(after.nodes.find((n) => n.id === "1.2")?.why).toBeUndefined();
    appendFileSync(join(pfdir, "procedures", "m10-rd", "procedure.json"), " ");
    const stale = await fetch(`${srv.url}/api/drafts/d1/apply`, {
      method: "POST",
      headers: h(),
      body: JSON.stringify({ opIds: [0] }),
    });
    expect(stale.status).toBe(409);
  });
});
