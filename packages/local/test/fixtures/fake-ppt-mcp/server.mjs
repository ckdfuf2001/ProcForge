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
  "page",
  "Paginated list (M5.5-2). Empty cursor starts. Fixed 2 pages.",
  { cursor: z.string().optional() },
  async ({ cursor }) => {
    if (!cursor) {
      return { content: [{ type: "text", text: JSON.stringify({ items: ["a", "b"], nextCursor: "p2" }) }] };
    }
    if (cursor === "p2") {
      return { content: [{ type: "text", text: JSON.stringify({ items: ["c"], nextCursor: null }) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ items: [], nextCursor: null }) }] };
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

// M5.5-5 dogfood: 날짜별 3페이지 목록. d1: x1,x2/x3/빈칸, d2: x1,x2/x3/x4.
server.tool(
  "board",
  "Date-scoped paginated board (M5.5-5)",
  { day: z.string(), cursor: z.string().optional() },
  async ({ day, cursor }) => {
    const last = day === "d2" ? [{ id: "x4" }] : [];
    if (!cursor) {
      return { content: [{ type: "text", text: JSON.stringify({ items: [{ id: "x1" }, { id: "x2" }], nextCursor: "p2" }) }] };
    }
    if (cursor === "p2") {
      return { content: [{ type: "text", text: JSON.stringify({ items: [{ id: "x3" }], nextCursor: "p3" }) }] };
    }
    if (cursor === "p3") {
      return { content: [{ type: "text", text: JSON.stringify({ items: last, nextCursor: null }) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ items: [], nextCursor: null }) }] };
  },
);

server.tool(
  "detail",
  "Item detail (M5.5-5). x3 always fails.",
  { id: z.string() },
  async ({ id }) => {
    if (id === "x3") throw new Error("detail unavailable: x3");
    return { content: [{ type: "text", text: JSON.stringify({ id, title: `t-${id}` }) }] };
  },
);

await server.connect(new StdioServerTransport());
