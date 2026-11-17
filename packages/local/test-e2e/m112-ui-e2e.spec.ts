import { test, expect, type Page } from "@playwright/test";
import { setup, seedSlowProcedure, type Harness } from "./harness.js";
import { cleanRegisteredTmp } from "@proof/shared/tmp.js";

// M9-tmp2: E2E 임시폴더 정리 (vitest afterAll이 아니라 Playwright 훅).
test.afterAll(() => {
  cleanRegisteredTmp();
});

// M11-2-ui: 실행 중 목록 2줄 + 클릭 전환 + 동시 실행 상한(3) 초과.

let h: Harness;

test.afterEach(async () => {
  await h?.close();
});

async function visitRunTab(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __cspViolations: string[] };
    w.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__cspViolations.push(e.violatedDirective);
    });
  });
  await page.goto(`${h.ui.url}/#t=${h.ui.token}`);
  await expect(page.getByRole("heading", { name: "Proof" })).toBeVisible();
  await page.locator("nav").getByRole("button", { name: "실행", exact: true }).click();
  await expect(page.getByRole("heading", { name: "실행", exact: true })).toBeVisible();
}

function runPanel(page: Page) {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "실행", exact: true }) });
}

async function expectNoCspViolation(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (window as unknown as { __cspViolations: string[] }).__cspViolations,
        ),
      { timeout: 5000 },
    )
    .toEqual([]);
}

test("M11-2-ui: 실행 중 목록 2줄 + 전환 + 상한(3) 초과", async ({ page }) => {
  h = await setup({ fakeMode: "ok" });
  const p1 = await seedSlowProcedure(h, "ui-slow-1");
  const p2 = await seedSlowProcedure(h, "ui-slow-2");
  const p3 = await seedSlowProcedure(h, "ui-slow-3");
  const p4 = await seedSlowProcedure(h, "ui-slow-4");
  await visitRunTab(page);
  const panel = runPanel(page);
  const list = () => panel.getByRole("list", { name: "실행 중 목록" });

  try {
    // 2개 시작 → 목록 2줄.
    await panel.getByLabel("절차서").selectOption(p1);
    await panel.getByRole("button", { name: "실행", exact: true }).click();
    await expect(list().getByRole("listitem")).toHaveCount(1, { timeout: 15000 });
    await panel.getByLabel("절차서").selectOption(p2);
    await panel.getByRole("button", { name: "실행", exact: true }).click();
    await expect(list().getByRole("listitem")).toHaveCount(2, { timeout: 15000 });

    // p1 클릭으로 전환 (p1 버튼 비활성화 = 선택됨, p2 버튼 활성화).
    await list().getByRole("button", { name: new RegExp(p1) }).click();
    await expect(list().getByRole("button", { name: new RegExp(p1) })).toBeDisabled();
    await expect(list().getByRole("button", { name: new RegExp(p2) })).toBeEnabled();

    // 3번째는 성공, 4번째는 상한 conflict.
    await panel.getByLabel("절차서").selectOption(p3);
    await panel.getByRole("button", { name: "실행", exact: true }).click();
    await expect(list().getByRole("listitem")).toHaveCount(3, { timeout: 15000 });
    await panel.getByLabel("절차서").selectOption(p4);
    await panel.getByRole("button", { name: "실행", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText("동시 실행 상한(3) 초과", {
      timeout: 15000,
    });

    await expectNoCspViolation(page);
  } finally {
    // 자는 실행을 깨야 tmp 정리가 된다.
    for (const r of h.app.listActiveRuns()) {
      try {
        await h.app.uiRunCancel({ runId: r.runId });
      } catch {
        // 정리 베스트 에퍼트
      }
    }
    // M12-e2e-leak: 취소한 run이 끝나기를 최대 30초 기다린다 (정리 중 잠금 경합 방지).
    {
      const t0 = Date.now();
      while (h.app.listActiveRuns().length > 0 && Date.now() - t0 < 30000) {
        await new Promise((r) => setTimeout(r, 500));
      }
      if (h.app.listActiveRuns().length > 0) {
        console.warn(`[m112-ui-e2e] 30s 대기 초과, 남은 run: ${h.app.listActiveRuns().map((r) => r.procedure).join(",")}`);
      }
    }
  }
});

test("M11-2-ui-fix: stale 응답이 clear를 덮지 않는다", async ({ page }) => {
  h = await setup({ fakeMode: "ok" });
  const p1 = await seedSlowProcedure(h, "ui-wait-1");
  const p2 = await seedSlowProcedure(h, "ui-wait-2");
  const p3 = await seedSlowProcedure(h, "ui-wait-3");
  await visitRunTab(page);
  const panel = runPanel(page);
  const list = () => panel.getByRole("list", { name: "실행 중 목록" });
  try {
    await panel.getByLabel("절차서").selectOption(p1);
    await panel.getByRole("button", { name: "실행", exact: true }).click();
    await expect(list().getByRole("listitem")).toHaveCount(1, { timeout: 15000 });
    await panel.getByLabel("절차서").selectOption(p2);
    await panel.getByRole("button", { name: "실행", exact: true }).click();
    await expect(list().getByRole("listitem")).toHaveCount(2, { timeout: 15000 });
    // runInfo 응답을 늦춰 stale 응답을 만든다 (clear보다 늦게 도착).
    await page.route("**/api/runs/*", async (route) => {
      const url = route.request().url();
      if (
        url.includes("/api/runs/active") ||
        url.includes("/stream") ||
        route.request().method() !== "GET"
      ) {
        await route.continue();
        return;
      }
      await new Promise((r) => setTimeout(r, 3000));
      await route.continue();
    });
    // p1 목록 클릭으로 runInfo 요청을 띄운 뒤 곧바로 p3로 전환한다.
    // (선택 중은 p2라 p1 버튼이 활성화돼 있다.)
    await list().getByRole("button", { name: new RegExp(p1) }).click();
    await panel.getByLabel("절차서").selectOption(p3);
    // clear가 먼저 적용되고, 3초 뒤 stale 응답이 와도 화면은 비어 있어야 한다.
    // 고정 대기: route 지연(3s)이 끝난 뒤에야 stale이 도착하므로 4.5초를 기다린다.
    await page.waitForTimeout(4500);
    await expect(panel.getByText(/run .* · 절차서/)).toBeHidden({ timeout: 5000 });
    await expect(
      panel.getByRole("button", { name: "실행", exact: true }),
    ).toBeEnabled({ timeout: 5000 });
    await page.unrouteAll({ behavior: "wait" });
    await expectNoCspViolation(page);
  } finally {
    for (const r of h.app.listActiveRuns()) {
      try {
        await h.app.uiRunCancel({ runId: r.runId });
      } catch {
        // 정리 베스트 에퍼트
      }
    }
    // M12-e2e-leak: 취소한 run이 끝나기를 최대 30초 기다린다 (정리 중 잠금 경합 방지).
    {
      const t0 = Date.now();
      while (h.app.listActiveRuns().length > 0 && Date.now() - t0 < 30000) {
        await new Promise((r) => setTimeout(r, 500));
      }
      if (h.app.listActiveRuns().length > 0) {
        console.warn(`[m112-ui-e2e] 30s 대기 초과, 남은 run: ${h.app.listActiveRuns().map((r) => r.procedure).join(",")}`);
      }
    }
  }
});
