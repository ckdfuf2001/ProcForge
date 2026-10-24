import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import {
  sendContinue,
  extractPfSessionId,
  httpLinkDeps,
} from "../src/services/opencode-link.js";
import {
  savePairing,
  getPairing,
  loadPairings,
} from "../src/services/pairings.js";
import { ProcForgeApp, type SignalTarget } from "../src/app/app.js";

// M7-1: UI→OpenCode 연결 B/A/C + plan 모드 E2E (가짜 opencode 서버).
// M7-1.1 실서버 확인 재현: POST /session/:id/message + {parts} → 200
// ({"prompt":{...}} 래퍼는 이 경로에서 400), /tui/append-prompt → true,
// GET /event SSE.

type Part = Record<string, unknown>;
type FakeScenario = "b-ok" | "plan" | "a-ok" | "no-session";

function startFake(
  scenario: FakeScenario,
  opts: { attachedSid?: string; pfIds?: string[]; seed?: { sid: string; parts: Part[] } } = {},
): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  requests: string[];
  bodies: unknown[];
  partsOf: (sid: string) => Part[];
}> {
  const store = new Map<string, Part[]>();
  const requests: string[] = [];
  const bodies: unknown[] = [];
  const pfQueue = [...(opts.pfIds ?? ["pf-fake-1"])];
  const partsOf = (sid: string) => store.get(sid) ?? [];
  if (opts.seed) store.set(opts.seed.sid, [...opts.seed.parts]);
  const push = (sid: string, p: Part) => {
    store.set(sid, [...partsOf(sid), p]);
  };
  const toolPart = (sid: string): Part => ({
    // 짝짓기는 pf_start output의 sessionId로 한다 (M7-0 §3, extractPfSessionId).
    type: "tool",
    tool: "procforge_pf_start",
    part: { sessionID: sid, tool: "procforge_pf_start" },
    state: {
      status: "completed",
      output: JSON.stringify({ sessionId: pfQueue.shift() ?? "pf-fake-x" }),
    },
  });
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString("utf8");
    });
    await new Promise<void>((r) => req.on("end", () => r()));
    requests.push(`${req.method} ${url.pathname}`);
    const send = (code: number, v: unknown) => {
      const text = JSON.stringify(v);
      res.writeHead(code, { "content-type": "application/json" });
      res.end(text);
    };
    const mMsg = /^\/session\/([^/]+)\/message$/.exec(url.pathname);
    if (req.method === "POST" && mMsg) {
      const sid = mMsg[1];
      let parsed: { parts?: unknown; prompt?: unknown } = {};
      try {
        parsed = JSON.parse(body) as typeof parsed;
      } catch {
        send(400, { error: "bad body" });
        return;
      }
      bodies.push(parsed);
      // M7-1.1 실서버 확인 (1.18.18): /session/:id/message는 {parts} → 200,
      // {"prompt":{...}} 래퍼는 400.
      if (!Array.isArray(parsed.parts)) {
        send(400, { error: "parts required" });
        return;
      }
      if (scenario === "b-ok") {
        // 신호 시점에 동기 push (폴링-읽기 경쟁 제거. 실서버는 비동기).
        push(sid, toolPart(sid));
      } else if (scenario === "plan") {
        // plan 모드: 텍스트만 응답, pf_* 호출 없음.
        setTimeout(() => {
          push(sid, { type: "text", text: "검토했습니다." });
        }, 30);
      }
      send(200, { data: { admittedSeq: 1 } });
      return;
    }
    if (req.method === "GET" && mMsg) {
      send(200, { data: partsOf(mMsg[1]) });
      return;
    }
    // M8-1 ①: 짝 세션 생존 확인 (GET /session/:id). "no-session" 시나리오에서는
    // 그 세션이 없는 것으로 답한다(404).
    const mSession = /^\/session\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && mSession) {
      if (scenario === "no-session") {
        send(404, { error: "session not found" });
        return;
      }
      send(200, { id: mSession[1] });
      return;
    }
    if (req.method === "POST" && url.pathname === "/tui/append-prompt") {
      try {
        bodies.push(JSON.parse(body) as unknown);
      } catch {
        // 무시
      }
      send(200, true);
      return;
    }
    if (req.method === "POST" && url.pathname === "/tui/submit-prompt") {
      // attach된 세션에 모델이 동작한 것으로 간주 (TUI 화면). 동기 push.
      if (scenario === "a-ok" && opts.attachedSid) {
        push(opts.attachedSid, toolPart(opts.attachedSid));
      }
      send(200, true);
      return;
    }
    if (req.method === "GET" && url.pathname === "/event") {
      // M7-0 §5: server.connected + message.part.updated (part 안에 sessionID·tool).
      const lines: string[] = [
        'event: server.connected\ndata: {"type":"server.connected"}',
      ];
      for (const [sid, parts] of store) {
        for (const p of parts) {
          if (p["type"] !== "tool") continue;
          lines.push(
            `event: message.part.updated\ndata: ${JSON.stringify({
              type: "message.part.updated",
              properties: { sessionID: sid, part: p },
            })}`,
          );
        }
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      res.end(lines.join("\n\n") + "\n\n");
      return;
    }
    send(404, { error: "nope" });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
        requests,
        bodies,
        partsOf,
      });
    });
  });
}

