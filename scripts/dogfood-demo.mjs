// M3.5 dogfood 데모 흐름: scripted host 세션 → record → replay → trace → export.
// 경로에 공백 포함 ("작업 폴더"). CLI 바이너리로 실행해 실사용 경로 검증.
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const localDist = join(repoRoot, "packages", "local", "dist");
const fixtureServer = join(repoRoot, "packages", "local", "test", "fixtures", "fake-ppt-mcp", "server.mjs");

const root = mkdtempSync(join(tmpdir(), "작업 폴더-"));
const pfdir = join(root, ".procforge");
writeFileSync(join(root, "data.pptx"), "fake-pptx");
writeFileSync(
  join(root, "opencode.json"),
  JSON.stringify({ mcp: { "fake-ppt": { type: "local", command: ["node", fixtureServer] } } }),
);
console.log("project:", root);

const { createLocalStack } = await import(pathToFileURL(join(localDist, "core-inprocess.js")).href);
const { collectCatalog } = await import(pathToFileURL(join(localDist, "catalog.js")).href);
const cli = join(localDist, "cli.js");
const env = { ...process.env, PROCFORGE_DIR: pfdir, PROCFORGE_PROJECT_ROOT: root };
const runCli = (args) => {
  const r = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
  console.log(`$ procforge ${args.join(" ")} → exit ${r.status}`);
  console.log((r.stdout || "").split("\n").slice(0, 6).join("\n"));
  if (r.status !== 0 && !args.includes("--mode")) console.log("STDERR:", (r.stderr || "").slice(0, 300));
  return r;
};

// 시나리오 (a): 9월 월간보고서 (scripted host가 모델 역할)
const { client } = createLocalStack(pfdir);
const collected = await collectCatalog(root);
const started = await client.pfStart({
  request: "a.pptx를 9월 월간보고서로 완성해라",
  params: { month: "2026-09" },
  toolCatalog: collected.entries,
  limits: { maxDepth: 3, maxRetries: 2, maxNodes: 20 },
});
const sid = started.session.id;
console.log("session:", sid);
await client.pfResolve({
  sessionId: sid, nodeId: "1", decision: "split",
  children: [{ goal: "슬라이드 목록 읽기" }, { goal: "2번 슬라이드 읽기", dependsOn: ["1.1"] }, { goal: "템플릿 채우기", dependsOn: ["1.1", "1.2"] }],
});
const leaf = async (nodeId, tool, args, rj, specs) => {
  await client.pfReport({
    sessionId: sid, nodeId, tool: { server: "fake-ppt", name: tool }, args,
    resultSummary: JSON.stringify(rj), resultJson: rj, selfVerdict: "pass", selfReason: "ok",
  });
  await client.pfResolve({ sessionId: sid, nodeId, decision: "leaf", tool: { server: "fake-ppt", name: tool }, argSpecs: specs });
};
await leaf("1.1", "list_slides", { file: "data.pptx" }, { slides: ["표지", "실적", "전망"] }, { file: { kind: "fixed", value: "data.pptx" } });
await leaf("1.2", "read_slide", { file: "data.pptx", index: 2 }, { title: "슬라이드2", body: "본문" }, {
  file: { kind: "fixed", value: "data.pptx" }, index: { kind: "fixed", value: 2 },
});
await leaf("1.3", "fill_template", { template: "t.j2", month: "2026-09" }, { output: "report-2026-09.pptx" }, {
  template: { kind: "fixed", value: "t.j2" }, month: { kind: "var", ref: "${params.month}" },
});

runCli(["test", sid, "--mode", "record", "--allow-project-read"]);
runCli(["test", sid, "--mode", "replay", "--allow-project-read", "--junit", join(root, "report.xml")]);
runCli(["trace", sid]);
const zipOut = join(root, "session-redacted.zip");
runCli(["export", sid, "--redact", "--out", zipOut]);
console.log("DONE", JSON.stringify({ root, pfdir, sid }));
