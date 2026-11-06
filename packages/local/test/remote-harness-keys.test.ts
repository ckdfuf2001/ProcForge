import { describe, it, expect } from "vitest";
import { WireMethods } from "@proof/shared/wire.js";
import { deferredRemoteClientKeys } from "./client-mode.js";
import { useTmpCleanup } from "./tmp-hooks.js";

useTmpCleanup();

// M10-3-prep: wire 메서드 추가 시 하네스(deferredRemoteClient) 갱신 누락 방지.
// M10-why-fix CI 실패(`pfEditWhy is not a function`) 재발 방지.
describe("remote harness keys", () => {
  it("deferred 프록시 키 집합 = WireMethods 키 집합", () => {
    expect(new Set(deferredRemoteClientKeys())).toEqual(
      new Set(Object.keys(WireMethods)),
    );
  });
});
