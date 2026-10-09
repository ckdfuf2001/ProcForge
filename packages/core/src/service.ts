import { randomUUID } from "node:crypto";
import {
  computeNodeHash,
  ConstraintSchema,
  type Constraint,
  type Node,
  type Session,
} from "@procforge/shared/schema.js";
import type {
  BlockedEntry,
  BlockedReason,
  CoreClient,
  EvaluateFn,
  PfAdviseInput,
  PfAdviseOutput,
  PfNextOutput,
  PfReportInput,
  PfReportOutput,
  PfResolveInput,
  PfResolveOutput,
  PfStartInput,
  PfStartOutput,
} from "@procforge/shared/core-client.js";
import { createMemoryStore } from "./store.js";
import type { Store } from "@procforge/shared/store.js";
import { defaultEvaluate } from "./evaluate.js";
import { adviceToConstraints, suggestsNumericRef } from "./advice.js";
import { compareNodeIds } from "@procforge/shared/ids.js";

function newAttemptId(): string {
  return randomUUID();
}

function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

import { checkUnknownKeys, similarKey } from "@procforge/shared/args-schema.js";
export { similarKey };

/**
 * 재시도 경계 통일 (M1.5-6): 총 시도 횟수 = maxRetries + 1.
 * 실패 보고(pfReport)와 수동 재시도(pfResolve retry) 두 경로가 이 함수만 사용.
 * retries는 누적 실패 횟수. retries > maxRetries 이면 needs_human.
 */
export function consumeRetry(
  n: Node,
  limits: Session["limits"],
): { status: "probing" | "needs_human"; retries: number } {
  const retries = n.retries + 1;
  if (retries > limits.maxRetries) return { status: "needs_human", retries };
  return { status: "probing", retries };
}

/**
 * dependsOn 충족 조건 (M1.5-5, M3.3-6 shared 공용).
 */
import { isResolved } from "@procforge/shared/deps.js";
export { isResolved };
import { effectiveDeps, expandDepLeafs, hasCycle, hasLineageDep } from "@procforge/shared/deps.js";

/**
 * 첫 pass 결과 형태 기반 auto constraint 생성 (M1.5-2).
 * file_exists(artifacts) + json_path_exists(result 최상위 키). 최대 10개.
 */
export function autoConstraints(
  resultJson: unknown,
  artifacts: string[],
): Constraint[] {
  const out: Constraint[] = [];
  let i = 0;
  const id = () => `auto-${i++}`;
  for (const a of artifacts) {
    if (out.length >= 10) break;
    out.push({ id: id(), kind: "file_exists", spec: { path: a }, source: "auto", note: "auto: first-pass shape" });
  }
  if (out.length < 10 && resultJson !== null && typeof resultJson === "object" && !Array.isArray(resultJson)) {
    for (const k of Object.keys(resultJson as Record<string, unknown>)) {
      if (out.length >= 10) break;
      if (!/^[A-Za-z0-9_.-]+$/.test(k)) continue;
      out.push({
        id: id(),
        kind: "json_path_exists",
        spec: { path: k },
        source: "auto",
        note: "auto: first-pass shape",
      });
    }
  }
  return out;
}

/**
 * 교착 판정 순수 함수 (M3.4.3-1, M3.4.4-2, 테스트용 export).
 * waitingOn 각 항목을 펼친 leaf까지 내려가 failed/needs_human/빈 split 원인을 탐색.
 * 원인이 하나도 없는 stuck 노드는 자신을 needs_human 승격 대상으로 보고 (dep_pending).
 */
