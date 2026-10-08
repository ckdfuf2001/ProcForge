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

function normalizeArgs(fsDir: string, args: Record<string, unknown>): unknown {
  const norm = (v: unknown): unknown => {
    if (typeof v === "string" && (v.startsWith(fsDir) || v.includes("RUNFS/"))) {
      try {
        return relativizeRunPath(fsDir, v.replace("RUNFS/", `${fsDir}/`));
      } catch {
        return v;
      }
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

export function recordKey(fsDir: string, server: string, tool: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify({ server, tool, args: normalizeArgs(fsDir, args) })).digest("hex").slice(0, 16);
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

export function saveRecording(
  procforgeDir: string,
  sessionId: string,
  nodeId: string,
  rec: Recording,
): void {
  const entries = loadCassette(procforgeDir, sessionId, nodeId).filter((e) => e.key !== rec.key);
  entries.push(rec);
  const p = cassetteFile(procforgeDir, sessionId, nodeId);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ entries }, null, 2));
  renameSync(tmp, p);
}

export function toToolResponse(rec: Recording): ToolResponse {
  return { resultText: rec.response.summary, resultJson: rec.response.json };
}
