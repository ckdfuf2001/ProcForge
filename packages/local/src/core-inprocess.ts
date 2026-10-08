import { CoreService } from "@procforge/core";
import type { CoreClient } from "@procforge/shared/core-client.js";
import { checkerEvaluate } from "./checker.js";
import { FileStore } from "./filestore.js";

// M0-6 예외 합성 루트: local에서 core를 직접 import하는 유일 허용 파일.
// M6에서 이 파일만 HTTP CoreClient 구현으로 교체하면 local 나머지 코드는 그대로 동작한다.
export function createLocalStack(procforgeDir: string): { client: CoreClient; store: FileStore } {
  const store = new FileStore(procforgeDir);
  const client: CoreClient = new CoreService(store, checkerEvaluate);
  return { client, store };
}

export function createLocalClient(procforgeDir: string): CoreClient {
  return createLocalStack(procforgeDir).client;
}
