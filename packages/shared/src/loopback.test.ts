import { describe, it, expect } from "vitest";
import { createLoopbackClient } from "./loopback.js";
import type { CoreClient } from "./core-client.js";

// M4.2-4-4: JSON 왕복 + DTO zod 검증, inner 오류는 그대로 전파.

describe("loopback client", () => {
  it("입력 검증 실패 → loopback 오류", async () => {
    const inner = { pfTree: async () => ({ nodes: [], session: {} }) } as unknown as CoreClient;
    const client = createLoopbackClient(inner);
    await expect(client.pfTree("not-a-uuid")).rejects.toThrow(/loopback pfTree input invalid/);
  });

  it("비-JSON 값(Map) → loopback 오류", async () => {
    const inner = { pfTree: async () => ({ nodes: [], session: {} }) } as unknown as CoreClient;
    const client = createLoopbackClient(inner);
    await expect(client.pfTree({ x: new Map() } as never)).rejects.toThrow(/loopback/);
  });

  it("inner 오류 객체는 그대로 전파 (동일성)", async () => {
    const sentinel = Object.assign(new Error("locked"), { code: "conflict" });
    const inner = { pfTree: async () => { throw sentinel; } } as unknown as CoreClient;
    const client = createLoopbackClient(inner);
    try {
      await client.pfTree("11111111-1111-4111-8111-111111111111");
      expect.unreachable();
    } catch (e) {
      expect(e).toBe(sentinel);
    }
  });

  it("출력 검증 실패 → loopback 오류", async () => {
    const inner = { getSession: async () => ({}) } as unknown as CoreClient;
    const client = createLoopbackClient(inner);
    await expect(client.getSession("11111111-1111-4111-8111-111111111111")).rejects.toThrow(/loopback getSession output invalid/);
  });

  it("undefined 필드는 왕복에서 제거", async () => {
    const seen: unknown[] = [];
    const inner = {
      pfUpdateCatalog: async (i: unknown) => {
        seen.push(i);
        return { revision: 1, changedNodeIds: [] };
      },
    } as unknown as CoreClient;
    const client = createLoopbackClient(inner);
    const out = await client.pfUpdateCatalog({
      sessionId: "11111111-1111-4111-8111-111111111111", entries: [], actor: undefined,
    });
    expect(out).toEqual({ revision: 1, changedNodeIds: [] });
    expect("actor" in (seen[0] as Record<string, unknown>)).toBe(false);
  });
});
