import { randomUUID } from "node:crypto";
import {
  computeNodeHash,
  ConstraintSchema,
  ToolCatalogEntrySchema,
  type ArgSpec,
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
  PfNextInput,
  PfNextPayload,
  PfLockInput,
  PfReopenInput,
  PfApproveInput,
  PfEditArgsInput,
  PfEditNodeInput,
  AmendAttemptArtifactsInput,
  PfStartInput,
  PfStartOutput,
  ChangeMeta,
} from "@procforge/shared/core-client.js";
import { createMemoryStore } from "./store.js";
import type { Store } from "@procforge/shared/store.js";
import { TxStore } from "./txn.js";
import { defaultEvaluate } from "./evaluate.js";
import { adviceToConstraints, suggestsNumericRef } from "./advice.js";
import { compareNodeIds } from "@procforge/shared/ids.js";

function newAttemptId(): string {
  return randomUUID();
}

function err(code: ErrorCode, message: string): ProcForgeError {
  return pfError(code, message);
}

import { checkUnknownKeys, selfAndAncestors, similarKey, varRefNodeId } from "@procforge/shared/args-schema.js";
import { checkFixedAgainstInputSchema } from "@procforge/shared/validator.js";
import { maskParamsValues, restoreParamsPlaceholders } from "@procforge/shared/normalize.js";
import { PROCEDURE_NAME_RE, type ProcedureDoc } from "@procforge/shared/procedure.js";
import { validateTree } from "@procforge/shared/validator.js";
import { combineHashes } from "@procforge/shared/hash.js";
import type { Actor, EventEntry } from "@procforge/shared/dto.js";
import { pfError, type ErrorCode, type ProcForgeError } from "@procforge/shared/errors.js";
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
  private tx: TxStore | undefined;

  constructor(
    private base: Store = createMemoryStore(),
    private evaluate: EvaluateFn = defaultEvaluate,
    private opts: { sessionTtlMs?: number } = {},
  ) {}

  private get sessionTtlMs(): number {
    return this.opts.sessionTtlMs ?? 30 * 24 * 3600 * 1000;
  }

  /** 변경 메서드 안에서는 tx 오버레이 경유. NOTE: 본문은 await 없이 동기 실행 */
  private get store(): Store {
    return this.tx ?? this.base;
  }

  /** 세션 신선도 확인 + touch (M4.2-2.5, App fresh 이동). 없으면 session_not_found */
  private checkFresh(sessionId: string): Session {
    const s = this.store.getSession(sessionId);
    if (!s) throw err("session_not_found", `세션 없음: ${sessionId}`);
    const last = this.store.getLastUsed(sessionId);
    if (last === undefined) {
      this.store.touchSession(sessionId);
      return s;
    }
    if (Date.now() - last > this.sessionTtlMs) throw err("session_not_found", `세션 만료: ${sessionId}`);
    return s;
  }

  /**
   * R6 변경 트랜잭션 (M4.2-0.5): expectedRevision 비교 → 본문(버퍼링) →
   * revision+1 → 이벤트 기록 → 저장. 쓰기 없으면 그대로 반환.
   */
  private async change<R>(
    sessionId: string,
    op: { method: string; expectedRevision?: number; actor?: Actor },
    body: () => { result: R; summary: string },
  ): Promise<{ result: R; revision: number; changedNodeIds: string[] }> {
    return this.base.withLock(sessionId, () => {
    const pre = this.checkFresh(sessionId);
    if (op.expectedRevision !== undefined && pre.revision !== op.expectedRevision) {
      throw err("conflict", `revision mismatch: expected ${op.expectedRevision}, actual ${pre.revision}`);
    }
    const before = new Map<string, string>();
    for (const [id, n] of this.base.getNodes(sessionId)) before.set(id, n.hash);
    const prev = this.tx;
    const tx = new TxStore(this.base);
    this.tx = tx;
    try {
      const out = body() as { result: R; summary: string } | Promise<unknown>;
      // M4.2-2.5-7: 본문은 동기 실행 (await 금지). Promise 반환은 즉시 internal 실패.
      if (out instanceof Promise) throw err("internal", "change() body must be sync");
      const { result, summary } = out;
      const changed = tx.writtenNodeIds(sessionId);
      if (changed.length === 0 && !tx.sessionWritten(sessionId)) {
        return { result, revision: pre.revision, changedNodeIds: [] as string[] };
      }
      const cur = tx.getSession(sessionId);
      if (!cur) throw err("not_found", `session ${sessionId} not found`);
      const bumped: Session = { ...cur, revision: cur.revision + 1 };
      tx.saveSession(bumped);
      const after = new Map<string, string>();
      for (const [id, n] of tx.getNodes(sessionId)) after.set(id, n.hash);
      const pick = (m: Map<string, string>) => combineHashes(changed.map((id) => m.get(id) ?? `missing:${id}`));
      tx.appendEvents(sessionId, [{
        seq: bumped.revision,
        revision: bumped.revision,
        at: new Date().toISOString(),
        actor: op.actor ?? "host",
        method: op.method,
        nodeIds: [...changed].sort(),
        beforeHash: pick(before),
        afterHash: pick(after),
        summary,
      }]);
      tx.commit();
      return { result, revision: bumped.revision, changedNodeIds: [...changed].sort() };
    } finally {
      this.tx = prev;
    }
    });
  }

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
      revision: 0,
      opencodeVersion: input.opencodeVersion ?? "unknown",
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

  async pfNext(input: PfNextInput): Promise<PfNextOutput> {
  const sessionId = input.sessionId;
  const c = await this.change<PfNextPayload>(sessionId, { method: "pfNext", expectedRevision: input.expectedRevision, actor: input.actor }, () => {
    this.sess(sessionId);
    const nodes = [...this.store.getNodes(sessionId).values()];
    if (nodes.length === 0) return { result: { done: true }, summary: "next done" };
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
      if (!pending) return { result: { done: true }, summary: "next done" };
      const h = nodes.filter((n) => n.status === "needs_human").sort((a, b) => compareNodeIds(a.id, b.id))[0];
      if (h) {
        return { result: {
          done: false,
          node: h,
          instruction: `노드 ${h.id}는 사람의 조언이 필요하다. pf_advise로 조언을 등록하라.`,
          enteredProbing: false,
        }, summary: `next needs_human ${h.id}` };
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
      return { result: {
        done: false,
        node: first,
        blocked,
        instruction:
          `교착: ${blocked.map((b) => `${b.nodeId}(${b.reason})`).join(", ")}. ` +
          `원인 노드(${causeIds || "없음"})에 pf_advise 또는 pf_reopen 하라.`,
        enteredProbing: false,
      }, summary: `next deadlock ${first.id}` };
    }
    const n = ready[0];
    if (n.sideEffect === "external") {
      return { result: {
        done: false,
        node: n,
        instruction: `노드 ${n.id}는 외부 부작용(external)이다. 실제 실행 금지. dry-run으로 수행할 계획을 pf_report 대신 pf_ask_human으로 보고하고 사람 승인을 받아라.`,
        enteredProbing: false,
      }, summary: `next external ${n.id}` };
    }
    // M4.2-2.5.1-3: 분기 시 open→probing 전환 저장. 처음 전환될 때만 enteredProbing.
    const wasOpen = n.status === "open";
    const disp = wasOpen ? { ...n, status: "probing" as const } : n;
    if (wasOpen) this.store.saveNode(sessionId, disp);
    return { result: {
      done: false,
      node: disp,
      instruction: n.suggestedArgs
        ? `사람이 인자를 수정함(node.suggestedArgs 참조). 이 인자로 실행 후 pf_report.`
        : `노드 ${n.id}(${n.goal}): 툴 1회로 가능한지 판단하라. 가능하면 sandbox(.procforge/sandbox/${sessionId}/) 사본에서 실행 후 ` +
          `pf_report(selfVerdict/selfReason 필수), 아니면 pf_split. pass여도 leaf 자동 확정 없음 — pf_confirm_leaf(tool, argSpecs) 제출이 필요하다.`,
      enteredProbing: wasOpen,
    }, summary: `next ${n.id}` };
  });
  return { ...c.result, revision: c.revision, changedNodeIds: c.changedNodeIds };
  }

  async pfReport(input: PfReportInput): Promise<PfReportOutput> {
  const c = await this.change<Omit<PfReportOutput, "revision" | "changedNodeIds">>(input.sessionId, { method: "pfReport", expectedRevision: input.expectedRevision, actor: input.actor }, () => {
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
      return { result: {
        verdict: "fail",
        failedConstraints: [],
        instruction: `외부 부작용 노드는 실제 실행 금지. dry-run 계획을 세워 pf_ask_human으로 사람 승인을 요청하라.`,
      }, summary: `report ${n.id} blocked-external` };
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
      return { result: {
        verdict: "fail",
        failedConstraints: missingReasons,
        unverified: rubricIds,
        instruction: `llm_rubric 판정 사유 누락(${missingReasons.join(",")}). needs_human. pf_advise로 조언을 보충하거나 pf_retry 후 rubricReasons에 id별 판정 사유를 채워 다시 pf_report하라.`,
      }, summary: `report ${n.id} rubric-missing` };
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
        suggestedArgs: undefined,
        attempts: [...n.attempts, { ...attemptBase, verdict: "pass" as const, failedConstraints: [] }],
      };
      next.hash = this.hashFor(s.id, next);
      this.store.saveNode(s.id, next);
      if (next.hash !== n.hash) this.propagateStale(s.id, n.id);
      const autoNote = constraints.length > n.constraints.length ? ` 결과 형태 기반 auto constraint ${constraints.length - n.constraints.length}개 부착.` : "";
      return { result: {
        verdict,
        failedConstraints: [],
        unverified,
        instruction:
          `통과. 그러나 leaf 자동 확정은 하지 않는다.${autoNote} pf_confirm_leaf(tool, argSpecs)로 확정 신청하라. ` +
          `argSpecs는 마지막 실행 인자 키를 모두 분류(fixed/var/generated)해야 하며 누락 시 bad_request.`,
      }, summary: `report ${n.id} pass` };
    }
    // fail → 재시도 경계 (M1.5-6)
    const { status, retries } = consumeRetry(n, s.limits);
    const next: Node = {
      ...n,
      status,
      retries,
      suggestedArgs: undefined,
      attempts: [...n.attempts, { ...attemptBase, verdict: "fail" as const, failedConstraints }],
    };
    this.store.saveNode(s.id, next);
    return { result: {
      verdict,
      failedConstraints,
      unverified,
      instruction:
        status === "needs_human"
          ? `실패(재시도 소진: 총 ${n.attempts.length + 1}회). needs_human. 사유: ${input.selfReason}. pf_advise로 조언을 받거나 pf_split으로 분해하라.`
          : `실패(재시도 ${retries}/${s.limits.maxRetries}). 사유: ${input.selfReason}. 반영해 다시 실행 후 pf_report하라.`,
    }, summary: `report ${n.id} fail` };
  });
  return { ...c.result, revision: c.revision, changedNodeIds: c.changedNodeIds };
  }

  async pfResolve(input: PfResolveInput): Promise<PfResolveOutput> {
  const c = await this.change<Omit<PfResolveOutput, "revision" | "changedNodeIds">>(input.sessionId, { method: "pfResolve", expectedRevision: input.expectedRevision, actor: input.actor }, () => {
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
          return { result: { node: next, instruction: `dry-run 계획을 저장했다. pf_approve로 승인/거부를 받아라.` }, summary: `ask_human ${n.id} plan` };
        }
        const next = { ...n, status: "needs_human" as const };
        this.store.saveNode(s.id, next);
        return { result: { node: next, instruction: `노드 ${n.id}를 needs_human으로 전환했다. pf_advise를 기다려라.` }, summary: `ask_human ${n.id}` };
      }
      case "retry": {
        if (n.locked) throw err("conflict", "locked");
        const { status, retries } = consumeRetry(n, s.limits);
        const next = { ...n, status, retries };
        this.store.saveNode(s.id, next);
        return { result: {
          node: next,
          instruction: status === "needs_human" ? "재시도 한도 초과로 needs_human." : `재시도 ${retries}/${s.limits.maxRetries}. 실행 후 pf_report.`,
        }, summary: `retry ${n.id} ${status}` };
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
          return { result: { node: next, instruction: `분해 깊이가 maxDepth(${s.limits.maxDepth})를 초과해 needs_human으로 전환했다.` }, summary: `split ${n.id} maxdepth` };
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
        return { result: { node: next, created: withHashes, instruction: `분해 완료. 자식 ${withHashes.length}개를 순서대로 pf_next로 처리하라.` }, summary: `split ${n.id} +${withHashes.length}` };
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
        // M3.6-5: dependsOn 중 var/generated 어디에서도 참조되지 않으면 경고 (에러 아님)
        {
          const referenced = new Set<string>();
          for (const spec of Object.values(input.argSpecs)) {
            if (spec.kind === "var") {
              const id = varRefNodeId((spec as { ref: string }).ref);
              if (id) for (const a of selfAndAncestors(id)) referenced.add(a);
            } else if (spec.kind === "generated") {
              for (const inp of (spec as { inputs?: string[] }).inputs ?? []) {
                if (/^\d+(\.\d+)*$/.test(inp)) for (const a of selfAndAncestors(inp)) referenced.add(a);
                else referenced.add(inp);
              }
            }
          }
          for (const d of n.dependsOn) {
            if (!referenced.has(d)) warnings.push(`dep_without_dataflow: ${d} (어느 var/generated 인자에서도 참조되지 않음)`);
          }
        }
        // M4.2-2.5-4: artifacts 지정 시 같은 트랜잭션에서 attempt 결과물 확정
        const finalArtifacts = input.artifacts ?? last!.artifacts;
        const attempts = n.attempts.map((a) =>
          a.id === last!.id ? { ...a, artifacts: [...finalArtifacts] } : a,
        );
        const next: Node = {
          ...n,
          status: "leaf",
          tool: { server: input.tool.server, name: input.tool.name, schemaHash: cat.schemaHash },
          args: input.argSpecs,
          attempts,
          // M3.6-4: golden 출력 안의 params 값은 자리표시자로 저장 (재바인딩 대비)
          golden: { fixtures: [...finalArtifacts], output: maskParamsValues(last!.resultSummary, s.params), attemptId: last!.id, ignore: input.goldenIgnore ?? [] },
        };
        if (input.sideEffect) next.sideEffect = input.sideEffect;
        next.hash = this.hashFor(s.id, next);
        this.store.saveNode(s.id, next);
        this.propagateStale(s.id, n.id);
        return { result: {
          node: next,
          instruction: warnings.length > 0 ? `leaf 확정. 경고: ${warnings.join("; ")}` : `leaf 확정. pf_next로 계속하라.`,
        }, summary: `leaf ${n.id} ${input.tool.server}/${input.tool.name}` };
      }
    }
  });
  return { ...c.result, revision: c.revision, changedNodeIds: c.changedNodeIds };
  }

  async pfAdvise(input: PfAdviseInput): Promise<PfAdviseOutput> {
  const c = await this.change<Omit<PfAdviseOutput, "revision" | "changedNodeIds">>(input.sessionId, { method: "pfAdvise", expectedRevision: input.expectedRevision, actor: input.actor }, () => {
    const s = this.sess(input.sessionId);
    const n = this.node(input.sessionId, input.nodeId);
    let constraints: Constraint[];
    let rejected: { proposal: unknown; reason: string }[] = [];
    let suggestNote = "";
    if (input.proposedConstraints && input.proposedConstraints.length > 0) {
      // M4: 호스트 제안 → 최신 fixture로 평가해 채택/거부
      const adopted: Constraint[] = [];
      const fx = input.fixtureContents ?? {};
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
      for (const p of input.proposedConstraints) {
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
          adopted.push({ ...c, source: "human", note: c.note ?? input.text });
        } catch (e) {
          rejected.push({ proposal: p, reason: e instanceof Error ? e.message : String(e) });
        }
      }
      if (adopted.length === 0) {
        adopted.push(...adviceToConstraints(input.text));
      }
      constraints = adopted;
    } else {
      constraints = adviceToConstraints(input.text);
      if (suggestsNumericRef(input.text)) {
        suggestNote =
          ` 금액 비교가 필요하면 numeric_match(expectedRef=$<노드>.output.<필드>, tolerance)를 ` +
          `proposedConstraints로 제안하라 (runner에서 판정).`;
      }
    }
    const next: Node = {
      ...n,
      constraints: [...n.constraints, ...constraints],
      advice: [...n.advice, { at: new Date().toISOString(), text: input.text }],
      status: n.status === "needs_human" ? "open" : n.status,
    };
    const oldHash = n.hash;
    next.hash = this.hashFor(s.id, next);
    this.store.saveNode(s.id, next);
    if (oldHash !== next.hash) this.propagateStale(s.id, input.nodeId);
    const node = this.node(input.sessionId, input.nodeId);
    return { result: { constraints, rejected, node, ...(suggestNote ? { note: suggestNote } : {}) }, summary: `advise ${input.nodeId} +${constraints.length}` };
  });
  return { ...c.result, revision: c.revision, changedNodeIds: c.changedNodeIds };
  }

  /** 확정 인자 수정 (M4.2-2). leaf는 open으로, 수정분을 suggestedArgs에 저장 */
  async pfEditArgs(input: PfEditArgsInput): Promise<{ node: Node; instruction: string } & ChangeMeta> {
    const c = await this.change(input.sessionId, { method: "pfEditArgs", expectedRevision: input.expectedRevision, actor: input.actor }, () => {
      const s = this.sess(input.sessionId);
      const n = this.node(input.sessionId, input.nodeId);
      if (n.locked) throw err("conflict", `node ${n.id} is locked`);
      if (!n.args) throw err("bad_request", `node ${n.id}에 확정된 인자가 없어 수정 불가. pf_confirm_leaf 먼저.`);
      const set = input.patch.set ?? {};
      for (const [k, spec] of Object.entries(set)) {
        if (!spec || (spec.kind !== "fixed" && spec.kind !== "var" && spec.kind !== "generated")) {
          throw err("bad_request", `bad patch spec: ${k}`);
        }
      }
      const remove = new Set(input.patch.remove ?? []);
      if (Object.keys(set).length === 0 && remove.size === 0) {
        throw err("bad_request", "변경 없음 (patch.set/remove 중 하나 필요).");
      }
      const merged: Record<string, ArgSpec> = {};
      for (const [k, spec] of Object.entries(n.args)) {
        if (!remove.has(k)) merged[k] = spec;
      }
      Object.assign(merged, set);
      const cat = s.toolCatalog.find((t) => t.server === n.tool?.server && t.name === n.tool?.name);
      if (!n.tool || !cat) throw err("bad_request", `node ${n.id}의 도구를 카탈로그에서 찾을 수 없어 검증 불가.`);
      const problem = checkFixedAgainstInputSchema(merged, cat.inputSchema);
      if (problem) throw err("bad_request", problem);
      const reopened = n.status === "leaf" ? ("open" as const) : n.status;
      const next: Node = { ...n, status: reopened, args: merged, suggestedArgs: merged };
      next.hash = this.hashFor(s.id, next);
      this.store.saveNode(s.id, next);
      this.propagateStale(s.id, n.id);
      return { result: { node: next, instruction: `인자 수정됨. pf_next로 계속하라.` }, summary: `editArgs ${n.id}` };
    });
    return { ...c.result, revision: c.revision, changedNodeIds: c.changedNodeIds };
  }

  /** 목표·검사 조건 직접 수정 (M4.2-2) */
  async pfEditNode(input: PfEditNodeInput): Promise<{ node: Node; instruction: string } & ChangeMeta> {
    const c = await this.change(input.sessionId, { method: "pfEditNode", expectedRevision: input.expectedRevision, actor: input.actor }, () => {
      const s = this.sess(input.sessionId);
      const n = this.node(input.sessionId, input.nodeId);
      if (n.locked) throw err("conflict", `node ${n.id} is locked`);
      const adds = input.addConstraints ?? [];
      const removes = input.removeConstraintIds ?? [];
      if (input.goal === undefined && adds.length === 0 && removes.length === 0) {
        throw err("bad_request", "변경 없음 (goal/addConstraints/removeConstraintIds 중 하나 필요).");
      }
      if (input.goal !== undefined && input.goal.length === 0) throw err("bad_request", "goal이 비었다.");
      let constraints = n.constraints;
      if (removes.length > 0) {
        const missing = removes.filter((id) => !constraints.some((c) => c.id === id));
        if (missing.length > 0) throw err("bad_request", `unknown constraint: ${missing.join(",")}`);
        constraints = constraints.filter((c) => !removes.includes(c.id));
      }
      if (adds.length > 0) {
        const parsed: Constraint[] = [];
        for (const p of adds) {
          const r = ConstraintSchema.safeParse(p);
          if (!r.success) throw err("bad_request", `bad constraint: ${r.error.issues[0]?.message ?? "invalid"}`);
          parsed.push(r.data);
        }
        const dup = parsed.filter((a) => constraints.some((c) => c.id === a.id));
        if (dup.length > 0) throw err("bad_request", `duplicate constraint: ${dup.map((d) => d.id).join(",")}`);
        constraints = [...constraints, ...parsed];
      }
      const goalChanged = input.goal !== undefined && input.goal !== n.goal;
      const reopened = goalChanged && n.status === "leaf" ? ("open" as const) : n.status;
      const status = n.status === "needs_human" ? "open" : reopened;
      const next: Node = { ...n, goal: input.goal ?? n.goal, constraints, status };
      next.hash = this.hashFor(s.id, next);
      this.store.saveNode(s.id, next);
      this.propagateStale(s.id, n.id);
      return { result: { node: next, instruction: `노드 수정됨. pf_next로 계속하라.` }, summary: `editNode ${n.id}` };
    });
    return { ...c.result, revision: c.revision, changedNodeIds: c.changedNodeIds };
  }

  /** 카탈로그 저장 (M4.2-2, 수집은 local이 하고 core는 저장만) */
  async pfUpdateCatalog(input: { sessionId: string; entries: unknown[]; expectedRevision?: number; actor?: Actor }): Promise<ChangeMeta> {
    const c = await this.change(input.sessionId, { method: "pfUpdateCatalog", expectedRevision: input.expectedRevision, actor: input.actor }, () => {
      const s = this.sess(input.sessionId);
      if (!Array.isArray(input.entries)) throw err("bad_request", "entries 배열 필요.");
      const parsed: Session["toolCatalog"] = [];
      for (const e of input.entries) {
        const r = ToolCatalogEntrySchema.safeParse(e);
        if (!r.success) throw err("bad_request", `bad catalog entry: ${r.error.issues[0]?.message ?? "invalid"}`);
        parsed.push(r.data);
      }
      this.store.saveSession({ ...s, toolCatalog: parsed });
      return { result: undefined as void, summary: `updateCatalog ${parsed.length}` };
    });
    return { revision: c.revision, changedNodeIds: c.changedNodeIds };
  }

  /** attempt artifacts 교체 (M4.2-1, server 직접 저장 대체) */
  async amendAttemptArtifacts(input: AmendAttemptArtifactsInput): Promise<{ node: Node } & ChangeMeta> {
    const c = await this.change(input.sessionId, { method: "amendAttemptArtifacts", expectedRevision: input.expectedRevision, actor: input.actor }, () => {
      const n = this.node(input.sessionId, input.nodeId);
      if (n.locked) throw err("conflict", `node ${n.id} is locked`);
      const idx = n.attempts.findIndex((a) => a.id === input.attemptId);
      if (idx === -1) throw err("not_found", `attempt ${input.attemptId} not found`);
      const next: Node = {
        ...n,
        attempts: n.attempts.map((a, i) => (i === idx ? { ...a, artifacts: [...input.artifacts] } : a)),
      };
      this.store.saveNode(input.sessionId, next);
      return { result: next, summary: `amend ${input.nodeId} ${input.attemptId} ${input.artifacts.length}` };
    });
    return { node: c.result, revision: c.revision, changedNodeIds: c.changedNodeIds };
  }

  /** 절차서 문서 조립 (M4.2-1, 읽기 전용. 검증·params 경고 포함) */
  async pfBuildProcedure(sessionId: string, name: string): Promise<{ doc: ProcedureDoc; warnings: string[] }> {
    if (!PROCEDURE_NAME_RE.test(name)) {
      throw err("bad_request", `bad procedure name: ${name} (소문자·숫자·하이픈, 1~64자)`);
    }
    const session = this.sess(sessionId);
    const nodes = [...this.store.getNodes(sessionId).values()];
    if (nodes.length === 0) throw err("bad_request", "빈 세션");
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // 전 노드 resolved 확인
    const unresolved = nodes.filter((n) => !isResolved(n, byId)).map((n) => n.id);
    if (unresolved.length > 0) {
      throw err("bad_request", `미해결 노드: ${unresolved.join(", ")}`);
    }
    // M4.1-4: 구조 검증 (10종). 오류 있으면 목록과 함께 거부.
    const violations = validateTree(session, nodes);
    if (violations.length > 0) {
      throw err(
        "bad_request",
        `검증 오류 ${violations.length}건: ${violations.map((v) => `[${v.code}]${v.nodeId ? ` ${v.nodeId}` : ""} ${v.message}`).join("; ")}`,
      );
    }
    // fixed == params 경고 (재사용 깨짐). M4.1-3: 부분 문자열 포함까지 확대
    const warnings: string[] = [];
    const paramEntries = Object.entries(session.params).filter(([, v]) => v.length >= 3);
    for (const n of nodes) {
      if (n.args) {
        for (const [k, spec] of Object.entries(n.args)) {
          const s = spec as ArgSpec;
          if (s.kind !== "fixed" || typeof (s as { value: unknown }).value !== "string") continue;
          const v = (s as { value: string }).value;
          for (const [pk, pv] of paramEntries) {
            if (v === pv) warnings.push(`${n.id}.${k}="${v}": params 값과 동일한 fixed (var 후보)`);
            else if (v.includes(pv)) warnings.push(`${n.id}.${k}="${v}": params "${pk}" 값을 부분 포함 (var 후보)`);
          }
        }
      }
      if (n.golden) {
        const restored = restoreParamsPlaceholders(n.golden.output, session.params);
        for (const [pk, pv] of paramEntries) {
          if (restored.includes(pv)) warnings.push(`${n.id}.golden.output: params "${pk}" 값을 포함 (재바인딩 확인)`);
        }
      }
    }
    const doc: ProcedureDoc = {
      format: "procforge-procedure",
      version: 1,
      name,
      sourceSession: sessionId,
      createdAt: new Date().toISOString(),
      params: Object.fromEntries(
        Object.entries(session.params).map(([k, v]) => [k, { type: "string", default: v, description: "" }]),
      ),
      toolCatalog: session.toolCatalog as ProcedureDoc["toolCatalog"],
      nodes: nodes.map((n) => {
        const last = n.attempts[n.attempts.length - 1];
        return {
          id: n.id,
          parentId: n.parentId,
          goal: n.goal,
          depth: n.depth,
          dependsOn: n.dependsOn,
          children: n.children,
          tool: n.tool ? { ...n.tool } : undefined,
          args: n.args as Record<string, unknown> | undefined,
          sideEffect: n.sideEffect,
          constraints: n.constraints as unknown[],
          golden: n.golden ? { ...n.golden, ignore: n.golden.ignore ?? [] } : undefined,
          goldenArgs: last ? { ...last.args } : undefined,
        };
      }),
    };
    return { doc, warnings };
  }

  /** 상태 이벤트 조회 (M4.2-2, 읽기 전용) */
  async getEvents(sessionId: string, sinceSeq?: number): Promise<EventEntry[]> {
    this.sess(sessionId);
    const all = this.store.readEvents(sessionId);
    return sinceSeq === undefined ? all : all.filter((e) => e.seq > sinceSeq);
  }

  /** 세션 조회 (M4.2-2.5, 읽기 전용. TTL 판정 + touch 포함) */
  async getSession(sessionId: string): Promise<Session> {
    return this.checkFresh(sessionId);
  }

  /** 노드 조회 (M4.2-2.5, 읽기 전용) */
  async getNode(sessionId: string, nodeId: string): Promise<Node> {
    this.checkFresh(sessionId);
    const n = this.store.getNode(sessionId, nodeId);
    if (!n) throw err("not_found", `node ${nodeId} not found`);
    return n;
  }

  async pfTree(sessionId: string): Promise<{ nodes: Node[]; session: Session }> {
    const s = this.sess(sessionId);
    return { session: s, nodes: [...this.store.getNodes(sessionId).values()].sort((a, b) => compareNodeIds(a.id, b.id)) };
  }

  async pfApprove(input: PfApproveInput): Promise<{ node: Node } & ChangeMeta> {
  const c = await this.change(input.sessionId, { method: "pfApprove", expectedRevision: input.expectedRevision, actor: input.actor }, () => {
    const s = this.sess(input.sessionId);
    const n = this.node(input.sessionId, input.nodeId);
    if (n.locked) throw err("conflict", `node ${n.id} is locked`);
    if (n.status !== "needs_human") throw err("conflict", `node ${n.id} has no pending approval (${n.status})`);
    if (input.approved) {
      const last = n.attempts[n.attempts.length - 1];
      if (!last || last.verdict !== undefined)
        throw err("conflict", `node ${n.id} has no dry-run plan to approve. submit plan via ask_human first.`);
      const next: Node = { ...n, status: "probing", approval: { at: new Date().toISOString(), note: input.note } };
      this.store.saveNode(s.id, next);
      return { result: next, summary: `approve ${input.nodeId} yes` };
    }
    const next: Node = {
      ...n,
      status: "open",
      approval: undefined,
      advice: [...n.advice, { at: new Date().toISOString(), text: input.note ?? "plan rejected" }],
    };
    this.store.saveNode(s.id, next);
    return { result: next, summary: `approve ${input.nodeId} no` };
  });
  return { node: c.result, revision: c.revision, changedNodeIds: c.changedNodeIds };
  }

  async pfLock(input: PfLockInput): Promise<{ node: Node } & ChangeMeta> {
  const c = await this.change(input.sessionId, { method: "pfLock", expectedRevision: input.expectedRevision, actor: input.actor }, () => {
    const n = this.node(input.sessionId, input.nodeId);
    const next = { ...n, locked: true };
    this.store.saveNode(input.sessionId, next);
    return { result: next, summary: `lock ${input.nodeId}` };
  });
  return { node: c.result, revision: c.revision, changedNodeIds: c.changedNodeIds };
  }

  async pfReopen(input: PfReopenInput): Promise<{ node: Node } & ChangeMeta> {
  const c = await this.change(input.sessionId, { method: "pfReopen", expectedRevision: input.expectedRevision, actor: input.actor }, () => {
    const n = this.node(input.sessionId, input.nodeId);
    const next = { ...n, locked: false, status: "open" as const };
    this.store.saveNode(input.sessionId, next);
    return { result: next, summary: `reopen ${input.nodeId}` };
  });
  return { node: c.result, revision: c.revision, changedNodeIds: c.changedNodeIds };
  }
}

export function createInProcessClient(evaluate: EvaluateFn = defaultEvaluate): CoreClient {
  const svc = new CoreService(createMemoryStore(), evaluate);
  return svc;
}
