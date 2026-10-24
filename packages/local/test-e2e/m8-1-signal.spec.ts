import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setup, seedTwoLeaves, pair, OC_SID, type Harness } from "./harness.js";

// M8-1 c: 확정 절차서에 든 leaf에 의견을 저장하려면 확인창이 뜬다.

let h: Harness;

test.afterEach(async () => {
  await h?.close();
});

async function openSession(page: Page, sid: string): Promise<void> {
  await page.goto(`${h.ui.url}/#t=${h.ui.token}`);
  await expect(page.getByRole("heading", { name: "ProcForge" })).toBeVisible();
  await page.getByRole("button", { name: sid.slice(0, 8), exact: true }).click();
  await expect(page.getByText(/실시간:/)).toBeVisible();
}

/** 세션을 확정 절차서로 묶고, 그 세션의 실행 기록이 그 절차서를 가리키게 한다. */
async function linkProcedure(sid: string, name: string): Promise<void> {
  await h.app.finalize({ sessionId: sid, name });
  const runDir = join(h.pfdir, "runs", `run-${name}`);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "state.json"),
    JSON.stringify({
      version: 1,
      runId: `run-${name}`,
      sessionId: sid,
      procedure: name,
      procedureDir: join(h.pfdir, "procedures", name),
      params: {},
      pending: [],
      done: [],
      supplied: {},
      approved: [],
      status: "done",
      updatedAt: new Date().toISOString(),
    }),
    "utf8",
  );
}

test("(c) 확정 절차서의 leaf에 의견 → 확인창: 취소하면 저장 안 함, 확인하면 저장", async ({
  page,
}) => {
  h = await setup({ fakeMode: "ok" });
  const sid = await seedTwoLeaves(h);
  pair(h, OC_SID, sid);
  await linkProcedure(sid, "m8-warn-proc");

  await openSession(page, sid);
  await page.getByRole("tab", { name: "트리" }).click();
  await page.getByRole("button", { name: "1.1", exact: true }).click();
  await expect(page.getByRole("heading", { name: /^1\.1 · / })).toBeVisible();

  // 1) 취소 → 저장 안 됨
  let message = "";
  page.once("dialog", async (d) => {
    message = d.message();
    await d.dismiss();
  });
  await page.getByLabel("사람 조언").fill("보고서 문장을 다듬어라");
  await page.getByRole("button", { name: "의견 등록 + 계속 신호" }).click();
  await expect.poll(() => message, { timeout: 10000 }).toContain("m8-warn-proc");
  expect(message).toContain("재확정 전까지 무인 실행이 exit 1로 멈춥니다");
  await new Promise((r) => setTimeout(r, 300));
  expect((await h.app.core.getNode(sid, "1.1")).status).toBe("leaf");
  expect((await h.app.core.getNode(sid, "1.1")).advice.length).toBe(0);

  // 2) 확인 → 저장되고 재검증 대기
  page.once("dialog", async (d) => {
    await d.accept();
  });
  await page.getByRole("button", { name: "의견 등록 + 계속 신호" }).click();
  await expect
    .poll(async () => (await h.app.core.getNode(sid, "1.1")).status, { timeout: 15000 })
    .toBe("needs_reverify");
});
