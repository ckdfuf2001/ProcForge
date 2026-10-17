import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CoreService } from "@procforge/core";
import { FileStore } from "../src/filestore.js";
import { createLocalStack } from "../src/core-inprocess.js";
import { clientMode } from "./client-mode.js";

// M7-ui4-h: TTL 판정 기준은 core가 커밋 세션에 심는 `lastWriteAt ?? createdAt`다.
// 가짜 시계로 확인한다 (실제 sleep 없음) — CI 슬로우/플레키를 원천 차단.
// **파일 store와 메모리 store가 같은 판정**을 내야 한다.

const catalog = [{ server: "t", name: "read", inputSchema: { type: "object" }, schemaHash: "h" }];
const passEval = async () => ({ ok: true, score: 1, detail: {} }) as never;

const TTL = 1_000;
function dir(): string {
  return join(mkdtempSync(join(tmpdir(), "pf-ttl2-")), ".procforge");
}
function clock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

async function writeOnce(svc: CoreService, sid: string) {
  await svc.pfLock({
    sessionId: sid,
    nodeId: "1",
    expectedRevision: (await svc.getSession(sid)).revision,
  });
}

describe("M7-ui4-h TTL = lastWriteAt ?? createdAt (가짜 시계)", () => {
  it("파일 store: 0.8s 쓰기 후 1.5s 읽기 생존 / 쓰기 없으면 만료", async () => {
    const pfdir = dir();
    const clk = clock();
    const svc = new CoreService(new FileStore(pfdir), passEval, {
      sessionTtlMs: TTL,
      now: clk.now,
    });
    const s = await svc.pfStart({ request: "r", toolCatalog: catalog as never });
    const sid = s.session.id;

    clk.advance(TTL * 0.8);
    await writeOnce(svc, sid);
    clk.advance(TTL * 0.7); // 마지막 쓰기 기준 1.5×TTL
    expect((await svc.getSession(sid)).id).toBe(sid);

    // 쓰기가 없으면 (createdAt 기준) 만료된다
    const s2 = await svc.pfStart({ request: "r2", toolCatalog: catalog as never });
    clk.advance(TTL * 1.5);
    await expect(svc.getSession(s2.session.id)).rejects.toThrow(/만료/);
  });

  it("메모리 store도 **같은 판정**", async () => {
    const clk = clock();
    const svc = new CoreService(undefined, passEval, { sessionTtlMs: TTL, now: clk.now });
    const s = await svc.pfStart({ request: "r", toolCatalog: catalog as never });
    const sid = s.session.id;
    clk.advance(TTL * 0.8);
    await writeOnce(svc, sid);
    clk.advance(TTL * 0.7);
    expect((await svc.getSession(sid)).id).toBe(sid);

    const s2 = await svc.pfStart({ request: "r2", toolCatalog: catalog as never });
    clk.advance(TTL * 1.5);
    await expect(svc.getSession(s2.session.id)).rejects.toThrow(/만료/);
  });

  it("읽기는 기준을 바꾸지 않는다 (쓰기만 연장)", async () => {
    const pfdir = dir();
    const clk = clock();
    const svc = new CoreService(new FileStore(pfdir), passEval, {
      sessionTtlMs: TTL,
      now: clk.now,
    });
    const s = await svc.pfStart({ request: "r", toolCatalog: catalog as never });
    const sid = s.session.id;
    await writeOnce(svc, sid);
    const p = join(pfdir, "sessions", sid, "session.json");
    const before = readFileSync(p, "utf8");
    clk.advance(TTL * 0.9);
    for (let i = 0; i < 10; i++) expect((await svc.getSession(sid)).id).toBe(sid);
    expect(readFileSync(p, "utf8")).toBe(before);
    // TTL을 넘으면 읽기가 만료를 알린다 (연장은 쓰기만)
    clk.advance(TTL * 0.2);
    await expect(svc.getSession(sid)).rejects.toThrow(/만료/);
  });

  it("커밋이 session.json에 심는다 (core가, 저장소가 아니라)", async () => {
    const pfdir = dir();
    const clk = clock();
    const store = new FileStore(pfdir);
    const svc = new CoreService(store, passEval, { now: clk.now });
    const s = await svc.pfStart({ request: "r", toolCatalog: catalog as never });
    const sid = s.session.id;
    clk.advance(5_000);
    await writeOnce(svc, sid);
    const raw = JSON.parse(
      readFileSync(join(pfdir, "sessions", sid, "session.json"), "utf8"),
    ) as { lastWriteAt: string; createdAt: string };
    expect(Date.parse(raw.lastWriteAt) - Date.parse(raw.createdAt)).toBe(5_000);
    // 저장소가 스스로 커밋해도 심지 않는다 (core 책임)
    store.commitChange(sid, {
      session: { ...store.getSession(sid)!, revision: 99 },
      nodes: [],
      events: [],
    });
    const raw2 = JSON.parse(
      readFileSync(join(pfdir, "sessions", sid, "session.json"), "utf8"),
    ) as { lastWriteAt: string };
    expect(raw2.lastWriteAt).toBe(raw.lastWriteAt);
  });

  it("로컬 스택(Client 경유)도 주입 시계로 판정", async () => {
    const pfdir = dir();
    const clk = clock();
    // createLocalStack은 옵션만 넘기므로 직접 조립한다 (같은 저장소를 쓰는 App 경로).
    const { ProcForgeApp } = await import("../src/app/app.js");
    const svc = new CoreService(new FileStore(pfdir), passEval, {
      sessionTtlMs: TTL,
      now: clk.now,
    });
    const app = new ProcForgeApp({ core: svc, procforgeDir: pfdir, projectRoot: pfdir });
    const s = await app.start({ request: "r", toolCatalog: catalog as never });
    clk.advance(TTL * 0.8);
    await app.lock({ sessionId: s.sessionId, nodeId: "1" });
    clk.advance(TTL * 0.7);
    expect((await app.readSession(s.sessionId)).revision).toBe(1);
  });

  it("remote 모드에서도 같은 판정 (모드별 결과 동일)", async () => {
    if (clientMode() !== "remote") return;
    const { testStack } = await import("./client-mode.js");
    // 원격 서버는 주입 시계를 못 받으므로 TTL 1s + 실제 대기(비율 유지)로 확인한다.
    const ttl = 3_000;
    const pfdir = dir();
    const { client } = testStack(pfdir, { sessionTtlMs: ttl });
    const s = await client.pfStart({ request: "r", toolCatalog: catalog as never });
    await new Promise((r) => setTimeout(r, Math.round(ttl * 0.8)));
    await writeOnce(client as unknown as CoreService, s.session.id);
    await new Promise((r) => setTimeout(r, Math.round(ttl * 0.7)));
    expect((await client.getSession(s.session.id)).id).toBe(s.session.id);

    const s2 = await client.pfStart({ request: "r2", toolCatalog: catalog as never });
    await new Promise((r) => setTimeout(r, Math.round(ttl * 1.5)));
    await expect(client.getSession(s2.session.id)).rejects.toThrow(/만료/);
  }, 60000);
});