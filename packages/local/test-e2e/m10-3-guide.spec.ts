import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { setup, seedTwoLeaves, type Harness } from "./harness.js";
import { buildApprovalEntry, saveApproval } from "../dist/services/approvals.js";
import { cleanRegisteredTmp } from "@proof/shared/tmp.js";

// M10-3-e2e2: M10 확인 화면 브라우저 시나리오 3개 (지시 원문).
// ① 새로고침 후 why 유지 ② 의견 → needs_reverify + 진행률 분자 감소
// ③ diff 적용(200 + 대상만 변경 + approvalReset 표시 + 재적용 409).
// workers=1 (playwright.config.ts).

test.afterAll(() => {
  cleanRegisteredTmp();
});

let h: Harness;

test.afterEach(async () => {
  await h?.close();
});

async function openSession(page: Page, sid: string): Promise<void> {
  await page.goto(`${h.ui.url}/#t=${h.ui.token}`);
  await expect(page).toHaveTitle("Proof");
  await expect(page.getByRole("heading", { name: "Proof" })).toBeVisible();
  await page.getByRole("button", { name: sid.slice(0, 8), exact: true }).click();
  await expect(page.getByText(/실시간:/)).toBeVisible();
}

async function openTreeTab(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "트리", exact: true }).click();
}

async function openGuideTab(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "M10 확인", exact: true }).click();
}

async function openNode(page: Page, nid: string): Promise<void> {
  await page.getByRole("button", { name: nid, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: new RegExp(`^${nid.replace(".", "\\.")} · `) }),
  ).toBeVisible();
}

test("① 새로고침 후 why 유지 (화면 확인)", async ({ page }) => {
  h = await setup({ fakeMode: "ok" });
  const sid = await seedTwoLeaves(h);

  await openSession(page, sid);
  await openTreeTab(page);
  await openNode(page, "1.1");
  await page.getByLabel("왜 수정").fill("브라우저에서 바꾼 이유");
  await page.getByRole("button", { name: "왜 저장", exact: true }).click();
  // 저장 완료 = 왜 섹션 문단에 새 문구 (textarea에도 같은 값이 들어간다).
  const whySection = page.locator('section[aria-label="왜"]');
  await expect(whySection.getByRole("paragraph").getByText("브라우저에서 바꾼 이유")).toBeVisible();

  await page.reload();
  await openSession(page, sid);
  await openTreeTab(page);
  await openNode(page, "1.1");
  await expect(
    page.locator('section[aria-label="왜"]').getByRole("paragraph").getByText("브라우저에서 바꾼 이유"),
  ).toBeVisible();
});

test("② 의견 → needs_reverify + 진행률 분자 감소", async ({ page }) => {
  h = await setup({ fakeMode: "ok" });
  const sid = await seedTwoLeaves(h);

  await openSession(page, sid);
  await openGuideTab(page);
  await expect(page.getByText("2 / 2 (100%)")).toBeVisible();

  await openTreeTab(page);
  await openNode(page, "1.1");
  await page.getByLabel("사람 조언").fill("다시 나눠야 할 것 같다");
  await page.getByRole("button", { name: "의견 등록 + 계속 신호", exact: true }).click();
  // 의견 저장 완료 (신호 성공 여부와 무관 — 저장됨 또는 신호 실패 문구; 둘 다 뜰 수 있어 first).
  await expect(
    page.getByText(/advise-and-signal 저장됨|저장은 끝났습니다/).first(),
  ).toBeVisible({ timeout: 30000 });

  await openGuideTab(page);
  await expect(page.getByText("1 / 2 (50%)")).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole("heading", { name: /남은 작업 \(/ })).toBeVisible();
  await expect(page.locator('section[aria-label="남은 작업"]').getByText("1.1")).toBeVisible();
});

