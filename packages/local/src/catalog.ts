import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolCatalogEntry } from "@procforge/shared/schema.js";

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** tool inputSchema 정합 해시 (validator의 schemaHash 불일치 탐지용) */
export function schemaHash(inputSchema: unknown): string {
  return createHash("sha256").update(stableStringify(inputSchema)).digest("hex").slice(0, 16);
}

export type McpServerConfig = {
  type?: "local" | "remote";
  command?: string[] | string;
  cwd?: string;
  environment?: Record<string, string>;
  enabled?: boolean;
  url?: string;
};

function inputSchemaOf(props: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: "object", properties: props, required };
}

function builtin(name: string, props: Record<string, unknown>, required: string[]): ToolCatalogEntry {
  const inputSchema = inputSchemaOf(props, required);
  return { server: "opencode", name, inputSchema, schemaHash: schemaHash(inputSchema) };
}

/** OpenCode 내장 툴 고정 목록 (M2 가정 — DECISIONS 참조) */
export const BUILTIN_TOOLS: ToolCatalogEntry[] = [
  builtin("read", { path: { type: "string" } }, ["path"]),
  builtin("write", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
  builtin("edit", { path: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } }, ["path", "oldString", "newString"]),
  builtin("bash", { command: { type: "string" } }, ["command"]),
  builtin("glob", { pattern: { type: "string" } }, ["pattern"]),
  builtin("grep", { pattern: { type: "string" } }, ["pattern"]),
];

export function loadMcpConfigs(projectRoot: string): { servers: Record<string, McpServerConfig>; sources: string[] } {
  const candidates = [
    join(homedir(), ".config", "opencode", "opencode.json"),
    join(projectRoot, "opencode.json"),
    join(projectRoot, ".opencode", "opencode.json"),
  ];
  const servers: Record<string, McpServerConfig> = {};
  const sources: string[] = [];
  for (const f of candidates) {
    if (!existsSync(f)) continue;
    try {
      const parsed = JSON.parse(readFileSync(f, "utf8")) as { mcp?: Record<string, McpServerConfig> };
      if (parsed.mcp && typeof parsed.mcp === "object") {
        Object.assign(servers, parsed.mcp);
        sources.push(f);
      }
    } catch {
      // 손상된 설정은 건너뜀 (warnings는 collectCatalog에서 처리하지 않음 — 호출자가 sources로 확인)
    }
  }
  return { servers, sources };
}

/** MCP stdio 서버 연결 (runner 연결 풀이 재사용, M3) */
export async function connectMcpServer(serverName: string, cfg: McpServerConfig): Promise<Client> {
  const rawCmd = cfg.command;
  const cmd = Array.isArray(rawCmd) ? rawCmd : typeof rawCmd === "string" ? rawCmd.split(" ") : [];
  if (cfg.type === "remote" || cmd.length === 0 || cfg.enabled === false) {
    throw new Error(`${serverName}: unsupported transport or disabled`);
  }
  const transport = new StdioClientTransport({
    command: cmd[0],
    args: cmd.slice(1),
    cwd: cfg.cwd,
    env: { ...process.env, ...(cfg.environment ?? {}) } as Record<string, string>,
  });
  const client = new Client({ name: "procforge-runner", version: "0.3.0" });
  await client.connect(transport);
  return client;
}

async function listServerTools(
  serverName: string,
  cfg: McpServerConfig,
  timeoutMs: number,
): Promise<{ entries: ToolCatalogEntry[]; warning?: string }> {
  if (cfg.enabled === false) return { entries: [], warning: `${serverName}: disabled` };
  const rawCmd = cfg.command;
  const cmd = Array.isArray(rawCmd) ? rawCmd : typeof rawCmd === "string" ? rawCmd.split(" ") : [];
  if (cfg.type === "remote" || cmd.length === 0) {
    return { entries: [], warning: `${serverName}: remote/unsupported transport skipped` };
  }
  const client = new Client({ name: "procforge-catalog", version: "0.0.0" });
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  // 연결은 connectMcpServer로 일원화하되 타임아웃 경쟁을 위해 transport 직접 구성
  const transport = new StdioClientTransport({
    command: cmd[0],
    args: cmd.slice(1),
    cwd: cfg.cwd,
    env: { ...process.env, ...(cfg.environment ?? {}) } as Record<string, string>,
  });
  try {
    await Promise.race([client.connect(transport), timeout]);
    const { tools } = await client.listTools();
    const entries = tools.map((t) => {
      const inputSchema = (t.inputSchema ?? { type: "object" }) as Record<string, unknown>;
      return { server: serverName, name: t.name, inputSchema, schemaHash: schemaHash(inputSchema) };
    });
    return { entries };
  } catch (e) {
    return { entries: [], warning: `${serverName}: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    try {
      await client.close();
    } catch {
      // 무시
    }
  }
}

/** opencode.json mcp 항목 + 내장 툴 → toolCatalog 수집 (M2.5: 캐시+5초 타임아웃) */
export async function collectCatalog(
  projectRoot: string,
  opts: { timeoutMs?: number; cacheDir?: string; refresh?: boolean } = {},
): Promise<{ entries: ToolCatalogEntry[]; warnings: string[]; cached: boolean }> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const CACHE_TTL_MS = 10 * 60 * 1000;
  const cachePath = opts.cacheDir ? join(opts.cacheDir, "catalog.json") : undefined;
  const fingerprint = configFingerprint(projectRoot);
  if (!opts.refresh && cachePath && existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8")) as {
        at: number;
        fingerprint: string;
        entries: ToolCatalogEntry[];
        warnings: string[];
      };
      if (cached.fingerprint === fingerprint && Date.now() - cached.at < CACHE_TTL_MS) {
        return { entries: cached.entries, warnings: cached.warnings, cached: true };
      }
    } catch {
      // 캐시 손상 시 재수집
    }
  }
  const { servers } = loadMcpConfigs(projectRoot);
  const entries: ToolCatalogEntry[] = [...BUILTIN_TOOLS];
  const warnings: string[] = [];
  for (const [name, cfg] of Object.entries(servers)) {
    const r = await listServerTools(name, cfg, timeoutMs);
    entries.push(...r.entries);
    if (r.warning) warnings.push(r.warning);
  }
  if (cachePath) {
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify({ at: Date.now(), fingerprint, entries, warnings }));
    } catch {
      // 캐시 실패는 무시
    }
  }
  return { entries, warnings, cached: false };
}

function configFingerprint(projectRoot: string): string {
  const candidates = [
    join(homedir(), ".config", "opencode", "opencode.json"),
    join(projectRoot, "opencode.json"),
    join(projectRoot, ".opencode", "opencode.json"),
  ];
  const parts = candidates.map((f) => {
    if (!existsSync(f)) return `${f}:missing`;
    try {
      const st = statSync(f);
      return `${f}:${st.mtimeMs}:${st.size}`;
    } catch {
      return `${f}:unreadable`;
    }
  });
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}
