import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ProcForgeApp } from "../src/app/app.js";
import { FileStore } from "../src/filestore.js";
import { testStack } from "./client-mode.js";
import {
  buildApprovalEntry,
  saveApproval,
  loadApprovals,
  checkApproval,
  approvalPins,
  toHashableMap,
} from "../src/services/approvals.js";
import type { CoreClient } from "@proof/shared/core-client.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

useTmpCleanup();

// M10-3-apply-fix: 잠금·원자·history·승인리셋.
// ① 실행 중 거부 ② history 생성 ③ 승인 확인(stale) ④ 다른 노드 불변.

const CAT = [
  { server: "t", name: "echo", inputSchema: {}, schemaHash: "h" },
] as never;

let root: string;
let pfdir: string;
let app: ProcForgeApp;
let client: CoreClient;

function docWith(goal1: string) {
  return {
    format: "procforge-procedure",
    version: 1,
    name: "appr",
    sourceSession: "s",
    createdAt: new Date(0).toISOString(),
    params: {},
    toolCatalog: CAT,
    nodes: [
      {
        id: "1", parentId: null, goal: goal1, depth: 0, children: [],
        tool: { server: "t", name: "sh", schemaHash: "h" },
        args: { cmd: { kind: "fixed", value: "echo hi" } },
        sideEffect: "external", dependsOn: [], constraints: [],
      },
      {
        id: "2", parentId: null, goal: "그대로", depth: 0, children: [],
        tool: { server: "t", name: "sh", schemaHash: "h" },
        args: { cmd: { kind: "fixed", value: "echo yo" } },
        sideEffect: "external", dependsOn: [], constraints: [],
      },
    ],
  };
}

function writeProc(doc: unknown): string {
  const dir = join(pfdir, "procedures", "appr");
  mkdirSync(dir, { recursive: true });
  const raw = JSON.stringify(doc, null, 2);
  writeFileSync(join(dir, "procedure.json"), raw);
  return raw;
}

function writeDraft(id: string, procedure: string, sourceHash: string, ops: unknown[]) {
  const dir = join(pfdir, "drafts", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "draft.json"),
    JSON.stringify({
      draftId: id, procedure, request: "req", sourceHash, status: "ready",
      ops, diff: [], reason: "r",
    }),
  );
}

function seedApproval(nodeId: string, goal: string) {
  const dir = join(pfdir, "procedures", "appr");
  const entry = buildApprovalEntry(
    {
      id: nodeId, goal,
      tool: { server: "t", name: "sh" },
      args: { cmd: { kind: "fixed", value: nodeId === "1" ? "echo hi" : "echo yo" } },
      constraints: [], sideEffect: "external",
    },
    [],
  );
  saveApproval(dir, entry);
  return entry;
}

beforeEach(() => {
  root = makeTmp("pf-m103afx-");
  pfdir = join(root, ".procforge");
  ({ client } = testStack(pfdir));
  app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
});

describe("M10-3-apply-fix", () => {
  it("① 실행 중(.run.lock)에는 409, 끝나면 200", async () => {
    const raw = writeProc(docWith("원래 목표"));
    const hash = createHash("sha256").update(raw, "utf8").digest("hex");
    writeDraft("d1", "appr", hash, [
      { op: "edit_goal", nodeId: "1", goal: "바뀐 목표", reason: "다듬기" },
    ]);
    const release = new FileStore(pfdir).acquireFileLock(
      join(pfdir, "procedures", "appr", ".run.lock"),
      "test run lock",
      60000,
    );
    try {
      await expect(app.applyDraft({ draftId: "d1", opIds: [0] })).rejects.toThrow(
        /실행 중인 절차서/,
      );
    } finally {
      release();
    }
    const out = await app.applyDraft({ draftId: "d1", opIds: [0] });
    expect(out.changedNodes).toEqual(["1"]);
  });

  it("② 적용 전 판본이 history/에 남는다", async () => {
    const raw = writeProc(docWith("원래 목표"));
    const hash = createHash("sha256").update(raw, "utf8").digest("hex");
    writeDraft("d1", "appr", hash, [
      { op: "edit_goal", nodeId: "1", goal: "바뀐 목표", reason: "다듬기" },
    ]);
    await app.applyDraft({ draftId: "d1", opIds: [0] });
    const histDir = join(pfdir, "procedures", "appr", "history");
    expect(existsSync(histDir)).toBe(true);
    const files = readdirSync(histDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(new RegExp(`-${hash.slice(0, 12)}\\.json$`));
    // 보관본은 적용 전과 바이트 동일.
    expect(readFileSync(join(histDir, files[0]), "utf8")).toBe(raw);
  });

  it("③ goal 바뀐 승인 노드는 approvalReset + checkApproval stale", async () => {
    const raw = writeProc(docWith("원래 목표"));
    const hash = createHash("sha256").update(raw, "utf8").digest("hex");
    const entry = seedApproval("1", "원래 목표");
    seedApproval("2", "그대로");
    writeDraft("d1", "appr", hash, [
      { op: "edit_goal", nodeId: "1", goal: "바뀐 목표", reason: "다듬기" },
    ]);
    const out = await app.applyDraft({ draftId: "d1", opIds: [0] });
    expect(out.approvalReset).toEqual(["1"]);
    // 실제 경로: 적용 후 procedure.json을 다시 import한 노드로 pins 계산.
    const afterRaw = readFileSync(join(pfdir, "procedures", "appr", "procedure.json"), "utf8");
    const imported = await client.pfImportProcedure({
      doc: JSON.parse(afterRaw) as never,
      params: {},
    });
    const node = await client.getNode(imported.sessionId, "1");
    const pins = approvalPins(node, undefined, toHashableMap(new Map([[node.id, node]])));
    const stored = loadApprovals(join(pfdir, "procedures", "appr"));
    const kept = stored.find((e) => e.node.id === "1") ?? entry;
    expect(
      checkApproval([kept], pins, "t", "sh", { cmd: "echo hi" }),
    ).toBe("stale");
    // 같은 해시면 ok (판정식 자체 확인).
    const okVerdict = checkApproval(
      [kept],
      [{ id: kept.node.id, hash: kept.node.hash, approvalHash: kept.approvalHash }],
      "t", "sh",
      kept.args as Record<string, unknown>,
    );
    expect(okVerdict).toBe("ok");
  });

  it("④ 다른 노드 불변 + why-only는 approvalReset 없음", async () => {
    const raw = writeProc(docWith("원래 목표"));
    const hash = createHash("sha256").update(raw, "utf8").digest("hex");
    seedApproval("1", "원래 목표");
    seedApproval("2", "그대로");
    writeDraft("d1", "appr", hash, [
      { op: "edit_why", nodeId: "1", why: "이유 한 줄", reason: "보강" },
    ]);
    const out = await app.applyDraft({ draftId: "d1", opIds: [0] });
    expect(out.changedNodes).toEqual(["1"]);
    expect(out.approvalReset).toEqual([]);
    const after = JSON.parse(
      readFileSync(join(pfdir, "procedures", "appr", "procedure.json"), "utf8"),
    ) as { nodes: { id: string; goal: string; args: unknown; why?: string }[] };
    const n2 = after.nodes.find((n) => n.id === "2");
    expect(n2?.goal).toBe("그대로");
    const n1 = after.nodes.find((n) => n.id === "1");
    expect(n1?.goal).toBe("원래 목표");
    expect(n1?.why).toBe("이유 한 줄");
  });
});
