import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProcForgeApp } from "../src/app/app.js";
import { loadPairings, savePairing } from "../src/services/pairings.js";
import {
  discoverPairing,
  pfStartOutputSessionId,
} from "../src/services/pair-discovery.js";

// M8-1-pair: 첫 짝 찾기 (docs/M8-1-spec.md b2). 실제 네트워크 0 —
// OpenCode 서버를 메모리 fetch 로 흉내 낸다. 페이징은 실측 형식(?limit, X-Next-Cursor).

type Part = Record<string, unknown>;
type Msg = { info: { id: string }; parts: Part[] };
type Oc = {
  sessions: Map<string, { updated: number; msgs: Msg[] }>;
  hang: Set<string>;
  calls: string[];
  posts: string[];
  postPfSid: string;
};

const pfStart = (sid: string, status = "completed"): Part => ({
  type: "tool",
  tool: "procforge_pf_start",
  state: { status, output: JSON.stringify({ sessionId: sid }) },
});
const pfNext = (sid: string): Part => ({
  type: "tool",
  tool: "procforge_pf_next",
  state: { status: "completed", input: { sessionId: sid }, output: "{}" },
});
const textOnly = (sid: string): Part => ({
  type: "text",
  text: `procforge_pf_start ${JSON.stringify({ sessionId: sid })}`,
});

function msgsOf(parts: Part[][]): Msg[] {
  return parts.map((p, i) => ({ info: { id: `msg_${String(i).padStart(4, "0")}` }, parts: p }));
}

function fakeOc(
  init: Record<string, { updated: number; msgs: Msg[] }>,
  opts: { hang?: string[]; postPfSid?: string } = {},
): Oc {
  return {
    sessions: new Map(Object.entries(init)),
    hang: new Set(opts.hang ?? []),
    calls: [],
    posts: [],
    postPfSid: opts.postPfSid ?? "",
  };
}

function fetchOf(oc: Oc): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    oc.calls.push(`${method} ${url.pathname}${url.search}`);
    const json = (v: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(v), {
        status: 200,
        headers: { "content-type": "application/json", ...headers },
      });
    if (method === "GET" && url.pathname === "/session") {
      return json(
        [...oc.sessions].map(([id, s]) => ({ id, time: { updated: s.updated } })),
      );
    }
    const alive = /^\/session\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && alive) {
      const sid = decodeURIComponent(alive[1]!);
      return oc.sessions.has(sid)
        ? json({ id: sid })
        : new Response("", { status: 404 });
    }
    const mMsg = /^\/session\/([^/]+)\/message$/.exec(url.pathname);
    if (method === "GET" && mMsg) {
      const sid = decodeURIComponent(mMsg[1]!);
      if (oc.hang.has(sid)) {
        // 응답 없음 → 요청 상한(AbortSignal)에서만 끊긴다
        return new Promise<Response>((_, rej) =>
          init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))),
        );
      }
      const all = oc.sessions.get(sid)?.msgs ?? [];
      const limitQ = url.searchParams.get("limit");
      const limit = limitQ ? Number(limitQ) : all.length;
      const beforeQ = url.searchParams.get("before");
      const end = beforeQ ? Number(beforeQ.slice(1)) : all.length;
      const start = Math.max(0, end - limit);
      const next = start > 0 ? `c${start}` : undefined;
      return json(all.slice(start, end), next ? { "x-next-cursor": next } : {});
    }
    if (method === "POST" && mMsg) {
      const sid = decodeURIComponent(mMsg[1]!);
      oc.posts.push(sid);
      const s = oc.sessions.get(sid);
      if (s) {
        s.msgs.push({
          info: { id: `msg_post_${oc.posts.length}` },
          parts: [pfNext(oc.postPfSid)],
        });
      }
      return json({ data: { admittedSeq: 1 } });
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
}

function setup(oc: Oc) {
  const pfdir = join(mkdtempSync(join(tmpdir(), "pf-disc-")), ".procforge");
  const app = new ProcForgeApp({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    core: {} as any,
    procforgeDir: pfdir,
    projectRoot: pfdir,
    linkFetchImpl: fetchOf(oc),
    signal: {
      baseUrl: "http://oc.fake",
      mode: "b",
      serverVersion: "1.18.18",
      toolPrefix: "procforge",
    },
  });
  return { app, pfdir };
}

const S1 = "pf-s1";
const S2 = "pf-s2";

