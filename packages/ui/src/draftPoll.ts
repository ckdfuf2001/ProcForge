// M10-entry-fix: 재분석 초안 폴링 (순수 함수, React 없음).
// MemoryPanel이 그대로 쓴다. 단위 테스트에서 대기·타임아웃·중단을 검증한다.

export type PollResult =
  | { done: true; status: string }
  | { done: false; reason: "timeout" | "aborted" };

export async function pollDraftStatus(
  getDraft: (draftId: string) => Promise<{ status: string }>,
  draftId: string,
  opts?: { tries?: number; intervalMs?: number; isAlive?: () => boolean },
): Promise<PollResult> {
  const tries = opts?.tries ?? 150;
  const intervalMs = opts?.intervalMs ?? 2000;
  const isAlive = opts?.isAlive ?? (() => true);
  for (let i = 0; i < tries; i++) {
    if (!isAlive()) return { done: false, reason: "aborted" };
    await new Promise((r) => setTimeout(r, intervalMs));
    if (!isAlive()) return { done: false, reason: "aborted" };
    const d = await getDraft(draftId);
    if (d.status !== "pending") return { done: true, status: d.status };
  }
  return { done: false, reason: "timeout" };
}
