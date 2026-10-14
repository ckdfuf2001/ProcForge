import { afterAll } from "vitest";
import { inspectEgress } from "../src/services/egress.js";
import { drainSentRequests } from "./client-mode.js";

// M6.1-2: 워커 재사용 시 이전 파일 서버 env가 새 파일 CLI·createLocalStack을
// 오염시키므로 파일 시작 시점에 초기화한다 (setupFiles는 파일별 실행).
delete process.env.PROCFORGE_CORE_URL;
delete process.env.PROCFORGE_CORE_API_KEY;

// M6.1-2: remote 모드에서 전 요청을 수집해 egress 규칙 위반 0건을
// 스위트(파일) 끝에서 단언. inprocess/loopback에서는 수집 없음 (통과).
// guardEgress가 전송 시점에 차단하므로 여기는 두 번째 그물 (우회 경로 탐지용).
afterAll(() => {
  if (process.env.PROCFORGE_CLIENT !== "remote") return;
  const reqs = drainSentRequests();
  const violations: string[] = [];
  for (const { path, body } of reqs) {
    const m = /^\/v1\/([A-Za-z]+)$/.exec(path);
    if (!m) continue;
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      continue;
    }
    const r = inspectEgress(m[1], json);
    for (const v of r.violations) violations.push(`${m[1]}: ${v}`);
  }
  if (violations.length > 0) {
    throw new Error(
      `egress 위반 ${violations.length}건:\n${violations.slice(0, 5).join("\n")}`,
    );
  }
});
