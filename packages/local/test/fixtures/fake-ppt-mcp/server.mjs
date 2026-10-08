import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// CI E2E용 가짜 ppt MCP 서버 (M2). stdio 전용. 의존성 없음(workspace SDK 사용).
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
  { template: z.string(), month: z.string() },
  async ({ template, month }) => {
    void template;
    return { content: [{ type: "text", text: JSON.stringify({ output: `report-${month}.pptx` }) }] };
  },
);

await server.connect(new StdioServerTransport());
