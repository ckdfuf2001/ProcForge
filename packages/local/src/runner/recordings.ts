import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { relativizeRunPath } from "./workdir.js";
import type { ToolResponse } from "./types.js";

// VCR 방식 녹화 (M3). 매칭 키 = server+tool+정규화 args(키 정렬, runs 경로 → 상대경로) 해시.

export type Recording = {
  key: string;
  server: string;
  tool: string;
  args: Record<string, unknown>;
  response: { summary: string; json?: unknown };
  at: string;
};

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = stable((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

function normalizeArgs(fsDir: string, projectRoot: string | undefined, args: Record<string, unknown>): unknown {
  const norm = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (v.startsWith(fsDir)) {
        try {
          return relativizeRunPath(fsDir, v);
        } catch {
          return v;
        }
      }
      if (projectRoot && v.startsWith(projectRoot)) {
        return `PROJECT/${v.slice(projectRoot.length).replace(/\\/g, "/").replace(/^\//, "")}`;
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(norm);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = norm(val);
      return out;
    }
    return v;
  };
  return stable(norm(args));
}

export function recordKey(
  fsDir: string,
  projectRoot: string | undefined,
  server: string,
  tool: string,
  args: Record<string, unknown>,
): string {
  return createHash("sha256").update(JSON.stringify({ server, tool, args: normalizeArgs(fsDir, projectRoot, args) })).digest("hex").slice(0, 16);
}

function cassetteFile(procforgeDir: string, sessionId: string, nodeId: string): string {
  return join(procforgeDir, "sessions", sessionId, "cassettes", `${nodeId}.json`);
}

export function loadCassette(procforgeDir: string, sessionId: string, nodeId: string): Recording[] {
  const p = cassetteFile(procforgeDir, sessionId, nodeId);
  if (!existsSync(p)) return [];
  try {
    return (JSON.parse(readFileSync(p, "utf8")) as { entries: Recording[] }).entries ?? [];
  } catch {
    return [];
  }
}

export function findRecording(entries: Recording[], key: string): Recording | undefined {
  return entries.find((e) => e.key === key);
}

function mapStrings(v: unknown, fn: (s: string) => string): unknown {
  if (typeof v === "string") return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = mapStrings(val, fn);
    return out;
  }
  return v;
}

/** record 시 응답 내 runFs 절대경로 → "{RUNFS}" (M3.4-6, Windows 구분자 포함) */
export function normalizeResponseForStore(
  resp: { summary: string; json?: unknown },
  fsDir: string,
): { summary: string; json?: unknown } {
  const forms = [fsDir, fsDir.replace(/\\/g, "/")];
  const norm = (s: string) => {
    let out = s;
    for (const f of forms) out = out.split(f).join("{RUNFS}");
    return out;
  };
  return { summary: norm(resp.summary), json: mapStrings(resp.json, norm) as unknown };
}

// 옛 cassette 마이그레이션: runs/<id>/fs 절대경로 패턴 (M3.4-6)
const LEGACY_RUNS_RE = /(?:[A-Za-z]:)?[^"'`\s|]*?runs[/\\][^"'`/\s\\]+[/\\]fs(?=[/\\]|["'`\s]|$)/g;

/** replay 시 "{RUNFS}" → 현재 runFs, 옛 runs/<id>/fs 패턴도 치환 (M3.4-6) */
export function restoreResponseForRun(
  resp: { summary: string; json?: unknown },
  fsDir: string,
): { summary: string; json?: unknown } {
  const restore = (s: string) => s.split("{RUNFS}").join(fsDir).replace(LEGACY_RUNS_RE, fsDir);
  return { summary: restore(resp.summary), json: mapStrings(resp.json, restore) as unknown };
}

export function saveRecording(
  procforgeDir: string,
  sessionId: string,
  nodeId: string,
  rec: Recording,
  fsDir: string,
): void {
  const normalized: Recording = {
    ...rec,
    response: normalizeResponseForStore(rec.response, fsDir),
  };
  const entries = loadCassette(procforgeDir, sessionId, nodeId).filter((e) => e.key !== rec.key);
  entries.push(normalized);
  const p = cassetteFile(procforgeDir, sessionId, nodeId);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ entries }, null, 2));
  renameSync(tmp, p);
}

export function toToolResponse(rec: Recording, fsDir: string): ToolResponse {
  const restored = restoreResponseForRun(rec.response, fsDir);
  return { resultText: restored.summary, resultJson: restored.json };
}
