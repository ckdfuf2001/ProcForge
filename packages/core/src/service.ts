import { randomUUID } from "node:crypto";
import {
  computeNodeHash,
  type Constraint,
  type Node,
  type Session,
} from "@procforge/shared/schema.js";
import type {
  CoreClient,
  EvaluateFn,
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
import { adviceToConstraints } from "./advice.js";
import { compareNodeIds } from "./ids.js";

function newAttemptId(): string {
  return randomUUID();
}

function err(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

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
 * dependsOn 충족 조건 (M1.5-5): dep이 leaf이거나,
 * split이면서 모든 하위(자손)가 leaf.
 */
export function isResolved(n: Node, byId: Map<string, Node>, seen = new Set<string>()): boolean {
  if (n.status === "leaf") return true;
  if (n.status !== "split") return false;
  if (seen.has(n.id)) return false;
  seen.add(n.id);
  if (n.children.length === 0) return false;
  return n.children.every((c) => {
    const child = byId.get(c);
    return child !== undefined && isResolved(child, byId, seen);
  });
}

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
          n.dependsOn.every((d) => {
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
      return { done: true };
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
      next.hash = computeNodeHash({ goal: next.goal, args: next.args, constraints: next.constraints, dependsOn: next.dependsOn });
      this.store.saveNode(s.id, next);
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
          child.hash = computeNodeHash({ goal: child.goal, args: {}, constraints: [], dependsOn: child.dependsOn });
          return child;
        });
        const next: Node = { ...n, status: "split", children: created.map((c) => c.id) };
        next.hash = computeNodeHash({ goal: next.goal, args: next.args, constraints: next.constraints, dependsOn: next.dependsOn });
        this.store.saveNode(s.id, next);
        for (const c of created) this.store.saveNode(s.id, c);
        return { node: next, created, instruction: `분해 완료. 자식 ${created.length}개를 순서대로 pf_next로 처리하라.` };
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
          golden: { fixtures: [...last.artifacts], output: last.resultSummary },
        };
        if (input.sideEffect) next.sideEffect = input.sideEffect;
        next.hash = computeNodeHash({ goal: next.goal, args: next.args, constraints: next.constraints, dependsOn: next.dependsOn });
        this.store.saveNode(s.id, next);
        return {
          node: next,
          instruction: warnings.length > 0 ? `leaf 확정. 경고: ${warnings.join("; ")}` : `leaf 확정. pf_next로 계속하라.`,
        };
      }
    }
  }

  async pfAdvise(sessionId: string, nodeId: string, text: string): Promise<PfAdviseOutput> {
    const s = this.sess(sessionId);
    const n = this.node(sessionId, nodeId);
    const constraints = adviceToConstraints(text);
    const next: Node = {
      ...n,
      constraints: [...n.constraints, ...constraints],
      advice: [...n.advice, { at: new Date().toISOString(), text }],
      status: n.status === "needs_human" ? "open" : n.status,
    };
    const oldHash = n.hash;
    next.hash = computeNodeHash({ goal: next.goal, args: next.args, constraints: next.constraints, dependsOn: next.dependsOn });
    this.store.saveNode(s.id, next);
    if (oldHash !== next.hash) {
      const all = [...this.store.getNodes(s.id).values()];
      const queue = all.filter((x) => x.dependsOn.includes(nodeId));
      const seen = new Set<string>();
      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (seen.has(cur.id)) continue;
        seen.add(cur.id);
        if (cur.status === "leaf" || cur.status === "split") {
          this.store.saveNode(s.id, { ...cur, status: "open" });
        }
        for (const y of all) if (y.dependsOn.includes(cur.id)) queue.push(y);
      }
    }
    return { constraints, node: this.node(sessionId, nodeId) };
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
