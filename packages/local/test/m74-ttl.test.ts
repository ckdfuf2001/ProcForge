import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CoreService } from "@procforge/core";
import { FileStore } from "../src/filestore.js";
import { createLocalStack } from "../src/core-inprocess.js";
import { clientMode } from "./client-mode.js";

// M7-ui4-a: TTL 판정 기준은 **디스크**(session.json lastWriteAt)다.
// 메모리 lastUsed에 의존하면 (1) 프로세스 재시작 후, (2) 원격 core에서
// 요청마다 store가 새로 만들어지는 구조에서 판정이 사라진다.

const catalog = [{ server: "t", name: "read", inputSchema: { type: "object" }, schemaHash: "h" }];
const passEval = async () => ({ ok: true, score: 1, detail: {} }) as never;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 원격 모드는 HTTP 왕복 + 병렬 실행으로 수백 ms 흔들린다. TTL을 3배로 잡고
// **비율**은 그대로(쓰기 0.8×TTL, 읽기 1.5×TTL) 유지해 스케줄 여유를 준다.
const TTL_MS = 3000;
const WRITE_AT = Math.round(TTL_MS * 0.8);
const READ_AT = Math.round(TTL_MS * 1.5);

function dir(): string {
  return join(mkdtempSync(join(tmpdir(), "pf-ttl-")), ".procforge");
}

describe("M7-ui4-a TTL 판정 = lastWriteAt ?? createdAt", () => {
  let pfdir: string;
  beforeEach(() => {
    pfdir = dir();
  });

  it("쓰기 커밋이 session.json에 lastWriteAt를 남긴다", async () => {
    const { client } = createLocalStack(pfdir);
    const s = await client.pfStart({ request: "r", toolCatalog: catalog as never });
    // pf_start 는 saveSession 경로라 lastWriteAt 가 없을 수 있다 → 있으면 형식만 본다
    const raw = JSON.parse(readFileSync(join(pfdir, "sessions", s.session.id, "session.json"), "utf8"));
    if (raw.lastWriteAt !== undefined) expect(Number.isNaN(Date.parse(raw.lastWriteAt))).toBe(false);
    // 쓰기 1회 후에는 반드시 기록된다
    const rev = (await client.getSession(s.session.id)).revision;
    await client.pfLock({ sessionId: s.session.id, nodeId: "1", expectedRevision: rev });
    const after = JSON.parse(readFileSync(join(pfdir, "sessions", s.session.id, "session.json"), "utf8"));
    expect(Number.isNaN(Date.parse(after.lastWriteAt))).toBe(false);
  }, 30000);

  it("읽기는 기준을 바꾸지 않는다 (M7-ui2-b 유지)", async () => {
    const { client } = createLocalStack(pfdir);
    const s = await client.pfStart({ request: "r", toolCatalog: catalog as never });
    await client.pfLock({ sessionId: s.session.id, nodeId: "1", expectedRevision: 0 });
    const p = join(pfdir, "sessions", s.session.id, "session.json");
    const before = readFileSync(p, "utf8");
    for (let i = 0; i < 10; i++) await client.getSession(s.session.id);
    expect(readFileSync(p, "utf8")).toBe(before);
  }, 30000);

  it("TTL 1s: 0.8s 쓰기 후 1.5s 읽기 → 생존", async () => {
    const { client } = createLocalStack(pfdir, { sessionTtlMs: TTL_MS });
    const s = await client.pfStart({ request: "r", toolCatalog: catalog as never });
    await sleep(WRITE_AT);
    // 이 쓰기가 기준 시각을 갱신한다
    await client.pfLock({
      sessionId: s.session.id,
      nodeId: "1",
      expectedRevision: (await client.getSession(s.session.id)).revision,
    });
    await sleep(READ_AT - WRITE_AT); // 마지막 쓰기 기준으로 TTL을 넘는 시점
    expect((await client.getSession(s.session.id)).id).toBe(s.session.id);
  }, 30000);

  it("TTL 1s: 쓰기 없으면 1.5s 뒤 만료", async () => {
    const { client } = createLocalStack(pfdir, { sessionTtlMs: TTL_MS });
    const s = await client.pfStart({ request: "r", toolCatalog: catalog as never });
    await sleep(READ_AT);
    await expect(client.getSession(s.session.id)).rejects.toThrow(/만료/);
  }, 30000);

  it("재시작 후에도 동일 판정 (메모리 상태 리셋)", async () => {
    const { client } = createLocalStack(pfdir, { sessionTtlMs: TTL_MS });
    const s = await client.pfStart({ request: "r", toolCatalog: catalog as never });
    await sleep(WRITE_AT);
    await client.pfLock({
      sessionId: s.session.id,
      nodeId: "1",
      expectedRevision: (await client.getSession(s.session.id)).revision,
    });
    // 새 프로세스/새 store로 다시 연다
    const fresh = createLocalStack(pfdir, { sessionTtlMs: TTL_MS });
    await sleep(READ_AT - WRITE_AT);
    expect((await fresh.client.getSession(s.session.id)).id).toBe(s.session.id);
    // reference: 파일만 보면 lastWriteAt 이 기준이다
    const raw = JSON.parse(readFileSync(join(pfdir, "sessions", s.session.id, "session.json"), "utf8"));
    expect(Date.now() - Date.parse(raw.lastWriteAt)).toBeLessThan(TTL_MS);
  }, 30000);

  it("FileStore를 새로 만들어도 판정이 같다", async () => {
    const store = new FileStore(pfdir);
    const svc = new CoreService(store, passEval, { sessionTtlMs: TTL_MS });
    const s = await svc.pfStart({ request: "r", toolCatalog: catalog as never });
    await sleep(READ_AT);
    const svc2 = new CoreService(new FileStore(pfdir), passEval, { sessionTtlMs: TTL_MS });
    await expect(svc2.getSession(s.session.id)).rejects.toThrow(/만료/);
  }, 30000);

  it("remote 모드에서도 같은 판정 (모드별 결과 동일)", async () => {
    if (clientMode() !== "remote") return; // remote 스위트에서만 의미 있다
    const { testStack } = await import("./client-mode.js");
    const { client } = testStack(pfdir, { sessionTtlMs: TTL_MS });
    const s = await client.pfStart({ request: "r", toolCatalog: catalog as never });
    await sleep(WRITE_AT);
    await client.pfLock({
      sessionId: s.session.id,
      nodeId: "1",
      expectedRevision: (await client.getSession(s.session.id)).revision,
    });
    await sleep(READ_AT - WRITE_AT);
    // HTTP로 새 요청마다 store가 새로 만들어져도 기준은 디스크에 있다
    expect((await client.getSession(s.session.id)).id).toBe(s.session.id);
    const s2 = await client.pfStart({ request: "r2", toolCatalog: catalog as never });
    await sleep(READ_AT);
    await expect(client.getSession(s2.session.id)).rejects.toThrow(/만료/);
  }, 60000);
});