import { CoreService } from "@procforge/core";
import type { CoreClient } from "@procforge/shared/core-client.js";
import { checkerEvaluate } from "./checker.js";
import { FileStore } from "./filestore.js";
import { createRemoteCoreClient } from "./remote-client.js";

// M0-6 예외 합성 루트: local에서 core를 직접 import하는 유일 허용 파일.
// M6-3: PROCFORGE_CORE_URL이 있으면 HTTP CoreClient(remote), 기본 inprocess.
// remote 선택 시에도 FileStore(로컬 파일 상태)는 그대로 반환한다.
export function createLocalStack(procforgeDir: string, opts: { sessionTtlMs?: number } = {}): { client: CoreClient; store: FileStore } {
  const store = new FileStore(procforgeDir);
  const remoteUrl = process.env.PROCFORGE_CORE_URL;
  const client: CoreClient = remoteUrl
    ? createRemoteCoreClient({ baseUrl: remoteUrl, apiKey: process.env.PROCFORGE_CORE_API_KEY ?? "" })
    : new CoreService(store, checkerEvaluate, { sessionTtlMs: opts.sessionTtlMs });
  return { client, store };
}

export function createLocalClient(procforgeDir: string): CoreClient {
  return createLocalStack(procforgeDir).client;
}
