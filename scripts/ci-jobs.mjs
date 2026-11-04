import { get } from "node:https";

// 보고 전용: CI 잡별 결과 출력 (L3 게이트가 아님. dev-verify는 네트워크에 의존하지 않는다).
// 사용: node scripts/ci-jobs.mjs <run-id> | --sha <head-sha>
// 출력: 잡 이름 + conclusion, 마지막에 head_sha/run/conclusion 1줄.
// 공개 저장소는 토큰 없이 잡 목록 조회 가능. GITHUB_TOKEN이 있으면 로그용으로 함께 보낸다.

const REPO = "ckdfuf2001/ProcForge";
// 기대 잡 수. 매트릭스( 잡 구성)를 바꾸면 이 값도 함께 바꿀 것.
const EXPECTED_JOBS = 7;

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
  // --sha 입력 시 결과 head_sha가 입력값으로 시작하는지 단언한다.
  let wantedSha;
  if (arg === "--sha") {
    if (!val) throw new Error("usage: ci-jobs.mjs <run-id> | --sha <head-sha>");
    wantedSha = val;
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
  // M9-gates-fix: 잡 이름 중복이 있거나 고유 잡 수가 기대와 다르면 exit 1.
  // 하나를 놓치고 "7잡 success"처럼 보이는 것을 방지한다.
  // M9-tmp: success가 아닌 잡이 하나라도 있으면 exit 1 (출력만 보고 넘기지 않음).
  const names = (jobs.jobs ?? []).map((j) => j.name);
  const uniq = new Set(names);
  for (const j of jobs.jobs ?? []) {
    console.log(`${j.name} ${j.conclusion}`);
  }
  if (wantedSha !== undefined) {
    const got = (jobs.jobs ?? [])[0]?.head_sha;
    if (typeof got !== "string" || !got.startsWith(wantedSha)) {
      console.error(`error: head_sha 불일치 (입력 ${wantedSha}, 결과 ${got ?? "없음"})`);
      process.exitCode = 1;
    }
  }
  if (uniq.size !== names.length) {
    console.error(`error: 중복 잡 이름 있음 (${names.length}건 중 고유 ${uniq.size}건)`);
    process.exitCode = 1;
  } else if (uniq.size !== EXPECTED_JOBS) {
    console.error(`error: 고유 잡 수 ${uniq.size}건 (기대 ${EXPECTED_JOBS}건)`);
    process.exitCode = 1;
  } else {
    const bad = (jobs.jobs ?? []).filter((j) => j.conclusion !== "success");
    if (bad.length > 0) {
      console.error(`error: success 아님 ${bad.length}건: ${bad.map((j) => `${j.name}=${j.conclusion}`).join(", ")}`);
      process.exitCode = 1;
    }
  }
}

main().catch((e) => {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
