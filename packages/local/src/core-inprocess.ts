import { CoreService } from "@procforge/core";
import type { CoreClient } from "@procforge/shared/core-client.js";
import { readEnvPair } from "@procforge/shared/env-compat.js";
import { checkerEvaluate } from "./checker.js";
import { FileStore } from "./filestore.js";
import { createRemoteCoreClient } from "./remote-client.js";

// M0-6 예외 합성 루트: local에서 core를 직접 import하는 유일 허용 파일.
// M6-3: PROOF_CORE_URL(대체 PROCFORGE_CORE_URL)이 있으면 HTTP CoreClient(remote), 기본 inprocess.
// remote 선택 시에도 FileStore(로컬 파일 상태)는 그대로 반환한다.
// M9-1-1: CORE_API_KEY는 보안 변수라 두 이름 값이 다르면 기동 오류로 종료한다.
export function createLocalStack(procforgeDir: string, opts: { sessionTtlMs?: number } = {}): { client: CoreClient; store: FileStore } {
  const store = new FileStore(procforgeDir);
  const env = process.env as Record<string, string | undefined>;
  const remoteUrl = readEnvPair(env, "PROOF_CORE_URL", "PROCFORGE_CORE_URL");
  const client: CoreClient = remoteUrl
    ? createRemoteCoreClient({ baseUrl: remoteUrl, apiKey: readEnvPair(env, "PROOF_CORE_API_KEY", "PROCFORGE_CORE_API_KEY", { secret: true, onConflict: "fail" }) ?? "" })
    : new CoreService(store, checkerEvaluate, { sessionTtlMs: opts.sessionTtlMs });
  return { client, store };
}

export function createLocalClient(procforgeDir: string): CoreClient {
  return createLocalStack(procforgeDir).client;
}
