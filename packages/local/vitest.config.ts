import { defineConfig } from "vitest/config";

const isRemote = process.env.PROCFORGE_CLIENT === "remote";

export default defineConfig({
  test: {
    // M7-5-6: E2E(Playwright)는 vitest 대상이 아니다.
    exclude: ["**/node_modules/**", "**/dist/**", "test-e2e/**"],
    // M6.1-2: remote 모드 스위트 끝 egress 위반 단언 (inprocess/loopback은 통과).
    setupFiles: ["./test/setup-remote.ts"],
    // M6.1-2: remote는 파일당 실서버+loopback 폭풍이라 병렬을 제한한다
    // (Windows loopback 순간 실패 완화. CI Windows 포함).
    ...(isRemote
      ? { pool: "forks" as const, poolOptions: { forks: { minForks: 1, maxForks: 4 } } }
      : {}),
  },
});
