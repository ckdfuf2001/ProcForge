import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { connectMcpServer, loadMcpConfigs } from "../catalog.js";
import { isEscapeRel } from "../artifacts.js";
import type { ToolResponse } from "./types.js";

// 실행 1회 동안 MCP 서버 연결 풀 유지 (M3). 내장 툴은 최소 구현.

function toLineIndex(v: unknown, what: string): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : (v as number);
  if (!Number.isInteger(n) || (n as number) < 0) throw new Error(`read ${what} must be a non-negative integer`);
  return n as number;
}

export class ConnectionPool {
  private mcp = new Map<string, Client>();
  private configs: Record<string, Parameters<typeof connectMcpServer>[1]> = {};

  constructor(
    private projectRoot: string,
    private runFs: string,
    private allowBash = false,
  ) {
    this.configs = loadMcpConfigs(projectRoot).servers;
  }

  isBuiltin(server: string, name: string): boolean {
    if (server !== "opencode") return false;
    return ["read", "write", "edit", "bash"].includes(name);
  }

  private runPath(p: string): string {
    const abs = resolve(this.runFs, p);
    if (isEscapeRel(relative(this.runFs, abs).split("\\").join("/"), "/")) {
      throw new Error(`run fs escape: ${p}`);
    }
    return abs;
  }

  private builtin(name: string, args: Record<string, unknown>): ToolResponse {
    switch (name) {
      case "read": {
        const p = this.runPath(args["path"] as string);
        const text = readFileSync(p, "utf8");
        // M3.6-7: offset(0-based 시작 줄)/limit(줄 수). 생략 시 전체.
        const lines = text.split("\n");
        const offset = args["offset"] === undefined ? 0 : toLineIndex(args["offset"], "offset");
        const limit = args["limit"] === undefined ? lines.length : toLineIndex(args["limit"], "limit");
        const slice = lines.slice(offset, offset + limit).join("\n");
        let json: unknown;
        try {
          json = JSON.parse(slice);
        } catch {
          json = { text: slice };
        }
        return { resultText: slice, resultJson: json };
      }
      case "write": {
        const p = this.runPath(args["path"] as string);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, args["content"] as string);
        return { resultText: `wrote ${args["path"]}`, resultJson: { wrote: args["path"] } };
      }
      case "edit": {
        const p = this.runPath(args["path"] as string);
        const cur = readFileSync(p, "utf8");
        const oldS = args["oldString"] as string;
        if (!cur.includes(oldS)) throw new Error(`oldString not found in ${args["path"]}`);
        writeFileSync(p, cur.replace(oldS, args["newString"] as string));
        return { resultText: `edited ${args["path"]}`, resultJson: { edited: args["path"] } };
      }
      case "bash": {
        if (!this.allowBash) throw new Error("bash is disabled in runner (allowBash 필요)");
        const r = spawnSync(args["command"] as string, { shell: true, cwd: this.runFs, encoding: "utf8", timeout: 30000 });
        if (r.status !== 0) throw new Error(`bash exit ${r.status}: ${(r.stderr || r.stdout || "").slice(0, 500)}`);
        return { resultText: r.stdout, resultJson: { stdout: r.stdout, exit: r.status } };
      }
      default:
        throw new Error(`runner 미지원 내장 툴: ${name}`);
    }
  }

  async call(server: string, tool: string, args: Record<string, unknown>): Promise<ToolResponse> {
    if (this.isBuiltin(server, tool)) return this.builtin(tool, args);
    // MCP 서버 lazy 연결 (cwd=run fs, M3.1-3)
    let client = this.mcp.get(server);
    if (!client) {
      const cfg = this.configs[server];
      if (!cfg) throw new Error(`unknown MCP server: ${server}`);
      client = await connectMcpServer(server, cfg, { cwd: this.runFs });
      this.mcp.set(server, client);
    }
    const r = await client.callTool({ name: tool, arguments: args });
    if (r.isError) throw new Error(`tool error: ${(r.content as { text?: string }[])[0]?.text ?? tool}`);
    const text = (r.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
    let resultJson: unknown;
    try {
      resultJson = JSON.parse(text);
    } catch {
      resultJson = undefined;
    }
    return { resultText: text, resultJson };
  }

  async close(): Promise<void> {
    for (const c of this.mcp.values()) {
      try {
        await c.close();
      } catch {
        // 무시
      }
    }
    this.mcp.clear();
  }

  /** run fs 스냅샷 (updateGolden용 변경 감지: rel → mtime+size) */
  snapshot(): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          walk(p);
        } else {
          try {
            const st = statSync(p);
            out.set(relative(this.runFs, p).replace(/\\/g, "/"), `${st.mtimeMs}:${st.size}`);
          } catch {
            // 무시
          }
        }
      }
    };
    walk(this.runFs);
    return out;
  }
}
