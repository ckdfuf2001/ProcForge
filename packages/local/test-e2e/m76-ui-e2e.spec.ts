import { test, expect, type Page } from "@playwright/test";
import {
  setup,
  seedTwoLeaves,
  seedExternalProcedure,
  seedSlowProcedure,
  simulateReport,
  pair,
  OC_SID,
  type Harness,
} from "./harness.js";

// M7-5-6: Playwright E2E (실제 chromium + 실제 UI dist + 실제 local 서버).
// 시나리오: (a) 월간보고서 (b) 크롤링 args 수정 (c) conflict (d) plan/버전 미확인
// (e) 실행 탭: 승인 대기→화면 승인→done / 취소→재실행 (M7-close-a).

let h: Harness;

test.afterEach(async () => {
  await h?.close();
});

async function openSession(page: Page, sid: string): Promise<void> {
  // CSP 위반 수집 (securitypolicyviolation 0건 단언용)
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

async function openNode(page: Page, nid: string): Promise<void> {
  await page.getByRole("button", { name: nid, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: new RegExp(`^${nid.replace(".", "\\.")} · `) }),
  ).toBeVisible();
}

/** M7-close-a: CSP 수집을 깐 채 실행 탭으로 진입. */
async function visitRunTab(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __cspViolations: string[] };
    w.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      w.__cspViolations.push(e.violatedDirective);
    });
  });
  await page.goto(`${h.ui.url}/#t=${h.ui.token}`);
  await expect(page.getByRole("heading", { name: "ProcForge" })).toBeVisible();
  await page.locator("nav").getByRole("button", { name: "실행", exact: true }).click();
  await expect(page.getByRole("heading", { name: "실행", exact: true })).toBeVisible();
}

function runPanel(page: Page) {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "실행", exact: true }) });
}

async function setArgs(page: Page, obj: Record<string, unknown>): Promise<void> {
  const editor = page.locator('[aria-label="인자 JSON"]');
  await editor.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.insertText(JSON.stringify(obj, null, 2));
}

function rowOf(page: Page, nid: string) {
  return page
    .locator("tr")
    .filter({ has: page.getByRole("button", { name: nid, exact: true }) });
}