describe("M8-1-pair 첫 짝 찾기", () => {
  it("① X(S1)·Y(S2): S1 신호가 X로 전송, pairings 에 X↔S1 source discovered (X 는 120개 메시지, 페이징 3쪽)", async () => {
    const xMsgs = msgsOf([
      [pfStart(S1)],
      ...Array.from({ length: 119 }, () => [{ type: "text", text: "..." } as Part]),
    ]);
    const oc = fakeOc(
      {
        X: { updated: 2000, msgs: xMsgs },
        Y: { updated: 1000, msgs: msgsOf([[pfStart(S2)]]) },
      },
      { postPfSid: S1 },
    );
    const { app, pfdir } = setup(oc);
    const r = await app.signalOnly({ sessionId: S1, nodeId: "1.1" });
    expect(r).toMatchObject({ delivered: true, mode: "b" });
    expect(oc.posts).toEqual(["X"]);
    const saved = loadPairings(pfdir).pairs["X"];
    expect(saved).toMatchObject({ openCodeSessionId: "X", pfSessionId: S1, source: "discovered" });
    // 페이징: 120 메시지 → limit=50 으로 세 번 읽었다
    expect(oc.calls.filter((c) => c.startsWith("GET /session/X/message?limit=50")).length).toBe(3);
  });

  it("② Z(S1) 추가 → 짝 모호(2개), 전송 요청 0, pairings 불변", async () => {
    const oc = fakeOc(
      {
        X: { updated: 3000, msgs: msgsOf([[pfStart(S1)]]) },
        Z: { updated: 2000, msgs: msgsOf([[pfStart(S1)]]) },
        Y: { updated: 1000, msgs: msgsOf([[pfStart(S2)]]) },
      },
      { postPfSid: S1 },
    );
    const { app, pfdir } = setup(oc);
    const r = await app.signalOnly({ sessionId: S1, nodeId: "1.1" });
    expect(r).toMatchObject({ delivered: false, degraded: "짝 모호(2개). 전송하지 않음" });
    expect(oc.posts).toEqual([]);
    expect(existsSync(join(pfdir, "pairings.json"))).toBe(false);
  });

  it("③ 텍스트 파트에만 S1 이 있는 세션은 무시 → 짝 세션 못 찾음, 전송 0", async () => {
    const oc = fakeOc(
      {
        T: { updated: 3000, msgs: msgsOf([[textOnly(S1)]]) },
        // 도구 파트지만 실패 상태 — 완료된 출력만 근거다
        F: {
          updated: 2000,
          msgs: msgsOf([[pfStart(S1, "error")]]),
        },
      },
      { postPfSid: S1 },
    );
    const { app, pfdir } = setup(oc);
    const r = await app.signalOnly({ sessionId: S1, nodeId: "1.1" });
    expect(r).toMatchObject({ delivered: false, degraded: "짝 세션 못 찾음. 전송하지 않음" });
    expect(oc.posts).toEqual([]);
    expect(existsSync(join(pfdir, "pairings.json"))).toBe(false);
    // 텍스트 파트 단독 판정 단위 확인
    expect(pfStartOutputSessionId(textOnly(S1), "procforge")).toBeUndefined();
  });

  it("④ 한 세션 메시지 조회가 응답 없음 → 짝 확인 불가(1개), 전송 0 (S1 이 다른 세션에 있어도)", async () => {
    const oc = fakeOc(
      {
        H: { updated: 3000, msgs: msgsOf([[pfStart(S2)]]) },
        X: { updated: 2000, msgs: msgsOf([[pfStart(S1)]]) },
      },
      { hang: ["H"], postPfSid: S1 },
    );
    const { app, pfdir } = setup(oc);
    const r = await app.signalOnly({ sessionId: S1, nodeId: "1.1" });
    expect(r).toMatchObject({ delivered: false, degraded: "짝 확인 불가(1개). 전송하지 않음" });
    expect(oc.posts).toEqual([]);
    expect(existsSync(join(pfdir, "pairings.json"))).toBe(false);
  }, 10_000);

  it("⑤ 이미 짝이 있으면 찾기 요청 0 (GET /session 목록도 안 부름)", async () => {
    const oc = fakeOc(
      {
        X: { updated: 2000, msgs: msgsOf([[pfStart(S1)]]) },
        Y: { updated: 1000, msgs: msgsOf([[pfStart(S1)]]) },
      },
      { postPfSid: S1 },
    );
    const { app, pfdir } = setup(oc);
    // 수동/기존 짝: Y↔S1 (찾기 대상이 아니다)
    savePairing(pfdir, "Y", S1);
    const r = await app.signalOnly({ sessionId: S1, nodeId: "1.1" });
    expect(r).toMatchObject({ delivered: true });
    expect(oc.calls.some((c) => c === "GET /session")).toBe(false);
    expect(oc.calls.some((c) => c.includes("/session/X/message"))).toBe(false);
    expect(loadPairings(pfdir).pairs["Y"]?.source).toBeUndefined();
  });

  it("판정 단위: 목록 조회 실패 → 짝 확인 불가(세션 목록 조회 실패)", async () => {
    const failing = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    const r = await discoverPairing({
      baseUrl: "http://oc.fake",
      pfSessionId: S1,
      toolPrefix: "procforge",
      fetchImpl: failing,
    });
    expect(r).toEqual({ status: "unknown", count: 0, reason: "세션 목록 조회 실패" });
  });
});