export function computeDeadlock(
  stuck: Node[],
  byId: Map<string, Node>,
): { blocked: BlockedEntry[]; causes: string[] } {
  const blocked: BlockedEntry[] = [];
  const causes = new Map<string, BlockedReason>();
  const unresolved = (d: string): boolean => {
    const t = byId.get(d);
    return !t || !isResolved(t, byId);
  };
  for (const n of stuck) {
    // M3.4.4-1: 원시 미해소 + 실효 미해소 합집합
    const waitingOn = [...new Set([...n.dependsOn.filter(unresolved), ...effectiveDeps(n, byId).filter(unresolved)])];
    let reason: BlockedReason = "dep_pending";
    for (const d of waitingOn) {
      const dep = byId.get(d);
      if (!dep) {
        reason = "dep_missing";
        continue;
      }
      const leaves = expandDepLeafs(d, byId);
      if (dep.status === "split" && leaves.length === 0) {
        reason = "dep_empty_split";
        causes.set(d, reason);
        continue;
      }
      for (const leaf of leaves) {
        const t = byId.get(leaf);
        if (!t) {
          reason = "dep_missing";
          continue;
        }
        if (t.status === "needs_human") causes.set(leaf, "dep_pending");
        const last = t.attempts[t.attempts.length - 1];
        if (last?.verdict === "fail") {
          reason = "dep_failed";
          causes.set(leaf, reason);
        }
      }
    }
    if (waitingOn.length > 0) {
      // 원인 0개(원시·펼친 어느 쪽에도 원인이 없음) → 자신을 승격 (dep_pending)
      const related = new Set([...waitingOn, ...waitingOn.flatMap((d) => expandDepLeafs(d, byId))]);
      if (![...causes.keys()].some((c) => related.has(c))) {
        causes.set(n.id, "dep_pending");
      }
      blocked.push({ nodeId: n.id, waitingOn, reason });
    }
  }
  return { blocked, causes: [...causes.keys()] };
}

export class CoreService implements CoreClient {
  constructor(
    private store: Store = createMemoryStore(),
    private evaluate: EvaluateFn = defaultEvaluate,
  ) {}

  private sess(sid: string): Session {
    const s = this.store.getSession(sid);
    if (!s) throw err("not_found", `session ${sid} not found`);
    return s;
  }

  private node(sid: string, nid: string): Node {
    const n = this.store.getNode(sid, nid);
    if (!n) throw err("not_found", `node ${nid} not found`);
    return n;
  }

  /**
   * 노드 hash 계산 (M3.4-6): 의존 입력은 expandDepLeafs 결과 leaf들의 저장 hash.
   * core stale 전파와 runner --changed가 이 값으로 일치한다.
   */
  private hashFor(sid: string, n: Node, preloaded?: Map<string, Node>): string {
    const byId = preloaded ?? this.store.getNodes(sid);
    const depHs = [...new Set(effectiveDeps(n, byId).map((id) => byId.get(id)?.hash ?? `missing:${id}`))].sort();
    return computeNodeHash({ goal: n.goal, args: n.args, constraints: n.constraints, dependsOn: depHs });
  }

