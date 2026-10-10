import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// CI E2E용 가짜 ppt MCP 서버 (M2). stdio 전용.
// fill_template은 실제 파일을 쓴다 (상대경로 → cwd 기준. runner는 cwd=run fs로 spawn, M3.1-3).
const server = new McpServer({ name: "fake-ppt-mcp", version: "0.0.0" });

server.tool(
  "list_slides",
  "List slides in a pptx file",
  { file: z.string() },
  async ({ file }) => {
    void file;
    return { content: [{ type: "text", text: JSON.stringify({ slides: ["표지", "실적", "전망"] }) }] };
  },
);

server.tool(
  "read_slide",
  "Read one slide",
  { file: z.string(), index: z.number().int() },
  async ({ file, index }) => {
    void file;
    return { content: [{ type: "text", text: JSON.stringify({ title: `슬라이드${index}`, body: "본문" }) }] };
  },
);

server.tool(
  "fill_template",
  "Fill report template",
  { template: z.string(), month: z.string(), output: z.string().optional(), content: z.string().optional() },
  async ({ template, month, output, content }) => {
    const tpl = existsSync(template) ? readFileSync(template, "utf8") : "no-template";
    const out = output ?? `report-${month}.pptx`;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `filled:${month}:${tpl}:${content ?? ""}`);
    return { content: [{ type: "text", text: JSON.stringify({ output: out, month, ...(content !== undefined ? { content } : {}) }) }] };
  },
);

server.tool(
  "read_json",
  "Read a JSON file and return parsed content (M5.1-C4)",
  { path: z.string() },
  async ({ path }) => {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
);

server.tool(
  "save",
  "Save text to a file (M3.3 weakIn test)",
  { file_path: z.string(), content: z.string().optional() },
  async ({ file_path, content }) => {
    mkdirSync(dirname(file_path), { recursive: true });
    writeFileSync(file_path, content ?? "");
    return { content: [{ type: "text", text: JSON.stringify({ saved: file_path }) }] };
  },
);

server.tool(
  "echo",
  "Echo args back as JSON (M3.3 split-dep test)",
  { snapshot: z.unknown().optional(), url: z.string().optional(), title: z.string().optional(), note: z.string().optional() },
  async (args) => {
    return { content: [{ type: "text", text: JSON.stringify(args) }] };
  },
);

server.tool(
  "search",
  "Search text (M3.4 readOnly test)",
  { query: z.string(), title: z.string().optional() },
  async ({ query, title }) => {
    return { content: [{ type: "text", text: JSON.stringify({ hits: [query, title ?? null] }) }] };
  },
);

await server.connect(new StdioServerTransport());
