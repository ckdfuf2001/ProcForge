import { test, expect, type Page } from "@playwright/test";
import { setup, seedTwoLeaves, restartUi, type Harness } from "./harness.js";

// M8-ui4: 토큰 입력 화면 E2E (실제 chromium + 실제 UI dist + 실제 local 서버).

let h: Harness;

test.afterEach(async () => {
  await h?.close();
});

async function expectGate(page: Page, notice?: RegExp): Promise<void> {
  await expect(page.getByRole("heading", { name: "토큰 입력" })).toBeVisible();
  await expect(page.locator("#pf-token")).toHaveAttribute("type", "password");
  await expect(page.locator("#pf-token")).toHaveAttribute("autocomplete", "off");
  if (notice) await expect(page.locator(".token-panel")).toContainText(notice);
}

async function connect(page: Page, value: string): Promise<void> {
  await page.locator("#pf-token").fill(value);
  await page.getByRole("button", { name: "연결", exact: true }).click();
}

async function expectList(page: Page, sid: string): Promise<void> {
  await expect(page.getByRole("heading", { name: "ProcForge", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: sid.slice(0, 8), exact: true })).toBeVisible();
}

test("(1) 무토큰 진입 → 입력 화면", async ({ page }) => {
  h = await setup();
  await page.goto(`${h.ui.url}/`);
  await expectGate(page, /터미널에 출력된 토큰/);
  expect(new URL(page.url()).hash).toBe("");
});

test("(2) 잘못된 토큰 → 오류, 입력 화면 유지", async ({ page }) => {
  h = await setup();
  await page.goto(`${h.ui.url}/`);
  await connect(page, "deadbeefdeadbeef");
  await expectGate(page, /올바르지 않습니다/);
});

test("(3) 정상 토큰 → 목록 (주소에 #t= 없음)", async ({ page }) => {
  h = await setup();
  const sid = await seedTwoLeaves(h);
  await page.goto(`${h.ui.url}/`);
  await connect(page, h.ui.token);
  await expectList(page, sid);
  expect(new URL(page.url()).hash).toBe("");
});

test("(4) 새로고침 → 토큰 유지 (sessionStorage)", async ({ page }) => {
  h = await setup();
  const sid = await seedTwoLeaves(h);
  await page.goto(`${h.ui.url}/#t=${h.ui.token}`);
  await expectList(page, sid);
  await page.reload();
  await expectList(page, sid);
});

test("(5) 같은 주소 새 탭 → 입력 화면", async ({ page }) => {
  h = await setup();
  const sid = await seedTwoLeaves(h);
  await page.goto(`${h.ui.url}/#t=${h.ui.token}`);
  await expectList(page, sid);
  const other = await page.context().newPage();
  await other.goto(`${h.ui.url}/`);
  await expectGate(other, /터미널에 출력된 토큰/);
});

test("(6) 서버 재시작 → 재시작 안내", async ({ page }) => {
  h = await setup();
  const sid = await seedTwoLeaves(h);
  const firstInstance = h.ui.instance;
  await page.goto(`${h.ui.url}/#t=${h.ui.token}`);
  await expectList(page, sid);
  await restartUi(h);
  expect(h.ui.instance).not.toBe(firstInstance);
  await page.reload();
  await expectGate(page, /서버가 재시작되어/);
});

test("(7) 연결 해제 → 입력 화면, 새로고침해도 토큰 없음", async ({ page }) => {
  h = await setup();
  const sid = await seedTwoLeaves(h);
  await page.goto(`${h.ui.url}/#t=${h.ui.token}`);
  await expectList(page, sid);
  await page.getByRole("button", { name: "연결 해제" }).click();
  await expectGate(page, /터미널에 출력된 토큰/);
  await page.reload();
  await expectGate(page, /터미널에 출력된 토큰/);
});

test("(8) 전체 URL 붙여넣기 → 연결 성공, #t= 제거", async ({ page }) => {
  h = await setup();
  const sid = await seedTwoLeaves(h);
  await page.goto(`${h.ui.url}/`);
  await connect(page, `${h.ui.url}/#t=${h.ui.token}`);
  await expectList(page, sid);
  expect(new URL(page.url()).hash).toBe("");
});
