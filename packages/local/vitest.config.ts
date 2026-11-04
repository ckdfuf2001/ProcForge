import { defineConfig } from "vitest/config";

const isRemote = process.env.PROCFORGE_CLIENT === "remote";

export default defineConfig({
  test: {
    // M7-5-6: E2E(Playwright)는 vitest 대상이 아니다.
    exclude: ["**/node_modules/**", "**/dist/**", "test-e2e/**"],
    // M9-tmp-fix: tmp 정리가 서버 close·자식 종료보다 나중에 돌도록 afterAll 역순 고정.
    // isolate는 파일별 모듈 격리 (registry가 파일 사이에 공유되지 않음).
    sequence: { hooks: "stack" },
    isolate: true,
    // M6.1-2: remote 모드 스위트 끝 egress 위반 단언 (inprocess/loopback은 통과).
    setupFiles: ["./test/setup-remote.ts"],
    // M6.1-2: remote는 파일당 실서버+loopback 폭풍이라 병렬을 제한한다
    // (Windows loopback 순간 실패 완화. CI Windows 포함).
    ...(isRemote
      ? { pool: "forks" as const, poolOptions: { forks: { minForks: 1, maxForks: 4 } } }
      : {}),
  },
});
