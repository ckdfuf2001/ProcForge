import { createLocalStack } from "../src/core-inprocess.js";
import type { FileStore } from "../src/filestore.js";
import { createLoopbackClient } from "@procforge/shared";
import type { CoreClient } from "@procforge/shared/core-client.js";

// 테스트 클라이언트 모드 (M4.2-4-4).
// PROCFORGE_CLIENT=inprocess (기본) | loopback (JSON 왕복+zod 검증).
// store는 파일 assertions용으로 그대로 반환한다.

export function clientMode(): "inprocess" | "loopback" {
  return process.env.PROCFORGE_CLIENT === "loopback" ? "loopback" : "inprocess";
}

export function wrapClient(client: CoreClient): CoreClient {
  return clientMode() === "loopback" ? createLoopbackClient(client) : client;
}

export function testStack(
  pfdir: string,
  opts: { sessionTtlMs?: number } = {},
): { client: CoreClient; store: FileStore } {
  const { client, store } = createLocalStack(pfdir, opts);
  return { client: wrapClient(client), store };
}