let pfdir: string;
beforeEach(() => {
  pfdir = join(mkdtempSync(join(tmpdir(), "pf-m71l-")), ".procforge");
});

/** 이미 짝지어진 세션 재현용 pf_start part */
function seedPfPart(pfSid: string): Part {
  return {
    type: "tool",
    tool: "procforge_pf_start",
    part: { sessionID: "ses-h", tool: "procforge_pf_start" },
    state: {
      status: "completed",
      output: JSON.stringify({ sessionId: pfSid }),
    },
  };
}

describe("M7-1 opencode-link", () => {
  it("B-ok: 실측형 body→pf 출현→delivered+짝짓기", async () => {
    const fake = await startFake("b-ok");
    try {
      const paired: [string, string][] = [];
      const r = await sendContinue({
        baseUrl: fake.baseUrl,
        openCodeSessionId: "ses-a",
        text: "계속",
        mode: "b",
        timeoutMs: 2000,
        pollMs: 25,
        serverVersion: "1.18.18",
        deps: {
          ...httpLinkDeps(fake.baseUrl),
          onPairing: (a, b) => {
            paired.push([a, b]);
            savePairing(pfdir, a, b);
          },
        },
      });
      expect(r).toMatchObject({ delivered: true, mode: "b" });
      // M7-1.1 실서버 확인형 body (/session/:id/message + {parts}).
      expect(fake.bodies).toHaveLength(1);
      const sent = fake.bodies[0] as {
        parts: { type: string; text: string }[];
      };
      expect(sent.parts).toEqual([{ type: "text", text: "계속" }]);
      expect(paired).toEqual([["ses-a", "pf-fake-1"]]);
      expect(getPairing(pfdir, "ses-a")?.pfSessionId).toBe("pf-fake-1");
    } finally {
      await fake.close();
    }
  });

  it("listParts: 1.18.18 메시지 배열 응답을 parts로 평탄화", async () => {
    const payload = [
      { info: { role: "user" }, parts: [{ type: "text", text: "계속" }] },
      {
        info: { role: "assistant" },
        parts: [{ type: "tool", tool: "procforge_pf_start", state: { status: "completed" } }],
      },
    ];
    const impl = async (): Promise<Response> =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const parts = await httpLinkDeps("http://x", impl).listParts("ses-a");
    expect(parts).toEqual([
      { type: "text", text: "계속" },
      { type: "tool", tool: "procforge_pf_start", state: { status: "completed" } },
    ]);
  });

  it("B body 변형(래퍼)은 400 (실서버 확인 재현)", async () => {
    const fake = await startFake("b-ok");
    try {
      const r = await fetch(`${fake.baseUrl}/session/ses-x/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: { text: "계속", parts: [{ type: "text", text: "계속" }] },
        }),
      });
      expect(r.status).toBe(400);
    } finally {
      await fake.close();
    }
  });

  it("미확인 버전: 전송 없이 C 문구", async () => {
    const fake = await startFake("b-ok");
    try {
      const r = await sendContinue({
        baseUrl: fake.baseUrl,
        openCodeSessionId: "ses-v",
        text: "계속",
        mode: "b",
        timeoutMs: 500,
        pollMs: 25,
        serverVersion: "9.9.9",
        deps: { ...httpLinkDeps(fake.baseUrl) },
      });
      expect(r.delivered).toBe(false);
      if (!r.delivered) expect(r.degraded).toMatch(/미확인 버전/);
      expect(fake.requests).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("B-plan: 텍스트만 응답→pf 0건→degraded+복사 문구", async () => {
    const fake = await startFake("plan");
    try {
      const r = await sendContinue({
        baseUrl: fake.baseUrl,
        openCodeSessionId: "ses-p",
        text: "계속",
        mode: "b",
        timeoutMs: 1500,
        pollMs: 25,
        serverVersion: "1.18.18",
        deps: { ...httpLinkDeps(fake.baseUrl) },
      });
      expect(r.delivered).toBe(false);
      if (!r.delivered) {
        expect(r.degraded).toMatch(/무응답\/plan 모드/);
        // M8-1: C(복사 문구)는 B(전송 문구)와 같은 문자열이다.
        expect(r.copyText).toBe("계속");
      }
      // plan 모드도 텍스트 part는 쌓인다 (pf_*만 없음).
      expect(
        fake.partsOf("ses-p").some((p) => p["type"] === "text"),
      ).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it("이미 pf_start 있는 세션 + plan 응답 → degraded (기준점 회귀)", async () => {
    const fake = await startFake("plan", {
      seed: { sid: "ses-h", parts: [seedPfPart("pf-old")] },
    });
    try {
      // 구 구현(세션 전체 any pf_)이면 즉시 delivered로 통과해 이 테스트가 실패한다.
      const r = await sendContinue({
        baseUrl: fake.baseUrl,
        openCodeSessionId: "ses-h",
        text: "계속",
        mode: "b",
        timeoutMs: 1500,
        pollMs: 25,
        serverVersion: "1.18.18",
        deps: { ...httpLinkDeps(fake.baseUrl) },
      });
      expect(r.delivered).toBe(false);
      if (!r.delivered) expect(r.degraded).toMatch(/무응답\/plan 모드/);
    } finally {
      await fake.close();
    }
  });

  it("버전 미지정 → 미확인 C (default-deny)", async () => {
    const fake = await startFake("b-ok");
    try {
      const r = await sendContinue({
        baseUrl: fake.baseUrl,
        openCodeSessionId: "ses-u",
        text: "계속",
        mode: "b",
        timeoutMs: 500,
        pollMs: 25,
        deps: { ...httpLinkDeps(fake.baseUrl) },
      });
      expect(r.delivered).toBe(false);
      if (!r.delivered) expect(r.degraded).toMatch(/버전 미확인/);
      expect(fake.requests).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("A-ok: append+submit→delivered", async () => {
    const fake = await startFake("a-ok", { attachedSid: "ses-a2" });
    try {
      const r = await sendContinue({
        baseUrl: fake.baseUrl,
        openCodeSessionId: "ses-a2",
        text: "계속",
        mode: "a",
        timeoutMs: 2000,
        pollMs: 25,
        serverVersion: "1.18.18",
        deps: { ...httpLinkDeps(fake.baseUrl) },
      });
      expect(r).toMatchObject({ delivered: true, mode: "a" });
      expect(fake.requests).toContain("POST /tui/append-prompt");
      expect(fake.requests).toContain("POST /tui/submit-prompt");
      expect(fake.bodies).toEqual([{ text: "계속" }]);
    } finally {
      await fake.close();
    }
  });

  it("C: 전송 없이 문구만", async () => {
    const fake = await startFake("b-ok");
    try {
      const r = await sendContinue({
        baseUrl: fake.baseUrl,
        text: "계속",
        mode: "c",
        timeoutMs: 1500,
        pollMs: 25,
        deps: {
          listParts: async () => {
            throw new Error("불러선 안 됨");
          },
        },
      });
      expect(r.delivered).toBe(false);
      expect(fake.requests).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("SSE: message.part.updated에 sessionID·tool 포함", async () => {
    const fake = await startFake("b-ok");
    try {
      const r = await sendContinue({
        baseUrl: fake.baseUrl,
        openCodeSessionId: "ses-e",
        text: "계속",
        mode: "b",
        timeoutMs: 2000,
        pollMs: 25,
        serverVersion: "1.18.18",
        deps: { ...httpLinkDeps(fake.baseUrl) },
      });
      expect(r).toMatchObject({ delivered: true, mode: "b" });
      const sse = await (
        await fetch(`${fake.baseUrl}/event`)
      ).text();
      expect(sse).toContain("server.connected");
      expect(sse).toContain("message.part.updated");
      expect(sse).toContain("ses-e");
      expect(sse).toContain("procforge_pf_start");
    } finally {
      await fake.close();
    }
  });
});

describe("extractPfSessionId", () => {
  it("실측 형태에서 sessionId 추출 (대소문자 무관)", () => {
    const parts = [
      { type: "text", text: "hi" },
      {
        type: "tool",
        tool: "ProcForge_pf_start",
        state: {
          status: "completed",
          output: JSON.stringify({ sessionId: "ebb23249-1" }),
        },
      },
    ];
    expect(extractPfSessionId(parts)).toBe("ebb23249-1");
    expect(
      extractPfSessionId([
        {
          type: "tool",
          tool: "procforge_pf_start",
          state: { status: "completed", output: "{}" },
        },
      ]),
    ).toBeUndefined();
    expect(
      extractPfSessionId([{ type: "tool", tool: "bash" }]),
    ).toBeUndefined();
    expect(extractPfSessionId("junk")).toBeUndefined();
  });
});

// ---- App: advise 성공 후에만 신호 + pairings 기록 (UI 배선 없음) ----

function stubCore(opts: { failAdvise?: boolean } = {}) {
  const node = {
    id: "1.1",
    goal: "g",
    status: "open",
    depth: 1,
    dependsOn: [],
    constraints: [],
    advice: [],
    attempts: [],
  };
  return {
    getSession: async () => ({
      revision: 1,
      limits: { maxRetries: 2, maxDepth: 5, maxNodes: 50 },
    }),
    getNode: async () => node,
    pfAdvise: async () => {
      if (opts.failAdvise) throw new Error("advise boom");
      return {
        constraints: [],
        rejected: [],
        node,
        revision: 2,
        changedNodeIds: ["1.1"],
      };
    },
  };
}

function stubApp(
  opts: { failAdvise?: boolean; signal?: Partial<SignalTarget> } = {},
) {
  return new ProcForgeApp({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    core: stubCore(opts) as any,
    procforgeDir: pfdir,
    projectRoot: pfdir,
    // M7-ui4-b: 신호 대상은 서버 설정에서만 온다
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

const adviseInput = {
  sessionId: "pf-sid",
  nodeId: "1.1",
  text: "사람 조언",
} as Parameters<ProcForgeApp["advise"]>[0];

describe("M7-1 adviseAndSignal", () => {
  it("advise 실패 → 신호 미전송", async () => {
    const fake = await startFake("b-ok");
    try {
      const app = stubApp({
        failAdvise: true,
        signal: { baseUrl: fake.baseUrl, mode: "b", serverVersion: "1.18.18" },
      });
      await expect(
        app.adviseAndSignal({
          ...adviseInput,
          link: { openCodeSessionId: "ses-f" },
        }),
      ).rejects.toThrow("advise boom");
      expect(fake.requests).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("M7-ui4-b: 본문 link.baseUrl·mode 지정 → 400 (서버 설정만)", async () => {
    const fake = await startFake("b-ok");
    try {
      const app = stubApp({ signal: { baseUrl: fake.baseUrl, mode: "b" } });
      await expect(
        app.adviseAndSignal({
          ...adviseInput,
          link: { baseUrl: "http://169.254.169.254:80", mode: "b" },
        }),
      ).rejects.toThrow(/서버 설정에서만/);
      await expect(
        app.adviseAndSignal({ ...adviseInput, link: { mode: "c" } }),
      ).rejects.toThrow(/서버 설정에서만/);
      expect(fake.requests).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("advise 성공 → 신호 + 짝짓기 기록, 재연결 latest-wins·이력 보존", async () => {
    const fake = await startFake("b-ok", { pfIds: ["pf-1", "pf-2"] });
    try {
      const app = stubApp({
        signal: { baseUrl: fake.baseUrl, mode: "b", serverVersion: "1.18.18" },
      });
      const link = {
        // M7-ui4-i: baseUrl·mode·timeoutMs·serverVersion은 서버 설정에만 준다
        openCodeSessionId: "ses-g",
      };
      const r1 = await app.adviseAndSignal({
        ...adviseInput,
        sessionId: "pf-1",
        link,
      });
      expect(r1.signal).toMatchObject({ delivered: true, mode: "b" });
      expect(getPairing(pfdir, "ses-g")?.pfSessionId).toBe("pf-1");
      // 재연결: OpenCode 세션이 pf-2로 pf_start한 게 먼저 관찰돼 짝이 pf-2로
      // 갱신된 뒤에야 pf-2 조언 신호가 허용된다.
      savePairing(pfdir, "ses-g", "pf-2");
      const r2 = await app.adviseAndSignal({
        ...adviseInput,
        sessionId: "pf-2",
        link,
      });
      expect(r2.signal).toMatchObject({ delivered: true, mode: "b" });
      expect(getPairing(pfdir, "ses-g")?.pfSessionId).toBe("pf-2");
      const all = loadPairings(pfdir);
      const hist = all.history
        .filter((p) => p.openCodeSessionId === "ses-g")
        .map((p) => p.pfSessionId);
      expect(hist[0]).toBe("pf-1");
      expect(hist[hist.length - 1]).toBe("pf-2");
    } finally {
      await fake.close();
    }
  });

  it("다른 세션과 짝 → 무전송+C", async () => {
    const fake = await startFake("b-ok");
    try {
      savePairing(pfdir, "ses-g", "pf-other");
      const app = stubApp({
        signal: { baseUrl: fake.baseUrl, mode: "b", serverVersion: "1.18.18" },
      });
      const r = await app.adviseAndSignal({
        ...adviseInput, // sessionId "pf-sid" ≠ 짝 "pf-other"
        link: { openCodeSessionId: "ses-g" },
      });
      expect(r.signal.delivered).toBe(false);
      if (!r.signal.delivered) {
        expect(r.signal.degraded).toMatch(/다른 세션과 짝/);
      }
      // M8-1 ①: 짝 세션 생존 확인(GET)만 — 신호 전송은 없다.
      expect(fake.requests).toEqual(["GET /session/ses-g"]);
    } finally {
      await fake.close();
    }
  });
});

describe("M8-1 신호 문구 + 짝 유효성", () => {
  it("문구에 sid·nid·pf_start 금지 가 있고 의견 본문은 없다, C == B", async () => {
    const fake = await startFake("b-ok", { pfIds: ["pf-1"] });
    try {
      const app = stubApp({
        signal: { baseUrl: fake.baseUrl, mode: "b", serverVersion: "1.18.18" },
      });
      const r = await app.adviseAndSignal({
        sessionId: "pf-1",
        nodeId: "1.2",
        text: "이 문장은 모델에게 가지 않는다",
        link: { openCodeSessionId: "ses-g" },
      });
      expect(r.signal.delivered).toBe(true);
      const copy = r.signal.copyText ?? "";
      expect(copy).toContain("pf-1");
      expect(copy).toContain("1.2");
      expect(copy).toContain("pf_start 금지");
      expect(copy).not.toContain("이 문장은 모델에게 가지 않는다");
      // B(전송 본문) == C(복사 문구)
      const sent = fake.bodies.at(-1) as { parts?: { text?: string }[] };
      expect(sent.parts?.[0]?.text).toBe(copy);
    } finally {
      await fake.close();
    }
  });

  it("toolPrefix 설정 → 접두어 있는 도구 이름, 미설정 → 접두어 없이 phrasing", async () => {
    const fake = await startFake("b-ok", { pfIds: ["pf-1"] });
    try {
      const withPrefix = stubApp({
        signal: {
          baseUrl: fake.baseUrl,
          mode: "b",
          serverVersion: "1.18.18",
          toolPrefix: "procforge",
        },
      });
      const r1 = await withPrefix.adviseAndSignal({
        sessionId: "pf-1",
        nodeId: "1.2",
        text: "x",
        link: { openCodeSessionId: "ses-g" },
      });
      expect(r1.signal.copyText).toContain('procforge_pf_next({sessionId:"pf-1"})');

      const noPrefix = stubApp({
        signal: { baseUrl: fake.baseUrl, mode: "b", serverVersion: "1.18.18" },
      });
      const r2 = await noPrefix.adviseAndSignal({
        sessionId: "pf-1",
        nodeId: "1.2",
        text: "x",
        link: { openCodeSessionId: "ses-g" },
      });
      expect(r2.signal.copyText).toContain("ProcForge의 pf_next 도구");
      expect(r2.signal.copyText).not.toContain("pf_next({sessionId");
    } finally {
      await fake.close();
    }
  });

  it("① 짝 세션이 서버에 없으면 미전송 + '짝 세션 없음'", async () => {
    const fake = await startFake("no-session", { pfIds: ["pf-1"] });
    try {
      const app = stubApp({
        signal: { baseUrl: fake.baseUrl, mode: "b", serverVersion: "1.18.18" },
      });
      const r = await app.adviseAndSignal({
        sessionId: "pf-1",
        nodeId: "1.2",
        text: "x",
        link: { openCodeSessionId: "ses-g" },
      });
      expect(r.signal.delivered).toBe(false);
      if (!r.signal.delivered) {
        expect(r.signal.degraded).toMatch(/짝 세션 없음/);
      }
      // 전송 본문은 없다(신호를 보내지 않았다).
      expect(fake.bodies).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("② 다른 세션과 짝 → 미전송 + '다른 세션과 짝'", async () => {
    const fake = await startFake("b-ok", { pfIds: ["pf-1"] });
    try {
      savePairing(pfdir, "ses-g", "pf-other");
      const app = stubApp({
        signal: { baseUrl: fake.baseUrl, mode: "b", serverVersion: "1.18.18" },
      });
      const r = await app.adviseAndSignal({
        sessionId: "pf-1",
        nodeId: "1.2",
        text: "x",
        link: { openCodeSessionId: "ses-g" },
      });
      expect(r.signal.delivered).toBe(false);
      if (!r.signal.delivered) {
        expect(r.signal.degraded).toMatch(/다른 세션과 짝/);
      }
      expect(fake.bodies).toEqual([]);
    } finally {
      await fake.close();
    }
  });

  it("③ 양방향 최신 짝이 일치하면 전송한다", async () => {
    const fake = await startFake("b-ok", { pfIds: ["pf-1"] });
    try {
      savePairing(pfdir, "ses-g", "pf-1");
      const app = stubApp({
        signal: { baseUrl: fake.baseUrl, mode: "b", serverVersion: "1.18.18" },
      });
      const r = await app.adviseAndSignal({
        sessionId: "pf-1",
        nodeId: "1.2",
        text: "x",
        link: { openCodeSessionId: "ses-g" },
      });
      expect(r.signal.delivered).toBe(true);
      const sent = fake.bodies.at(-1) as { parts?: { text?: string }[] };
      expect(sent.parts?.[0]?.text).toBe(r.signal.copyText);
    } finally {
      await fake.close();
    }
  });

  it("클라이언트가 신호 문구를 지정하면 400 (문구는 서버가 만든다)", async () => {
    const fake = await startFake("b-ok", { pfIds: ["pf-1"] });
    try {
      const app = stubApp({
        signal: { baseUrl: fake.baseUrl, mode: "b", serverVersion: "1.18.18" },
      });
      await expect(
        app.adviseAndSignal({
          sessionId: "pf-1",
          nodeId: "1.2",
          text: "x",
          link: { text: "계속" } as never,
        }),
      ).rejects.toThrow(/서버 설정에서만/);
      expect(fake.bodies).toEqual([]);
    } finally {
      await fake.close();
    }
  });
});
