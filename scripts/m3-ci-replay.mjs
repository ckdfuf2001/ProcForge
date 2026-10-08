// CI: `procforge test --mode replay --junit` 왕복 검증 (M3 완료 조건).
// 빌드된 dist만 사용. tmp 프로젝트 + fake-ppt-mcp로 record → 서버 차단 → replay.
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const localDist = join(repoRoot, "packages", "local", "dist");
const fixtureServer = join(repoRoot, "packages", "local", "test", "fixtures", "fake-ppt-mcp", "server.mjs");

const root = mkdtempSync(join(tmpdir(), "pf-ci-"));
const pfdir = join(root, ".procforge");
writeFileSync(join(root, "data.pptx"), "x");
const writeCfg = (cmd) =>
  writeFileSync(join(root, "opencode.json"), JSON.stringify({ mcp: { "fake-ppt": { type: "local", command: cmd } } }));
writeCfg(["node", fixtureServer]);

const { createLocalStack } = await import(pathToFileURL(join(localDist, "core-inprocess.js")).href);
const { collectCatalog } = await import(pathToFileURL(join(localDist, "catalog.js")).href);
const cli = join(localDist, "cli.js");

const runCli = (args, env = {}) => {
  const r = spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, PROCFORGE_DIR: pfdir, PROCFORGE_PROJECT_ROOT: root, ...env },
    encoding: "utf8",
  });
  if (r.status !== 0) {
    console.error(`cli failed: procforge ${args.join(" ")}\n${r.stdout}\n${r.stderr}`);
    process.exit(1);
  }
  return r;
};

// HOME 격리 (전역 opencode.json 간섭 방지)
process.env.HOME = mkdtempSync(join(tmpdir(), "pf-ci-home-"));
process.env.USERPROFILE = process.env.HOME;

const { client } = createLocalStack(pfdir);
const collected = await collectCatalog(root);
const started = await client.pfStart({
  request: "CI 보고서",
  toolCatalog: collected.entries,
  limits: { maxDepth: 3, maxRetries: 2, maxNodes: 10 },
});
const sid = started.session.id;
await client.pfResolve({ sessionId: sid, nodeId: "1", decision: "split", children: [{ goal: "a" }, { goal: "b" }] });
for (const [nid, tool, args, rj] of [
  ["1.1", "list_slides", { file: "data.pptx" }, { slides: ["표지", "실적", "전망"] }],
  ["1.2", "read_slide", { file: "data.pptx", index: 1 }, { title: "슬라이드1", body: "본문" }],
]) {
  await client.pfReport({
    sessionId: sid, nodeId: nid, tool: { server: "fake-ppt", name: tool }, args,
    resultSummary: JSON.stringify(rj), resultJson: rj, selfVerdict: "pass", selfReason: "ci",
  });
  const specs = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, { kind: "fixed", value: v }]));
  await client.pfResolve({ sessionId: sid, nodeId: nid, decision: "leaf", tool: { server: "fake-ppt", name: tool }, argSpecs: specs });
}

runCli(["test", "--session", sid, "--mode", "record"]);
writeCfg(["nonexistent-procforge-tool-xyz"]); // 서버 차단: replay는 녹화본만 사용
const junit = join(root, "junit.xml");
runCli(["test", "--session", sid, "--mode", "replay", "--junit", junit]);
if (!existsSync(junit)) {
  console.error("junit.xml missing");
  process.exit(1);
}
console.log("m3-ci-replay: OK");
