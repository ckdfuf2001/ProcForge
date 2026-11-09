import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { ProcForgeApp } from "../src/app/app.js";
import { createUiServer, type UiServer } from "../src/app/ui-server.js";
import { startUiPresence } from "../src/app/ui-presence.js";
import { testStack } from "./client-mode.js";
import { makeTmp } from "@proof/shared/tmp.js";
import { useTmpCleanup } from "./tmp-hooks.js";

useTmpCleanup();

// M11-ui-presence: 같은 저장소를 쓰는 두 번째 UI는 stderr 경고 1줄, 막지는 않는다.

let root: string;
let pfdir: string;
let app: ProcForgeApp;
const servers: UiServer[] = [];
let errLines: string[] = [];
let origError: typeof console.error | undefined;

function captureStderr(): void {
  origError = console.error;
  console.error = ((...args: unknown[]) => {
    errLines.push(args.map(String).join(" "));
  }) as typeof console.error;
}

function restoreStderr(): void {
  if (origError) console.error = origError;
  origError = undefined;
}

beforeEach(() => {
  root = makeTmp("pf-m11ui-");
  pfdir = join(root, ".procforge");
  mkdirSync(join(pfdir, "procedures"), { recursive: true });
  const { client } = testStack(pfdir);
  app = new ProcForgeApp({ core: client, procforgeDir: pfdir, projectRoot: root });
  errLines = [];
});

afterEach(async () => {
  restoreStderr();
  while (servers.length > 0) {
    const s = servers.pop();
    if (s) await s.close();
  }
});

describe("M11 UI 중복 감지", () => {
  it("같은 저장소의 두 번째 UI는 stderr 경고 1줄 (다른 pid)", async () => {
    captureStderr();
    const stop1 = startUiPresence(pfdir, process.pid);
    const stop2 = startUiPresence(pfdir, 424243);
    try {
      const warns = errLines.filter((l) => l.includes("다른 UI"));
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain(String(process.pid));
    } finally {
      stop1();
      stop2();
    }
    // createUiServer 경유: procforgeDir 전달 시 감시가 켜진다.
    const srv = await createUiServer({ app, staticDir: makeTmp("pf-m11ui-s2-"), procforgeDir: pfdir });
    servers.push(srv);
  }, 60000);

  it("stale heartbeat 파일은 경고하지 않는다", async () => {
    const locks = join(pfdir, "procedures", ".locks");
    mkdirSync(locks, { recursive: true });
    const stale = join(locks, "ui.424242.json");
    writeFileSync(stale, JSON.stringify({ pid: 424242, at: new Date(0).toISOString() }));
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(stale, old, old);
    expect(Date.now() - statSync(stale).mtimeMs).toBeGreaterThan(60 * 1000);
    captureStderr();
    const s1 = await createUiServer({ app, staticDir: makeTmp("pf-m11ui-s3-"), procforgeDir: pfdir });
    servers.push(s1);
    expect(errLines.filter((l) => l.includes("다른 UI"))).toHaveLength(0);
    expect(existsSync(join(pfdir, "procedures", ".locks"))).toBe(true);
  }, 60000);
});
