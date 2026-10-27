import { describe, it, expect } from "vitest";
import { SessionEventHub } from "../src/app/events-hub.js";

// M8-1-close2 b: 신호 감시 결과 배지 (core 이력과 무관한 push).
describe("SessionEventHub.push", () => {
  it("구독자에게 signal 이벤트를 민다 (revision 커서 불변)", async () => {
    const hub = new SessionEventHub({
      fetchEvents: async () => ({ events: [], lastRevision: 0 }),
      pollMs: 50,
    });
    const chunks: string[] = [];
    const sub = hub.subscribe("sid-1", 7, (c) => chunks.push(c), () => {});
    expect(sub.ok).toBe(true);
    hub.push("sid-1", "signal", { kind: "warn", text: "x" });
    expect(chunks.some((c) => c.includes("event: signal"))).toBe(true);
    expect(chunks.some((c) => c.includes('"kind":"warn"'))).toBe(true);
    // 다른 세션 구독자에게는 안 간다.
    const other: string[] = [];
    hub.subscribe("sid-2", 0, (c) => other.push(c), () => {});
    hub.push("sid-1", "signal", { kind: "ok" });
    expect(other.some((c) => c.includes("event: signal"))).toBe(false);
    hub.stopAll();
  });
});