test("③ diff 적용: 200 + 대상만 변경 + approvalReset + 재적용 409", async ({ page }) => {
  h = await setup({ fakeMode: "ok" });
  const sid = await seedTwoLeaves(h);

  // 승인 대상 절차서 + 항목 + 초안 (fs로 준비, 실행은 화면에서).
  const procDir = join(h.pfdir, "procedures", "memo2");
  mkdirSync(procDir, { recursive: true });
  const raw = JSON.stringify({
    format: "procforge-procedure",
    version: 1,
    name: "memo2",
    sourceSession: "s",
    createdAt: new Date(0).toISOString(),
    params: {},
    toolCatalog: [],
    nodes: [
      {
        id: "1", parentId: null, goal: "구 목표 1", depth: 0, children: [],
        tool: { server: "t", name: "sh", schemaHash: "h" },
        args: { cmd: { kind: "fixed", value: "echo hi" } },
        sideEffect: "external", dependsOn: [], constraints: [],
      },
      {
        id: "2", parentId: null, goal: "그대로 둘 목표", depth: 0, children: [],
        tool: { server: "t", name: "sh", schemaHash: "h" },
        args: { cmd: { kind: "fixed", value: "echo yo" } },
        sideEffect: "external", dependsOn: [], constraints: [],
      },
    ],
  });
  writeFileSync(join(procDir, "procedure.json"), raw);
  saveApproval(
    procDir,
    buildApprovalEntry(
      {
        id: "1", goal: "구 목표 1",
        tool: { server: "t", name: "sh" },
        args: { cmd: { kind: "fixed", value: "echo hi" } },
        constraints: [], sideEffect: "external",
      },
      [],
    ),
  );
  const hash = createHash("sha256").update(raw, "utf8").digest("hex");
  mkdirSync(join(h.pfdir, "drafts", "d9"), { recursive: true });
  writeFileSync(
    join(h.pfdir, "drafts", "d9", "draft.json"),
    JSON.stringify({
      draftId: "d9", procedure: "memo2", request: "req", sourceHash: hash, status: "ready",
      ops: [
        { op: "edit_goal", nodeId: "1", goal: "새 목표 1", reason: "다듬기" },
        { op: "edit_why", nodeId: "2", why: "이유 추가", reason: "보강" },
      ],
      diff: [], reason: "r",
    }),
  );

  await openSession(page, sid);
  await openGuideTab(page);
  await page.getByLabel("draftId").fill("d9");
  await page.getByRole("button", { name: "초안 불러오기", exact: true }).click();
  await expect(page.getByText("memo2 · ready · 2건")).toBeVisible();
  await page.getByRole("button", { name: "적용", exact: true }).click();
  // 200 + 대상 표시 + approvalReset 표시.
  await expect(page.getByText(/적용됨:/)).toBeVisible({ timeout: 30000 });
  await expect(page.getByText(/바뀐 노드: 1, 2/)).toBeVisible();
  await expect(page.getByText(/다음 실행 때 승인 필요: 1/)).toBeVisible();
  // 대상 노드만 바뀜: 메모리 패널에서 새 목표 1건 + 그대로 1건.
  await page.getByLabel("분석 검색").fill("목표");
  await page.getByRole("button", { name: "메모리 불러오기", exact: true }).click();
  await page.getByRole("button", { name: "memo2", exact: true }).click();
  const mem = page.locator('section[aria-label="불러온 메모리"]');
  await expect(mem.getByText("새 목표 1")).toBeVisible();
  await expect(mem.getByText("그대로 둘 목표")).toBeVisible();
  await expect(mem.getByText("구 목표 1")).toHaveCount(0);
  // 같은 초안으로 다시 적용하면 sourceHash 불일치 → 409 문구.
  await page.getByRole("button", { name: "적용", exact: true }).click();
  await expect(page.getByText(/절차서가 바뀜/)).toBeVisible({ timeout: 30000 });
});

test("④ 가이드 확인 후 실행 → 레인이 실제 이벤트로 바뀜", async ({ page }) => {
  h = await setup({ fakeMode: "ok" });
  const sid = await seedTwoLeaves(h);
  const procDir = join(h.pfdir, "procedures", "g-e2e");
  mkdirSync(procDir, { recursive: true });
  writeFileSync(
    join(procDir, "procedure.json"),
    JSON.stringify({
      format: "procforge-procedure",
      version: 1,
      name: "g-e2e",
      sourceSession: "11111111-1111-4111-8111-111111111111",
      createdAt: new Date(0).toISOString(),
      params: {},
      toolCatalog: [],
      tree: { rootId: "1", nodes: [] },
      nodes: [],
    }),
  );

  await openSession(page, sid);
  await openGuideTab(page);
  // 실행 전: 단계 레인 없음 (가이드 화면의 세션 레인과 무관).
  const guideRunner = page.locator('section[aria-label="순차 자동 실행"]');
  await expect(guideRunner.getByText("순차 자동 실행")).toBeVisible();
  // GuideRunner: 단계 추가 → 가이드 시작 → 확인 후 실행.
  await page.getByLabel("절차서").selectOption("g-e2e");
  await page.getByRole("button", { name: "단계 추가", exact: true }).click();
  await page.getByRole("button", { name: "가이드 시작", exact: true }).click();
  await expect(page.getByText(/1\. g-e2e · pending/)).toBeVisible();
  await page.getByRole("button", { name: "확인 후 실행", exact: true }).click();
  await expect(page.getByText(/1\. g-e2e · done/)).toBeVisible({ timeout: 60000 });
  // lane.started/finished가 실행 세션에 실제로 기록돼 단계 레인이 "종료됨"으로 바뀐다.
  const stepLane = guideRunner.locator(".step-lane-execute");
  await expect(stepLane.getByText("종료됨")).toBeVisible({ timeout: 30000 });
});