/** SSE 로 UI 가 새 revision 을 받아 baseRevision 을 갱신할 때까지 기다린다. */
async function waitUiRevision(sid: string, prev: number): Promise<void> {
  await expect
    .poll(async () => (await h.app.readSession(sid)).revision, { timeout: 15000 })
    .toBeGreaterThan(prev);
  await new Promise((r) => setTimeout(r, 300));
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

test("(a) 월간보고서: 1.1 인자 수정 → 미리보기에 의존 노드 1.2 → 의견+신호 B → 재보고 → leaf", async ({
  page,
}) => {
  h = await setup({ fakeMode: "ok" });
  const sid = await seedTwoLeaves(h, { dep12: true });
  pair(h, OC_SID, sid);

  await openSession(page, sid);
  await expect(page.getByRole("button", { name: "1.2", exact: true })).toBeVisible();
  await openNode(page, "1.1");

  await setArgs(page, { note: { kind: "fixed", value: "hi" }, selector: { kind: "fixed", value: "#period" } });
  await page.getByRole("button", { name: "stale 미리보기" }).click();
  const preview = page.getByText(/이 변경으로 다시 실행될 노드/);
  await expect(preview).toBeVisible();
  // 원인 노드 자신(1.1)은 목록에서 빠지고, 의존하는 1.2 만 나온다.
  await expect(preview).toContainText("1.2");
  await expect(preview).not.toContainText("1.1");

  const revBefore = (await h.app.readSession(sid)).revision;
  await page.getByRole("button", { name: "인자 저장" }).click();
  await expect(page.getByText(/edit-args 저장됨/)).toBeVisible();
  await waitUiRevision(sid, revBefore);

  // stale 전파로 1.2 가 다시 실행 대기 상태가 된다.
  await openNode(page, "1.2");
  await page.getByLabel("사람 조언").fill("기간은 2026-10 이어야 한다");
  await page.getByRole("button", { name: "의견 등록 + 계속 신호" }).click();
  await expect(page.getByText(/advise-and-signal 저장됨/)).toBeVisible();
  // 신호 B 가 가짜 OpenCode 에 실제로 도착했다
  await expect
    .poll(() => h.fake.sent.length, { timeout: 15000 })
    .toBe(1);
  expect(h.fake.requests).toContain(`POST /session/${OC_SID}/message`);

  // 가짜 모델의 재보고 (MCP pf_report/confirm_leaf 와 동일한 core 경로)
  await simulateReport(h, sid, "1.2", { note: "hi", selector: "#period" });
  await expect(rowOf(page, "1.2")).toHaveClass(/st-leaf/, { timeout: 20000 });

  await expectNoCspViolation(page);
});

test("(b) 크롤링: 1.1 선택자 수정 → 의존 노드 없음 → 1.1 재실행, 1.2 불변", async ({
  page,
}) => {
  h = await setup({ fakeMode: "ok" });
  const sid = await seedTwoLeaves(h, { request: "크롤링해서 저장" });
  const h12 = (await h.app.core.getNode(sid, "1.2")).hash;

  await openSession(page, sid);
  await openNode(page, "1.1");

  await setArgs(page, { note: { kind: "fixed", value: "hi" }, selector: { kind: "fixed", value: ".item > a" } });
  await page.getByRole("button", { name: "stale 미리보기" }).click();
  const preview = page.getByText(/이 변경으로 다시 실행될 노드/);
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("0개");
  await expect(preview).not.toContainText("1.2");

  await page.getByRole("button", { name: "인자 저장" }).click();
  await expect(page.getByText(/edit-args 저장됨/)).toBeVisible();

  await simulateReport(h, sid, "1.1", { note: "hi", selector: ".item > a" });
  await expect(rowOf(page, "1.1")).toHaveClass(/st-leaf/, { timeout: 20000 });

  // 1.2 는 해시·상태 모두 그대로 (해당 노드만 재실행)
  expect((await h.app.core.getNode(sid, "1.2")).hash).toBe(h12);
  expect((await h.app.core.getNode(sid, "1.2")).status).toBe("leaf");
  await expect(rowOf(page, "1.2")).toHaveClass(/st-leaf/);

  await expectNoCspViolation(page);
});

test("(c) conflict: MCP 가 먼저 쓰면 배너 + 409, 초안 유지·서버 데이터 유실 0", async ({
  page,
}) => {
  h = await setup({ fakeMode: "ok" });
  const sid = await seedTwoLeaves(h);

  await openSession(page, sid);
  await openNode(page, "1.1");

  await setArgs(page, { note: { kind: "fixed", value: "hi" }, draft: { kind: "fixed", value: "DRAFT-42" } });

  // MCP(host) 쪽 선행 쓰기
  await h.app.core.pfEditArgs({
    sessionId: sid,
    nodeId: "1.1",
    patch: { set: { note: { kind: "fixed", value: "hi" }, other: { kind: "fixed", value: "mcp" } } },
    expectedRevision: (await h.app.readSession(sid)).revision,
    actor: "host",
  } as never);

  await expect(page.getByText(/저장하면 409가/)).toBeVisible({ timeout: 20000 });

  await page.getByRole("button", { name: "인자 저장" }).click();
  await expect(page.getByText(/다른 곳에서 변경됨 \(409\)/)).toBeVisible();
  // 초안 유지 (UI 가 서버 값으로 덮어쓰지 않는다)
  await expect(page.locator('[aria-label="인자 JSON"]')).toContainText("DRAFT-42");
  // M7-close-c: "초안 복사" → 다시 읽기 전에 초안을 보관/복사한다 (유실 0)
  await page.getByRole("button", { name: "초안 복사" }).click();
  await expect(page.locator('pre[aria-label="초안"]')).toContainText("DRAFT-42");
  // 서버 데이터는 MCP 값 그대로 (유실 0)
  const node = await h.app.core.getNode(sid, "1.1");
  expect(node.args).toMatchObject({ note: { kind: "fixed", value: "hi" } });
  expect(JSON.stringify(node)).not.toContain("DRAFT-42");

  await expectNoCspViolation(page);
});

test("(d) plan 모드: 신호 실패 + C 복사 문구", async ({ page }) => {
  h = await setup({ fakeMode: "plan" });
  const sid = await seedTwoLeaves(h);
  pair(h, OC_SID, sid);

  await openSession(page, sid);
  await openNode(page, "1.2");
  await page.getByLabel("사람 조언").fill("기간 확인");
  await page.getByRole("button", { name: "의견 등록 + 계속 신호" }).click();

  await expect(page.getByText(/신호 실패/)).toBeVisible({ timeout: 20000 });
  await expect(
    page.getByText("신호 대신 이 문구를 OpenCode에 붙여넣으세요."),
  ).toBeVisible();
  await expect(page.locator("pre", { hasText: "pf_start 금지" })).toBeVisible();

  await expectNoCspViolation(page);
});

test("(e) 실행: 승인 대기 → 화면 승인 → done / 다른 실행 취소 → 재실행 활성", async ({
  page,
}) => {
  h = await setup({ fakeMode: "ok" });
  const ext = await seedExternalProcedure(h);
  const slow = await seedSlowProcedure(h);

  await visitRunTab(page);
  const panel = runPanel(page);

  // 1) external 절차서: 실행하면 승인 대기에서 멈춘다.
  await panel.getByLabel("절차서").selectOption(ext);
  await panel.getByRole("button", { name: "실행", exact: true }).click();
  await expect(panel.getByText(/승인 대기: 노드 1\.1/)).toBeVisible({
    timeout: 30000,
  });

  // 화면에서 승인 → 러너 재개 → done + 노드 1.1 pass
  await panel.getByRole("button", { name: "승인 화면 열기" }).click();
  await expect(
    panel.getByRole("heading", { name: "승인 — 노드 1.1" }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "승인", exact: true }).click();
  await expect(panel.getByText(/상태 done/)).toBeVisible({ timeout: 60000 });
  await expect(
    panel.locator("tr").filter({ hasText: "1.1" }),
  ).toContainText("pass");

  // 2) 다른 실행(slow): 실행 중 취소 → 재실행 버튼이 활성화된다.
  await panel.getByLabel("절차서").selectOption(slow);
  await panel.getByRole("button", { name: "실행", exact: true }).click();
  await expect(panel.getByRole("button", { name: "취소" })).toBeVisible({
    timeout: 30000,
  });
  await panel.getByRole("button", { name: "취소" }).click();
  await expect(panel.getByRole("button", { name: "재실행" })).toBeVisible({
    timeout: 30000,
  });
  await expect(panel.getByRole("button", { name: "재실행" })).toBeEnabled();

  await expectNoCspViolation(page);
});

test("(d) 버전 미확인: 전송 없이 degraded + C 복사 문구", async ({ page }) => {
  h = await setup({ fakeMode: "unknown-version" });
  const sid = await seedTwoLeaves(h);
  pair(h, OC_SID, sid);

  await openSession(page, sid);
  await openNode(page, "1.2");
  await page.getByLabel("사람 조언").fill("기간 확인");
  await page.getByRole("button", { name: "의견 등록 + 계속 신호" }).click();

  await expect(page.getByText(/신호 실패/)).toBeVisible({ timeout: 20000 });
  await expect(page.getByText(/미확인 버전/)).toBeVisible();
  await expect(page.locator("pre", { hasText: "pf_start 금지" })).toBeVisible();
  // 모델 호출은 보내지 않았다 (default-deny)
  expect(h.fake.requests.some((r) => r.startsWith("POST /session/"))).toBe(false);

  await expectNoCspViolation(page);
});
