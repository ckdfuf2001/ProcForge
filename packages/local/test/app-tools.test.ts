import { describe, it, expect } from "vitest";
import { TOOL_NAMES } from "../src/server.js";
import { APP_METHODS } from "../src/app/tools.js";
import { ProcForgeApp } from "../src/app/app.js";

// M4.2-4-3: TOOL_NAMES 전 항목이 APP_METHODS 매핑을 가진다 (1:1).

describe("도구↔App 1:1 매핑", () => {
  it("TOOL_NAMES == APP_METHODS 키 집합", () => {
    expect([...Object.keys(APP_METHODS)].sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("매핑된 메서드가 ProcForgeApp에 존재", () => {
    for (const [tool, method] of Object.entries(APP_METHODS)) {
      expect(
        typeof (ProcForgeApp.prototype as Record<string, unknown>)[method],
        `${tool} → ${method}`,
      ).toBe("function");
    }
  });
});
