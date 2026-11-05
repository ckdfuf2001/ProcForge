// CI: `procforge test --mode replay --junit` 왕복 검증 (M3 완료 조건).
// 빌드된 dist만 사용. tmp 프로젝트 + 가짜 ppt-mcp로 record → 서버 차단 → replay.
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
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
const home = mkdtempSync(join(tmpdir(), "pf-ci-home-"));

// M9-tmp-2: 끝나면(실패해도) 임시 폴더를 지운다.
// PROOF_KEEP_TMP=1이면 남기고 경로를 stderr에 출력한다 (증거 보존용).
function cleanTmp() {
  if (process.env.PROOF_KEEP_TMP === "1") {
    console.error(`[tmp] KEEP(삭제 안 함): ${root} ${home}`);
    return;
  }
  for (const d of [root, home]) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (e) {
      console.error(`[tmp-clean] 정리 실패(남김): ${d} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
}

try {
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
      throw new Error(`cli failed: procforge ${args.join(" ")}\n${r.stdout}\n${r.stderr}`);
    }
    return r;
  };

  // HOME 격리 (전역 opencode.json 간섭 방지)
  process.env.HOME = home;
  process.env.USERPROFILE = home;

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

  runCli(["test", "--session", sid, "--mode", "record", "--allow-project-read"]);
  writeCfg(["nonexistent-procforge-tool-xyz"]); // 서버 차단: replay는 녹화본만 사용
  const junit = join(root, "junit.xml");
  runCli(["test", "--session", sid, "--mode", "replay", "--allow-project-read", "--junit", junit]);
  if (!existsSync(junit)) {
    throw new Error("junit.xml missing");
  }
  console.log("m3-ci-replay: OK");
} finally {
  cleanTmp();
}
