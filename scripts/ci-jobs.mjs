import { get } from "node:https";

// 보고 전용: CI 잡별 결과 출력 (L3 게이트가 아님. dev-verify는 네트워크에 의존하지 않는다).
// 사용: node scripts/ci-jobs.mjs <run-id> | --sha <head-sha>
// 출력: 잡 이름 + conclusion, 마지막에 head_sha/run/conclusion 1줄.
// 공개 저장소는 토큰 없이 잡 목록 조회 가능. GITHUB_TOKEN이 있으면 로그용으로 함께 보낸다.

const REPO = "ckdfuf2001/ProcForge";

function fetchJson(url) {
  const headers = { "User-Agent": "ci-jobs.mjs", Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return new Promise((resolveP, reject) => {
    get(url, { headers }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`GET ${url} -> ${res.statusCode}`));
        res.resume();
        return;
      }
      let body = "";
      res.on("data", (d) => {
        body += d;
      });
      res.on("end", () => {
        try {
          resolveP(JSON.parse(body));
        } catch (e) {
          reject(e);
        }
      });
    }).on("error", reject);
  });
}

async function main() {
  const [arg, val] = process.argv.slice(2);
  let runId = arg;
  if (arg === "--sha") {
    if (!val) throw new Error("usage: ci-jobs.mjs <run-id> | --sha <head-sha>");
    const runs = await fetchJson(
      `https://api.github.com/repos/${REPO}/actions/runs?per_page=10`,
    );
    const run = (runs.workflow_runs ?? []).find((r) => r.head_sha === val);
    if (!run) throw new Error(`run not found for sha ${val}`);
    runId = String(run.id);
    console.log(`run=${run.id} head_sha=${run.head_sha} conclusion=${run.conclusion}`);
  }
  const jobs = await fetchJson(
    `https://api.github.com/repos/${REPO}/actions/runs/${runId}/jobs?per_page=30`,
  );
  for (const j of jobs.jobs ?? []) {
    console.log(`${j.name} ${j.conclusion}`);
  }
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
