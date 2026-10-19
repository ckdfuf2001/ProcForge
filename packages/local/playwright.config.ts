import { defineConfig } from "@playwright/test";

// M7-5-6: 실제 브라우저(chromium) E2E. 서버·가짜 OpenCode·임시 저장소는 스펙에서 띄운다.
// Windows 로컬도 실행 가능하지만 CI 는 ubuntu 만 (DEV-GUIDE §6).
export default defineConfig({
  testDir: "./test-e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  outputDir: "./test-results",
  use: {
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
