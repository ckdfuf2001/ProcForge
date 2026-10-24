import { test, expect, type Page } from "@playwright/test";
import { setup, seedTwoLeaves, simulateReport, pair, OC_SID, type Harness } from "./harness.js";

// M8-1-0: leaf 자기 재검증(needs_reverify) E2E.
// 시나리오: 확정 leaf에 의견 등록 → 재검증 배지 → 가짜 모델의 새 report·confirm
// → 타임라인에 의견/실행/재확정 이벤트.

let h: Harness;

test.afterEach(async () => {
  await h?.close();
});

async function openSession(page: Page, sid: string): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __cspViolations: string[] };
    w.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__cspViolations.push(e.violatedDirective);
    });
  });
  await page.goto(`${h.ui.url}/#t=${h.ui.token}`);
  await expect(page.getByRole("heading", { name: "ProcForge" })).toBeVisible();
  await page.getByRole("button", { name: sid.slice(0, 8), exact: true }).click();
  await expect(page.getByText(/실시간:/)).toBeVisible();
}

function rowOf(page: Page, nid: string) {
  return page
    .locator("tr")
    .filter({ has: page.getByRole("button", { name: nid, exact: true }) });
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

test("(f) leaf 의견 → 재검증 배지 → 재보고·재확정 → 타임라인 이벤트", async ({
  page,
}) => {
  h = await setup({ fakeMode: "ok" });
  const sid = await seedTwoLeaves(h);
  pair(h, OC_SID, sid);

  await openSession(page, sid);

  // 트리 탭 → 1.1 상세 → 의견 등록(제약이 생겨 hash가 바뀐다)
  await page.getByRole("tab", { name: "트리" }).click();
  await page.getByRole("button", { name: "1.1", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /^1\.1 · / }),
  ).toBeVisible();
  await page.getByLabel("사람 조언").fill("보고서 문장을 다듬어라");
  await page.getByRole("button", { name: "의견 등록 + 계속 신호" }).click();
  await expect(page.getByText(/advise-and-signal 저장됨/)).toBeVisible();

  // 재검증 배지(needs_reverify)
  await expect(rowOf(page, "1.1")).toHaveClass(/st-needs-reverify/, {
    timeout: 20000,
  });
  await expect(rowOf(page, "1.1")).toContainText("재검증 대기");
  expect((await h.app.core.getNode(sid, "1.1")).status).toBe("needs_reverify");

  // 가짜 모델의 새 report·confirm (MCP pf_report/confirm_leaf 와 동일 경로)
  await simulateReport(h, sid, "1.1", { note: "hi" });
  await expect(rowOf(page, "1.1")).toHaveClass(/st-leaf/, { timeout: 20000 });

  // 타임라인: 분해 라운드 탭 → 라운드 선택 → 라운드 이후 이벤트
  await page.getByRole("tab", { name: "분해 라운드" }).click();
  await expect(page.getByText(/실시간:/)).toBeVisible();
  await page.locator(".round-item").first().click();
  const events = page.locator(".reason-events .reason-event");
  await expect(events.last()).toBeVisible({ timeout: 20000 });
  // 마지막 3개 = 이번 재검증 체인(의견 → 재검증 → 재확정)
  await expect(events.nth(-3)).toContainText("의견");
  await expect(events.nth(-2)).toContainText("재검증");
  await expect(events.last()).toContainText("재확정");

  await expectNoCspViolation(page);
});
