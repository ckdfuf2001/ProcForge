import { get } from "node:https";
import { createHash } from "node:crypto";

// 보고 전용: CI 잡별 결과 출력 (L3 게이트가 아님. dev-verify는 네트워크에 의존하지 않는다).
// 사용: node scripts/ci-jobs.mjs <run-id> | --sha <head-sha>
// 출력: 잡 이름 + conclusion (이름순 정렬), 마지막에 요약 줄 1줄
// (`run=<id> head=<앞 12자리> jobs= unique= success= digest=`).
// 보고에는 요약 줄 1줄만 복사한다 (셸 출력 그대로, 타이핑 금지).
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
  // M9-ci-out: 잡 줄을 이름순으로 출력한다. 옮겨 적다가 틀리면 바로 눈에 띈다.
  // 요약 줄의 digest는 정렬한 "이름 conclusion" 줄들을 \n으로 이은 문자열의 sha256 앞 12자리다.
  const rows = (jobs.jobs ?? []).map((j) => `${j.name} ${j.conclusion}`).sort();
  for (const r of rows) console.log(r);
  if (wantedSha !== undefined) {
    // 모든 잡의 head_sha가 입력 sha로 시작하는지 단언한다.
    const mismatched = (jobs.jobs ?? []).filter(
      (j) => typeof j.head_sha !== "string" || !j.head_sha.startsWith(wantedSha),
    );
    if (mismatched.length > 0) {
      console.error(
        `error: head_sha 불일치 ${mismatched.length}건 (입력 ${wantedSha}): ${mismatched.map((j) => `${j.name}=${j.head_sha ?? "없음"}`).join(", ")}`,
      );
      process.exitCode = 1;
    }
  }
  // M9-tmp-2: 요약 줄에 run과 head를 넣는다. digest 입력 맨 앞에
  // `run=<id>\nhead=<전체 sha>\n`을 붙인 뒤 정렬한 잡 줄을 잇는다.
  // 이렇게 하면 run마다 digest가 달라진다 (이전 digest는 run 구분이 안 됐음).
  const names = rows.map((r) => r.slice(0, r.lastIndexOf(" ")));
  const uniq = new Set(names);
  const okCount = (jobs.jobs ?? []).filter((j) => j.conclusion === "success").length;
  const headFull = String((jobs.jobs ?? [])[0]?.head_sha ?? "");
  const digest = createHash("sha256")
    .update(`run=${runId}\nhead=${headFull}\n` + rows.join("\n"))
    .digest("hex")
    .slice(0, 12);
  console.log(`run=${runId} head=${headFull.slice(0, 12)} jobs=${names.length} unique=${uniq.size} success=${okCount} digest=${digest}`);
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
