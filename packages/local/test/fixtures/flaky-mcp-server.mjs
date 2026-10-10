import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, writeFileSync } from "node:fs";
import { z } from "zod";

// M3.5.1-4: 첫 기동은 실패, 재시도부터 정상 (카탈로그 1회 재시도 검증용).
// FLAG_PATH env가 가리키는 파일이 없으면 만들고 exit 1.

const flag = process.env.FLAG_PATH;
if (!flag) {
  console.error("FLAG_PATH missing");
  process.exit(1);
}
if (!existsSync(flag)) {
  writeFileSync(flag, "1");
  process.exit(1);
}

const server = new McpServer({ name: "flaky-mcp", version: "0.0.0" });
server.tool("ping", "Ping", { msg: z.string().optional() }, async ({ msg }) => ({
  content: [{ type: "text", text: `pong:${msg ?? ""}` }],
}));
await server.connect(new StdioServerTransport());
