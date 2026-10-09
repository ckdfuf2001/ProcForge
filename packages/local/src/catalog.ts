import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeAtomicFile } from "./fsutil.js";
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

function inputSchemaOf(
  props: Record<string, unknown>,
  required: string[],
  allowAdditional?: boolean,
): Record<string, unknown> {
  return {
    type: "object",
    properties: props,
    required,
    ...(allowAdditional === undefined ? {} : { additionalProperties: allowAdditional }),
  };
}

export type BuiltinDef = {
  props: Record<string, unknown>;
  required: string[];
  readOnly: boolean;
};

/**
 * 버전별 내장 툴 스키마 표 (M3.6-7, major 기준).
 * "1" = 현행 가정 (read에 offset/limit 포함). 실측 버전과 다르면 DECISIONS 갱신.
 * 표에 없는 major는 현행 스키마 + additionalProperties 허용 + 경고.
 */
export const BUILTIN_BY_MAJOR: Record<string, Record<string, BuiltinDef>> = {
  "1": {
    read: {
      props: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 0 },
      },
      required: ["path"],
      readOnly: true,
    },
    write: {
      props: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      readOnly: false,
    },
    edit: {
      props: { path: { type: "string" }, oldString: { type: "string" }, newString: { type: "string" } },
      required: ["path", "oldString", "newString"],
      readOnly: false,
    },
    bash: { props: { command: { type: "string" } }, required: ["command"], readOnly: false },
    glob: { props: { pattern: { type: "string" } }, required: ["pattern"], readOnly: true },
    grep: { props: { pattern: { type: "string" } }, required: ["pattern"], readOnly: true },
  },
};

function builtinEntries(
  defs: Record<string, BuiltinDef>,
  allowAdditional?: boolean,
): ToolCatalogEntry[] {
  return Object.entries(defs).map(([name, d]) => {
    const inputSchema = inputSchemaOf(d.props, d.required, allowAdditional);
    return {
      server: "opencode",
      name,
      inputSchema,
      schemaHash: schemaHash(inputSchema),
      annotations: { readOnlyHint: d.readOnly, openWorldHint: false },
    };
  });
}

/** "1.2.3" → "1". 파싱 불가면 undefined */
export function builtinMajor(version: string): string | undefined {
  const m = /^(\d+)\./.exec(version.trim());
  return m ? m[1] : undefined;
}

/** 버전 대응 내장 툴 목록. 모르는 버전은 허용 모드 + 경고 */
export function builtinToolsFor(version?: string): { entries: ToolCatalogEntry[]; warnings: string[] } {
  const v = version ?? "unknown";
  const major = builtinMajor(v);
  const defs = (major ? BUILTIN_BY_MAJOR[major] : undefined) ?? BUILTIN_BY_MAJOR["1"];
  const known = !!major && major in BUILTIN_BY_MAJOR;
  return {
    entries: builtinEntries(defs, known ? undefined : true),
    warnings: known ? [] : [`모르는 opencode 버전(${v}): 내장 툴 additionalProperties 허용`],
  };
}

/** OpenCode 내장 툴 고정 목록 (M2 가정 — DECISIONS 참조). 현행 버전 기준 */
export const BUILTIN_TOOLS: ToolCatalogEntry[] = builtinToolsFor("1.0.0").entries;

export type VersionRunner = (cmd: string, args: string[]) => { stdout: string };

/** `opencode --version` best-effort 감지. 실패·파싱 불가면 "unknown" */
export function detectOpencodeVersion(run?: VersionRunner): string {
  try {
    const out = run
      ? run("opencode", ["--version"]).stdout
      : (spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 5000 }).stdout as string | null) ?? "";
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
    if (m) return `${m[1]}.${m[2]}.${m[3]}`;
  } catch {
    // 무시 → unknown
  }
  return "unknown";
}

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

/** MCP stdio 서버 연결 (runner 연결 풀이 재사용, M3). cwd 지정 시 run fs로 spawn (M3.1-3) */
export async function connectMcpServer(
  serverName: string,
  cfg: McpServerConfig,
  opts: { cwd?: string } = {},
): Promise<Client> {
  const rawCmd = cfg.command;
  const cmd = Array.isArray(rawCmd) ? rawCmd : typeof rawCmd === "string" ? rawCmd.split(" ") : [];
  if (cfg.type === "remote" || cmd.length === 0 || cfg.enabled === false) {
    throw new Error(`${serverName}: unsupported transport or disabled`);
  }
  const transport = new StdioClientTransport({
    command: cmd[0],
    args: cmd.slice(1),
    cwd: opts.cwd ?? cfg.cwd,
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
      const a = (t.annotations ?? {}) as Record<string, boolean>;
      return {
        server: serverName,
        name: t.name,
        inputSchema,
        schemaHash: schemaHash(inputSchema),
        annotations: {
          readOnlyHint: a["readOnlyHint"],
          destructiveHint: a["destructiveHint"],
          idempotentHint: a["idempotentHint"],
          openWorldHint: a["openWorldHint"],
        },
      };
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
  opts: { timeoutMs?: number; cacheDir?: string; refresh?: boolean; opencodeVersion?: string; runOpencode?: VersionRunner } = {},
): Promise<{ entries: ToolCatalogEntry[]; warnings: string[]; cached: boolean; opencodeVersion: string }> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const CACHE_TTL_MS = 10 * 60 * 1000;
  const cachePath = opts.cacheDir ? join(opts.cacheDir, "catalog.json") : undefined;
  // M3.6-7: 버전이 다르면 스키마가 다를 수 있어 fingerprint에 포함
  const opencodeVersion = opts.opencodeVersion ?? detectOpencodeVersion(opts.runOpencode);
  const fingerprint = `${configFingerprint(projectRoot)}|opencode:${opencodeVersion}`;
  if (!opts.refresh && cachePath && existsSync(cachePath)) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf8")) as {
        at: number;
        fingerprint: string;
        entries: ToolCatalogEntry[];
        warnings: string[];
        opencodeVersion?: string;
      };
      if (cached.fingerprint === fingerprint && Date.now() - cached.at < CACHE_TTL_MS) {
        return { entries: cached.entries, warnings: cached.warnings, cached: true, opencodeVersion: cached.opencodeVersion ?? opencodeVersion };
      }
    } catch {
      // 캐시 손상 시 재수집
    }
  }
  const { servers } = loadMcpConfigs(projectRoot);
  const versioned = builtinToolsFor(opencodeVersion);
  const entries: ToolCatalogEntry[] = [...versioned.entries];
  const warnings: string[] = [...versioned.warnings];
  for (const [name, cfg] of Object.entries(servers)) {
    const r = await listServerTools(name, cfg, timeoutMs);
    entries.push(...r.entries);
    if (r.warning) warnings.push(r.warning);
  }
  if (cachePath) {
    try {
      writeAtomicFile(cachePath, JSON.stringify({ at: Date.now(), fingerprint, entries, warnings, opencodeVersion }));
    } catch {
      // 캐시 실패는 무시
    }
  }
  return { entries, warnings, cached: false, opencodeVersion };
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