  /**
   * stale 전파 일반화 (M3.4-6, M3.4.3-3, 구 §5 규칙): origin 변경 후, 펼친 의존에
   * origin을 포함하는 하류 노드의 hash를 재계산·저장. leaf는 open으로 되돌리고,
   * split은 상태를 유지한 채 자손으로 계속 (재-split 불필요).
   */
  private propagateStale(sid: string, originId: string): void {
    const queue = [originId];
    const seen = new Set<string>([originId]);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const all = this.store.getNodes(sid);
      for (const n of all.values()) {
        if (n.id === cur || seen.has(n.id)) continue;
        if (!effectiveDeps(n, all).includes(cur)) continue;
        seen.add(n.id);
        const nh = this.hashFor(sid, n);
        if (nh === n.hash) continue;
        // M3.4.3-3: split은 상태 유지(해시만 갱신). 펼친 의존 검사가 자손 leaf에
        // 직접 도달하므로 별도 하강 불필요. 재-split 불필요.
        if (n.status === "split") {
          this.store.saveNode(sid, { ...n, hash: nh });
          continue;
        }
        const reopened = n.status === "leaf" ? ("open" as const) : n.status;
        this.store.saveNode(sid, { ...n, hash: nh, status: reopened });
        queue.push(n.id);
      }
    }
  }

  async pfStart(input: PfStartInput): Promise<PfStartOutput> {
    const sid = randomUUID(); // M2.5-6: 세션 핸들은 UUID
    const limits = input.limits ?? { maxDepth: 5, maxRetries: 2, maxNodes: 50 };
    const session: Session = {
      id: sid,
      request: input.request,
      params: input.params ?? {},
      toolCatalog: input.toolCatalog,
      rootId: "1",
      limits,
      createdAt: new Date().toISOString(),
    };
    this.store.saveSession(session);
    const root: Node = {
      id: "1",
      parentId: null,
      goal: input.request,
      status: "open",
      depth: 0,
      dependsOn: [],
      children: [],
      sideEffect: "none",
      constraints: [],
      advice: [],
      attempts: [],
      retries: 0,
      hash: "",
      locked: false,
    };
    root.hash = computeNodeHash({ goal: root.goal, args: {}, constraints: [], dependsOn: [] });
    this.store.saveNode(sid, root);
    return {
      session,
      node: root,
      instruction:
        `루트 노드다. 이 작업이 툴 1회 호출로 가능한지 판단하라. 가능하면 실행 후 pf_report(selfVerdict/selfReason 필수)로 보고하고, 너무 크면 pf_split으로 분해하라. ` +
        `탐색 실행(probing)은 .procforge/sandbox/${sid}/ 작업 사본에서만 하라.`,
    };
  }

  async pfNext(sessionId: string): Promise<PfNextOutput> {
    this.sess(sessionId);
    const nodes = [...this.store.getNodes(sessionId).values()];
    if (nodes.length === 0) return { done: true };
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const ready = nodes
      .filter(
        (n) =>
          (n.status === "open" || n.status === "probing") &&
          effectiveDeps(n, byId).every((d) => {
            const dep = byId.get(d);
            return dep !== undefined && isResolved(dep, byId);
          }),
      )
      .sort((a, b) => compareNodeIds(a.id, b.id));
    if (ready.length === 0) {
      const pending = nodes.some((n) => n.status === "open" || n.status === "probing" || n.status === "needs_human");
      if (!pending) return { done: true };
      const h = nodes.filter((n) => n.status === "needs_human").sort((a, b) => compareNodeIds(a.id, b.id))[0];
      if (h) {
        return {
          done: false,
          node: h,
          instruction: `노드 ${h.id}는 사람의 조언이 필요하다. pf_advise로 조언을 등록하라.`,
        };
      }
      // M3.4.3-1 교착: ready 0 + pending + needs_human 없음
      const stuck = nodes
        .filter((n) => n.status === "open" || n.status === "probing")
        .sort((a, b) => compareNodeIds(a.id, b.id));
      const { blocked, causes } = computeDeadlock(stuck, byId);
      // 원인 노드 needs_human 승격. 승격 가능 원인이 하나도 없으면 첫 stuck 자승격.
      // (빈 split 등 승격 불가 원인만 있을 때 무한 동일 blocked 방지)
      const promoted: string[] = [];
      for (const cid of causes) {
        const c = this.node(sessionId, cid);
        if (c.status === "open" || c.status === "probing") {
          this.store.saveNode(sessionId, { ...c, status: "needs_human" });
          promoted.push(cid);
        }
      }
      if (blocked.length > 0 && promoted.length === 0 && stuck.length > 0) {
        const f = this.node(sessionId, stuck[0].id);
        if (f.status === "open" || f.status === "probing") {
          this.store.saveNode(sessionId, { ...f, status: "needs_human" });
        }
      }
      const first = stuck[0];
      const causeIds = causes.join(",");
      return {
        done: false,
        node: first,
        blocked,
        instruction:
          `교착: ${blocked.map((b) => `${b.nodeId}(${b.reason})`).join(", ")}. ` +
          `원인 노드(${causeIds || "없음"})에 pf_advise 또는 pf_reopen 하라.`,
      };
    }
    const n = ready[0];
    if (n.sideEffect === "external") {
      return {
        done: false,
        node: n,
        instruction: `노드 ${n.id}는 외부 부작용(external)이다. 실제 실행 금지. dry-run으로 수행할 계획을 pf_report 대신 pf_ask_human으로 보고하고 사람 승인을 받아라.`,
      };
    }
    return {
      done: false,
      node: n,
      instruction:
        `노드 ${n.id}(${n.goal}): 툴 1회로 가능한지 판단하라. 가능하면 sandbox(.procforge/sandbox/${sessionId}/) 사본에서 실행 후 ` +
        `pf_report(selfVerdict/selfReason 필수), 아니면 pf_split. pass여도 leaf 자동 확정 없음 — pf_confirm_leaf(tool, argSpecs) 제출이 필요하다.`,
    };
  }

  async pfReport(input: PfReportInput): Promise<PfReportOutput> {
    const s = this.sess(input.sessionId);
    const n = this.node(input.sessionId, input.nodeId);
    if (!input.selfVerdict || !input.selfReason)
      throw err("bad_request", "selfVerdict and selfReason are required");
    if (n.locked) throw err("conflict", `node ${n.id} is locked`);
    if (n.status !== "open" && n.status !== "probing")
      throw err("conflict", `node ${n.id} is not reportable (${n.status})`);

    // external 차단 (§5)
    if (n.sideEffect === "external") {
      const updated: Node = {
        ...n,
        status: "needs_human",
        attempts: [
          ...n.attempts,
          {
            id: input.attemptId ?? newAttemptId(),
            at: new Date().toISOString(),
            tool: input.tool,
            args: input.args,
            resultSummary: "[blocked] external dry-run required",
            artifacts: [],
            verdict: "fail",
            failedConstraints: [],
          },
        ],
      };
      this.store.saveNode(s.id, updated);
      return {
        verdict: "fail",
        failedConstraints: [],
        instruction: `외부 부작용 노드는 실제 실행 금지. dry-run 계획을 세워 pf_ask_human으로 사람 승인을 요청하라.`,
      };
    }

    // catalog 확인
    const cat = s.toolCatalog.find((t) => t.server === input.tool.server && t.name === input.tool.name);
    if (!cat) throw err("bad_request", `unknown tool ${input.tool.server}/${input.tool.name}`);

    // llm_rubric 사유 확인 (M1.5-3)
    const rubricIds = n.constraints.filter((c) => c.kind === "llm_rubric").map((c) => c.id);
    const missingReasons = rubricIds.filter((id) => !input.rubricReasons?.[id]);
    const attemptBase = {
      id: input.attemptId ?? newAttemptId(),
      at: new Date().toISOString(),
      tool: input.tool,
      args: input.args,
      resultSummary: input.resultSummary,
      artifacts: input.artifacts ?? [],
      ...(input.rubricReasons ? { rubricReasons: input.rubricReasons } : {}),
    };
    if (missingReasons.length > 0) {
      // M1.5-3: 사유 없으면 needs_human (재시도 차감 없음 — 프로토콜 오류扱い)
      const next: Node = {
        ...n,
        status: "needs_human",
        attempts: [...n.attempts, { ...attemptBase, verdict: "fail" as const, failedConstraints: missingReasons }],
      };
      this.store.saveNode(s.id, next);
      return {
        verdict: "fail",
        failedConstraints: missingReasons,
        unverified: rubricIds,
        instruction: `llm_rubric 판정 사유 누락(${missingReasons.join(",")}). needs_human. pf_advise로 조언을 보충하거나 pf_retry 후 rubricReasons에 id별 판정 사유를 채워 다시 pf_report하라.`,
      };
    }

    // verdict 계산 (M1.5-2): constraints가 비었으면 selfVerdict 사용
    const artifactsMap: Record<string, string> = { ...(input.artifactContents ?? {}) };
    let verdict: "pass" | "fail";
    let failedConstraints: string[];
    let unverified: string[] | undefined;
    if (n.constraints.length === 0) {
      verdict = input.selfVerdict;
      failedConstraints = verdict === "pass" ? [] : ["self"];
    } else {
      const r = this.evaluate(n.constraints, {
        resultSummary: input.resultSummary,
        resultJson: input.resultJson,
        artifacts: artifactsMap,
      });
      unverified = r.unverified;
      failedConstraints = [...r.failedConstraints];
      if (input.selfVerdict === "fail" && !failedConstraints.includes("self")) failedConstraints.push("self");
      verdict = r.verdict === "pass" && input.selfVerdict === "pass" ? "pass" : "fail";
    }

    if (verdict === "pass") {
      // M1.5-1: pass여도 leaf 자동 확정 없음. probing 유지 + resolve 요구.
      // 첫 pass + constraints 비어 있으면 결과 형태 기반 auto constraint 부착.
      let constraints = n.constraints;
      if (n.constraints.length === 0) {
        const auto = autoConstraints(input.resultJson, input.artifacts ?? []);
        if (auto.length > 0) constraints = [...n.constraints, ...auto];
      }
      const next: Node = {
        ...n,
        status: "probing",
        constraints,
        attempts: [...n.attempts, { ...attemptBase, verdict: "pass" as const, failedConstraints: [] }],
      };
      next.hash = this.hashFor(s.id, next);
      this.store.saveNode(s.id, next);
      if (next.hash !== n.hash) this.propagateStale(s.id, n.id);
      const autoNote = constraints.length > n.constraints.length ? ` 결과 형태 기반 auto constraint ${constraints.length - n.constraints.length}개 부착.` : "";
      return {
        verdict,
        failedConstraints: [],
        unverified,
        instruction:
          `통과. 그러나 leaf 자동 확정은 하지 않는다.${autoNote} pf_confirm_leaf(tool, argSpecs)로 확정 신청하라. ` +
          `argSpecs는 마지막 실행 인자 키를 모두 분류(fixed/var/generated)해야 하며 누락 시 bad_request.`,
      };
    }
    // fail → 재시도 경계 (M1.5-6)
    const { status, retries } = consumeRetry(n, s.limits);
    const next: Node = {
      ...n,
      status,
      retries,
      attempts: [...n.attempts, { ...attemptBase, verdict: "fail" as const, failedConstraints }],
    };
    this.store.saveNode(s.id, next);
    return {
      verdict,
      failedConstraints,
      unverified,
      instruction:
        status === "needs_human"
          ? `실패(재시도 소진: 총 ${n.attempts.length + 1}회). needs_human. 사유: ${input.selfReason}. pf_advise로 조언을 받거나 pf_split으로 분해하라.`
          : `실패(재시도 ${retries}/${s.limits.maxRetries}). 사유: ${input.selfReason}. 반영해 다시 실행 후 pf_report하라.`,
    };
  }

  async pfResolve(input: PfResolveInput): Promise<PfResolveOutput> {
    const s = this.sess(input.sessionId);
    const n = this.node(input.sessionId, input.nodeId);

    switch (input.decision) {
      case "ask_human": {
        if (input.plan) {
          // dry-run 계획 저장 (실행 아님, verdict 없음). 승인 대기.
          const next: Node = {
            ...n,
            status: "needs_human",
            approval: undefined,
            attempts: [
              ...n.attempts,
              {
                id: newAttemptId(),
                at: new Date().toISOString(),
                tool: input.plan.tool,
                args: input.plan.args,
                resultSummary: `[dry-run] ${input.note ?? ""}`.trim(),
                artifacts: [],
                failedConstraints: [],
              },
            ],
          };
          this.store.saveNode(s.id, next);
          return { node: next, instruction: `dry-run 계획을 저장했다. pf_approve로 승인/거부를 받아라.` };
        }
        const next = { ...n, status: "needs_human" as const };
        this.store.saveNode(s.id, next);
        return { node: next, instruction: `노드 ${n.id}를 needs_human으로 전환했다. pf_advise를 기다려라.` };
      }
      case "retry": {
        if (n.locked) throw err("conflict", "locked");
        const { status, retries } = consumeRetry(n, s.limits);
        const next = { ...n, status, retries };
        this.store.saveNode(s.id, next);
        return {
          node: next,
          instruction: status === "needs_human" ? "재시도 한도 초과로 needs_human." : `재시도 ${retries}/${s.limits.maxRetries}. 실행 후 pf_report.`,
        };
      }
      case "split": {
        if (n.locked) throw err("conflict", `locked node ${n.id} cannot be split`);
        const all = [...this.store.getNodes(s.id).values()];
        if (all.some((x) => x.locked && x.id !== n.id && x.id.startsWith(n.id + ".")))
          throw err("conflict", "ancestor of locked node");
        if (!input.children || input.children.length === 0) throw err("bad_request", "split requires children");
        if (n.depth + 1 > s.limits.maxDepth) {
          const next = { ...n, status: "needs_human" as const };
          this.store.saveNode(s.id, next);
          return { node: next, instruction: `분해 깊이가 maxDepth(${s.limits.maxDepth})를 초과해 needs_human으로 전환했다.` };
        }
        if (all.length + input.children.length > s.limits.maxNodes) throw err("bad_request", "maxNodes exceeded");
        // M3.4.4-3: 자식 dependsOn은 기존 노드 또는 같은 요청의 형제만 허용
        {
          const siblingIds = new Set(input.children.map((_, i) => `${n.id}.${i + 1}`));
          const existing = new Set(all.map((x) => x.id));
          for (const c of input.children) {
            for (const d of c.dependsOn ?? []) {
              if (!existing.has(d) && !siblingIds.has(d)) {
                throw err("bad_request", `dep_missing: unknown dependsOn ${d}. 기존 노드 또는 형제만 지정하라.`);
              }
            }
          }
        }
        // M3.4.3-2: 펼친 그래프 기준 순환이면 분해 거부 (저장 전)
        {
          const tentative = new Map(all.map((x) => [x.id, { ...x } as Node]));
          input.children.forEach((c, i) => {
            const id = `${n.id}.${i + 1}`;
            tentative.set(id, { id, parentId: n.id, dependsOn: c.dependsOn ?? [], children: [], status: "open" } as unknown as Node);
          });
          const parentAsSplit = { ...n, status: "split" as const, children: input.children.map((_, i) => `${n.id}.${i + 1}`) };
          tentative.set(n.id, parentAsSplit);
          if (hasCycle([...tentative.values()])) throw err("bad_request", "split creates dependency cycle");
          for (const c of input.children.map((_, i) => `${n.id}.${i + 1}`)) {
            if (hasLineageDep(tentative.get(c)!, tentative)) throw err("bad_request", "split creates dependency cycle (lineage)");
          }
        }
        const created: Node[] = input.children.map((c, i) => {
          const id = `${n.id}.${i + 1}`;
          const child: Node = {
            id,
            parentId: n.id,
            goal: c.goal,
            status: "open",
            depth: n.depth + 1,
            dependsOn: c.dependsOn ?? [],
            children: [],
            sideEffect: c.sideEffect ?? "none",
            constraints: [],
            advice: [],
            attempts: [],
            retries: 0,
            hash: "",
            locked: false,
          };
          child.hash = "";
          return child;
        });
        // 해시 계산 후 저장 (빈 해시를 저장하지 않음 — FileStore 파싱 때문)
        const base = this.store.getNodes(s.id);
        for (const c of created) base.set(c.id, c);
        const withHashes = created.map((c) => ({ ...c, hash: this.hashFor(s.id, c, base) }));
        for (const h of withHashes) this.store.saveNode(s.id, h);
        const next: Node = { ...n, status: "split", children: withHashes.map((c) => c.id) };
        next.hash = this.hashFor(s.id, next);
        this.store.saveNode(s.id, next);
        this.propagateStale(s.id, n.id);
        return { node: next, created: withHashes, instruction: `분해 완료. 자식 ${withHashes.length}개를 순서대로 pf_next로 처리하라.` };
      }
      case "leaf": {
        // M1.5-1: leaf 확정은 여기서만. pass여도 report에서 자동 확정 없음.
        if (n.locked) throw err("conflict", `node ${n.id} is locked`);
        if (n.status !== "probing" && n.status !== "open") throw err("conflict", `node ${n.id} is not resolvable (${n.status})`);
        if (!input.tool) throw err("bad_request", "leaf requires tool");
        const cat = s.toolCatalog.find((t) => t.server === input.tool!.server && t.name === input.tool!.name);
        if (!cat) throw err("bad_request", "unknown tool");
        const last = n.attempts[n.attempts.length - 1];
        // M2.6-4: external은 승인된 dry-run 계획으로만 확정 (실행 없음)
        const isApprovedExternalPlan =
          n.sideEffect === "external" && n.approval !== undefined && last !== undefined && last.verdict === undefined;
        if (!isApprovedExternalPlan) {
          if (!last || last.verdict !== "pass") throw err("conflict", "leaf requires passing attempt. report first.");
        }
        if (last!.tool.server !== input.tool.server || last!.tool.name !== input.tool.name)
          throw err("bad_request", `leaf tool must match last attempt (${last!.tool.server}/${last!.tool.name})`);
        if (!input.argSpecs) throw err("bad_request", "leaf requires argSpecs");
        const missing = Object.keys(last.args).filter((k) => !(k in input.argSpecs!));
        if (missing.length > 0) throw err("bad_request", `argSpecs missing: ${missing.join(",")}`);
        // M3.4.3-4: additionalProperties:false 스키마는 등록 외 키 거부 (공용 검사)
        const { unknownKeys, suggestions } = checkUnknownKeys(Object.keys(input.argSpecs), cat.inputSchema);
        if (unknownKeys.length > 0) {
          const hints = unknownKeys.map((k) =>
            suggestions[k]?.length ? `${k} (유사: ${suggestions[k].join(", ")})` : k,
          );
          throw err("bad_args", `argSpecs unknown: ${hints.join("; ")}. 등록된 인자만 사용하라.`);
        }
        const warnings: string[] = [];
        for (const [k, spec] of Object.entries(input.argSpecs)) {
          if (spec.kind === "fixed") {
            const v = (spec as { value: unknown }).value;
            if (typeof v === "string" && Object.values(s.params).includes(v))
              warnings.push(`arg ${k} 값 "${v}"이 params와 동일 — var(${"${params.*"}) 후보`);
          }
        }
        const next: Node = {
          ...n,
          status: "leaf",
          tool: { server: input.tool.server, name: input.tool.name, schemaHash: cat.schemaHash },
          args: input.argSpecs,
          golden: { fixtures: [...last!.artifacts], output: last!.resultSummary, attemptId: last!.id, ignore: input.goldenIgnore ?? [] },
        };
        if (input.sideEffect) next.sideEffect = input.sideEffect;
        next.hash = this.hashFor(s.id, next);
        this.store.saveNode(s.id, next);
        this.propagateStale(s.id, n.id);
        return {
          node: next,
          instruction: warnings.length > 0 ? `leaf 확정. 경고: ${warnings.join("; ")}` : `leaf 확정. pf_next로 계속하라.`,
        };
      }
    }
  }

  async pfAdvise(
    sessionId: string,
    nodeId: string,
    text: string,
    opts: NonNullable<PfAdviseInput["opts"]> = {},
  ): Promise<PfAdviseOutput> {
    const s = this.sess(sessionId);
    const n = this.node(sessionId, nodeId);
    let constraints: Constraint[];
    let rejected: { proposal: unknown; reason: string }[] = [];
    let suggestNote = "";
    if (opts.proposedConstraints && opts.proposedConstraints.length > 0) {
      // M4: 호스트 제안 → 최신 fixture로 평가해 채택/거부
      const adopted: Constraint[] = [];
      const fx = opts.fixtureContents ?? {};
      const last = n.attempts[n.attempts.length - 1];
      let resultJson: unknown;
      for (const content of Object.values(fx)) {
        try {
          resultJson = JSON.parse(content);
          break;
        } catch {
          // 텍스트 fixture는 건너뜀
        }
      }
      for (const p of opts.proposedConstraints) {
        const parsed = ConstraintSchema.safeParse(p);
        if (!parsed.success) {
          rejected.push({ proposal: p, reason: `형식 오류: ${parsed.error.issues[0]?.message ?? "invalid"}` });
          continue;
        }
        const c = parsed.data;
        if (c.kind === "llm_rubric") {
          rejected.push({ proposal: p, reason: "llm_rubric은 제안 불가 (자동 판정 불가)" });
          continue;
        }
        try {
          const r = this.evaluate([c], {
            resultSummary: last?.resultSummary,
            resultJson,
            artifacts: fx,
          });
          if (r.unverified && r.unverified.length > 0) {
            rejected.push({ proposal: p, reason: "판정 불가 (runner 위임 항목 포함)" });
            continue;
          }
          adopted.push({ ...c, source: "human", note: c.note ?? text });
        } catch (e) {
          rejected.push({ proposal: p, reason: e instanceof Error ? e.message : String(e) });
        }
      }
      if (adopted.length === 0) {
        adopted.push(...adviceToConstraints(text));
      }
      constraints = adopted;
    } else {
      constraints = adviceToConstraints(text);
      if (suggestsNumericRef(text)) {
        suggestNote =
          ` 금액 비교가 필요하면 numeric_match(expectedRef=$<노드>.output.<필드>, tolerance)를 ` +
          `proposedConstraints로 제안하라 (runner에서 판정).`;
      }
    }
    const next: Node = {
      ...n,
      constraints: [...n.constraints, ...constraints],
      advice: [...n.advice, { at: new Date().toISOString(), text }],
      status: n.status === "needs_human" ? "open" : n.status,
    };
    const oldHash = n.hash;
    next.hash = this.hashFor(s.id, next);
    this.store.saveNode(s.id, next);
    if (oldHash !== next.hash) this.propagateStale(s.id, nodeId);
    const node = this.node(sessionId, nodeId);
    return { constraints, rejected, node, ...(suggestNote ? { note: suggestNote } : {}) };
  }

  async pfTree(sessionId: string): Promise<{ nodes: Node[]; session: Session }> {
    const s = this.sess(sessionId);
    return { session: s, nodes: [...this.store.getNodes(sessionId).values()].sort((a, b) => compareNodeIds(a.id, b.id)) };
  }

  async pfApprove(sessionId: string, nodeId: string, approved: boolean, note?: string): Promise<Node> {
    const s = this.sess(sessionId);
    const n = this.node(sessionId, nodeId);
    if (n.locked) throw err("conflict", `node ${n.id} is locked`);
    if (n.status !== "needs_human") throw err("conflict", `node ${n.id} has no pending approval (${n.status})`);
    if (approved) {
      const last = n.attempts[n.attempts.length - 1];
      if (!last || last.verdict !== undefined)
        throw err("conflict", `node ${n.id} has no dry-run plan to approve. submit plan via ask_human first.`);
      const next: Node = { ...n, status: "probing", approval: { at: new Date().toISOString(), note } };
      this.store.saveNode(s.id, next);
      return next;
    }
    const next: Node = {
      ...n,
      status: "open",
      approval: undefined,
      advice: [...n.advice, { at: new Date().toISOString(), text: note ?? "plan rejected" }],
    };
    this.store.saveNode(s.id, next);
    return next;
  }

  async pfLock(sessionId: string, nodeId: string): Promise<Node> {
    const n = this.node(sessionId, nodeId);
    const next = { ...n, locked: true };
    this.store.saveNode(sessionId, next);
    return next;
  }

  async pfReopen(sessionId: string, nodeId: string, _reason: string): Promise<Node> {
    const n = this.node(sessionId, nodeId);
    const next = { ...n, locked: false, status: "open" as const };
    this.store.saveNode(sessionId, next);
    return next;
  }
}

export function createInProcessClient(evaluate: EvaluateFn = defaultEvaluate): CoreClient {
  const svc = new CoreService(createMemoryStore(), evaluate);
  return svc;
}
