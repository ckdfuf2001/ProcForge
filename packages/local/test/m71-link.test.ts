import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import {
  sendContinue,
  extractPfSessionId,
} from "../src/services/opencode-link.js";
import { savePairing, getPairing } from "../src/services/pairings.js";

// M7-1: UI→OpenCode 연결 B/A/C + plan 모드 E2E (가짜 opencode 서버).

type Part = Record<string, unknown>;
type FakeScenario = "b-ok" | "plan" | "a-ok";

function startFake(
  scenario: FakeScenario,
  attachedSid?: string,
): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  requests: string[];
  partsOf: (sid: string) => Part[];
}> {
  const store = new Map<string, Part[]>();
  const requests: string[] = [];
  const partsOf = (sid: string) => store.get(sid) ?? [];
  const push = (sid: string, p: Part) => {
    store.set(sid, [...partsOf(sid), p]);
  };
  const toolPart = (): Part => ({
    type: "tool",
    tool: "procforge_pf_start",
    state: {
      status: "completed",
      output: JSON.stringify({ sessionId: "pf-fake-1" }),
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
      try {
        const parsed = JSON.parse(body) as { parts?: Part[] };
        for (const p of parsed.parts ?? []) push(sid, p);
      } catch {
        // 무시
      }
      if (scenario !== "plan") {
        setTimeout(() => {
          push(sid, toolPart());
        }, 30);
      }
      send(200, { data: { admittedSeq: 1 } });
      return;
    }
    if (req.method === "GET" && mMsg) {
      send(200, { data: partsOf(mMsg[1]) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/tui/append-prompt") {
      send(200, true);
      return;
    }
    if (req.method === "POST" && url.pathname === "/tui/submit-prompt") {
      // attach된 세션에 모델이 동작한 것으로 간주 (TUI 화면).
      if (scenario === "a-ok" && attachedSid) {
        setTimeout(() => {
          push(attachedSid, toolPart());
        }, 30);
      }
      send(200, true);
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
        close: () => new Promise<void>((r) => server.close(() => r())),
        requests,
        partsOf,
      });
    });
  });
}

let pfdir: string;
beforeEach(() => {
  pfdir = join(mkdtempSync(join(tmpdir(), "pf-m71l-")), ".procforge");
});
afterEach(() => {});

describe("M7-1 opencode-link", () => {
  it("B-ok: 전송→pf 출현→delivered+짝짓기", async () => {
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
        deps: {
          hasPfCall: async (sid) =>
            fake
              .partsOf(sid)
              .some(
                (p) =>
                  p["type"] === "tool" &&
                  String(p["tool"] ?? "").includes("pf_"),
              ),
          readPfSessionId: async (sid) => extractPfSessionId(fake.partsOf(sid)),
          onPairing: (a, b) => {
            paired.push([a, b]);
            savePairing(pfdir, a, b);
          },
        },
      });
      expect(r).toEqual({ delivered: true, mode: "b" });
      expect(paired).toEqual([["ses-a", "pf-fake-1"]]);
      expect(getPairing(pfdir, "ses-a")?.pfSessionId).toBe("pf-fake-1");
    } finally {
      await fake.close();
    }
  });

  it("B-plan: pf 출현 없음→degraded+복사 문구", async () => {
    const fake = await startFake("plan");
    try {
      const r = await sendContinue({
        baseUrl: fake.baseUrl,
        openCodeSessionId: "ses-p",
        text: "계속",
        mode: "b",
        timeoutMs: 300,
        pollMs: 25,
        deps: {
          hasPfCall: async () => false,
          readPfSessionId: async () => undefined,
        },
      });
      expect(r.delivered).toBe(false);
      if (!r.delivered) {
        expect(r.degraded).toMatch(/무응답\/plan 모드/);
        expect(r.copyText).toContain("계속");
        expect(r.copyText).toContain("계속'이라고 입력하세요");
      }
    } finally {
      await fake.close();
    }
  });

  it("A-ok: append+submit→delivered", async () => {
    const fake = await startFake("a-ok", "ses-a2");
    try {
      const r = await sendContinue({
        baseUrl: fake.baseUrl,
        openCodeSessionId: "ses-a2",
        text: "계속",
        mode: "a",
        timeoutMs: 2000,
        pollMs: 25,
        deps: {
          hasPfCall: async (sid) =>
            fake
              .partsOf(sid)
              .some(
                (p) =>
                  p["type"] === "tool" &&
                  String(p["tool"] ?? "").includes("pf_"),
              ),
          readPfSessionId: async (sid) => extractPfSessionId(fake.partsOf(sid)),
        },
      });
      expect(r).toEqual({ delivered: true, mode: "a" });
      expect(fake.requests).toContain("POST /tui/append-prompt");
      expect(fake.requests).toContain("POST /tui/submit-prompt");
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
        timeoutMs: 300,
        pollMs: 25,
        deps: {
          hasPfCall: async () => {
            throw new Error("불러선 안 됨");
          },
          readPfSessionId: async () => undefined,
        },
      });
      expect(r.delivered).toBe(false);
      expect(fake.requests).toEqual([]);
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
