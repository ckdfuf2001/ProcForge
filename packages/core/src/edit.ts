import {
  ConstraintSchema,
  type Constraint,
  type Node,
  type ArgSpec,
  type ToolCatalogEntry,
} from "@procforge/shared/schema.js";
import { checkFixedAgainstInputSchema } from "@procforge/shared/validator.js";

// M7-ui4-f: 편집 = **순수 함수**. 검증과 적용을 한 곳에 둔다.
// previewEdit(읽기 미리보기)와 pfEditNode(실제 저장)이 같은 함수를 쓰므로
// "미리보기에서 N개 stale"과 "저장 후 N개 stale"이 어긋날 수 없다.
// 저장소·시계·해시를 몰라도 되는 함수다 (부수효과 없음).

export const GOAL_MAX_LEN = 4096;

/** 노드 편집 변경 (미리보기·실제 편집 공용) */
export type EditChange = {
  /** 확정 인자 수정 (argSpecs patch) */
  patch?: { set?: Record<string, ArgSpec>; remove?: string[] };
  goal?: string;
  dependsOn?: string[];
  addConstraints?: unknown[];
  removeConstraintIds?: string[];
};

export type ApplyEditResult = {
  /** 검증·적용된 새 노드 (원본은 변경하지 않는다) */
  next: Node;
  /** 실질적으로 뭐라도 바뀌었는지 (goal만=status 재오픈 포함) */
  changed: boolean;
};

type Deps = {
  /** patch 검증용. 없으면 도구 카탈로그 검증을 건너뛴다 */
  toolCatalog?: ToolCatalogEntry[];
  /** bad_request 등 core 오류를 던지는 주입 함수 (테스트는Error) */
  fail: (msg: string) => never;
};

/**
 * 노드 1개에 편집을 적용한 결과를 계산한다 (검증 포함).
 * 실패는 fail()로 알린다 — 부분 적용된 객체를 돌려주지 않는다.
 */
export function applyEdit(
  node: Node,
  change: EditChange,
  deps: Deps,
): ApplyEditResult {
  const hasPatch = change.patch !== undefined;
  const hasNodeEdit =
    change.goal !== undefined ||
    change.dependsOn !== undefined ||
    change.addConstraints !== undefined ||
    change.removeConstraintIds !== undefined;
  if (!hasPatch && !hasNodeEdit) deps.fail("변경 내용 없음.");

  let next: Node = { ...node };

  // ---- 인자 patch (인자 확정 분기) ----
  if (hasPatch) {
    if (!node.args) {
      deps.fail(
        `node ${node.id}에 확정된 인자가 없어 수정 불가. pf_confirm_leaf 먼저.`,
      );
    }
    const set = change.patch?.set ?? {};
    for (const [k, spec] of Object.entries(set)) {
      if (
        !spec ||
        (spec.kind !== "fixed" &&
          spec.kind !== "var" &&
          spec.kind !== "generated" &&
          spec.kind !== "script")
      ) {
        deps.fail(`bad patch spec: ${k}`);
      }
    }
    const remove = new Set(change.patch?.remove ?? []);
    if (Object.keys(set).length === 0 && remove.size === 0) {
      deps.fail("변경 없음 (patch.set/remove 중 하나 필요).");
    }
    for (const k of remove) {
      if (!node.args[k]) deps.fail(`unknown arg: ${k}`);
    }
    const merged: Record<string, ArgSpec> = {};
    for (const [k, spec] of Object.entries(node.args ?? {})) {
      if (!remove.has(k)) merged[k] = spec;
    }
    Object.assign(merged, set);
    const cat = deps.toolCatalog?.find(
      (t) => t.server === node.tool?.server && t.name === node.tool?.name,
    );
    if (deps.toolCatalog && (!node.tool || !cat)) {
      deps.fail(
        `node ${node.id}의 도구를 카탈로그에서 찾을 수 없어 검증 불가.`,
      );
    }
    if (cat) {
      const problem = checkFixedAgainstInputSchema(merged, cat.inputSchema);
      if (problem) deps.fail(problem);
    }
    next = { ...next, args: merged, suggestedArgs: merged };
  }

  // ---- 노드 편집 (대상·조건·의존) ----
  let constraints: Constraint[] = node.constraints;
  if (change.removeConstraintIds !== undefined) {
    const rm = change.removeConstraintIds;
    const missing = rm.filter((id) => !constraints.some((c) => c.id === id));
    if (missing.length > 0) {
      deps.fail(`unknown constraint: ${missing.join(",")}`);
    }
    constraints = constraints.filter((c) => !rm.includes(c.id));
  }
  if (change.addConstraints !== undefined) {
    const parsed: Constraint[] = [];
    for (const p of change.addConstraints) {
      const r = ConstraintSchema.safeParse(p);
      if (!r.success) {
        deps.fail(`bad constraint: ${r.error.issues[0]?.message ?? "invalid"}`);
      }
      parsed.push(r.data);
    }
    // 중복은 조용히 버리지 않는다 — 미리보기가 "적용됨"이라고 말한 뒤
    // 저장은 조용히 무시하는 일이 생기면 안 된다.
    const dup = parsed.filter((a) => constraints.some((c) => c.id === a.id));
    if (dup.length > 0) {
      deps.fail(`duplicate constraint: ${dup.map((d) => d.id).join(",")}`);
    }
    constraints = [...constraints, ...parsed];
  }
  if (constraints !== node.constraints) next = { ...next, constraints };

  if (change.goal !== undefined) {
    const g = change.goal;
    if (g.length === 0 || g.trim() === "") deps.fail("goal이 비어 있음.");
    if (g.length > GOAL_MAX_LEN) {
      deps.fail(`goal 상한 초과 (${g.length} > ${GOAL_MAX_LEN}).`);
    }
    if (g !== node.goal) next = { ...next, goal: g };
  }
  if (change.dependsOn !== undefined) {
    if (change.dependsOn.length === 0) {
      deps.fail("dependsOn 비우기 금지 (pf_reopen 사용).");
    }
    next = { ...next, dependsOn: [...change.dependsOn] };
  }

  // ---- 상태 전이 (pfEditNode와 동일) ----
  const goalChanged = next.goal !== node.goal;
  const reopened = goalChanged && node.status === "leaf" ? "open" : node.status;
  const status = node.status === "needs_human" ? "open" : reopened;
  if (status !== node.status) next = { ...next, status };

  const changed =
    next.goal !== node.goal ||
    next.constraints !== node.constraints ||
    next.args !== node.args ||
    next.dependsOn !== node.dependsOn ||
    next.status !== node.status;
  return { next, changed };
}

/** core용 fail 구현 (pfError bad_request) */
export function badRequest(msg: string): never {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = new Error(msg) as any;
  e.code = "bad_request";
  throw e;
}