import { describe, it, expect } from "vitest";
import { pollDraftStatus } from "../../ui/src/draftPoll.js";

// M10-entry-fix 코드 짚음 1: 폴링 타임아웃 경고 + 언마운트 중단.
// UI 컴포넌트 대신 순수 폴링 로직을 직접 단언한다 (DOM 불필요).

describe("M10-entry pollDraftStatus", () => {
  it("준비가 되면 끝난다 (호출 횟수만큼만 폴링)", async () => {
    let n = 0;
    const r = await pollDraftStatus(
      async () => {
        n += 1;
        return { status: n < 3 ? "pending" : "ready" };
      },
      "d1",
      { tries: 10, intervalMs: 1 },
    );
    expect(r).toEqual({ done: true, status: "ready" });
    expect(n).toBe(3);
  });

  it("끝까지 pending이면 timeout + 시도 횟수 준수", async () => {
    let n = 0;
    const r = await pollDraftStatus(
      async () => {
        n += 1;
        return { status: "pending" };
      },
      "d1",
      { tries: 5, intervalMs: 1 },
    );
    expect(r).toEqual({ done: false, reason: "timeout" });
    expect(n).toBe(5);
  });

  it("언마운트되면 중단한다 (추가 호출 없음)", async () => {
    let n = 0;
    let alive = true;
    const p = pollDraftStatus(
      async () => {
        n += 1;
        return { status: "pending" };
      },
      "d1",
      {
        tries: 100,
        intervalMs: 1,
        isAlive: () => alive,
      },
    );
    await new Promise((r) => setTimeout(r, 5));
    alive = false;
    expect(await p).toEqual({ done: false, reason: "aborted" });
    const frozen = n;
    await new Promise((r) => setTimeout(r, 10));
    expect(n).toBe(frozen);
  });
});
