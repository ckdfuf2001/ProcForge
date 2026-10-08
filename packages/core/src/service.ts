import {
  computeNodeHash,
  type ArgSpec,
  type Node,
  type Session,
} from "@procforge/shared/schema.js";
import type {
  CoreClient,
  PfAdviseOutput,
  PfNextOutput,
  PfReportInput,
  PfReportOutput,
  PfResolveInput,
  PfResolveOutput,
  PfStartInput,
  PfStartOutput,
} from "@procforge/shared/core-client.js";
import { createMemoryStore, type Store } from "./store.js";
import { defaultEvaluate, type EvaluateFn } from "./evaluate.js";
import { adviceToConstraints } from "./advice.js";

function rid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function isTerminalLeafCandidate(n: Node): boolean {
  return n.status === "leaf";
}

export class CoreService implements CoreClient {
  constructor(
    private store: Store = createMemoryStore(),
    private evaluate: EvaluateFn = defaultEvaluate,
  ) {}

  private sess(sid: string): Session {
    const s = this.store.getSession(sid);
    if (!s) throw Object.assign(new Error(`session ${sid} not found`), { code: "not_found" });
    return s;
  }

  private node(sid: string, nid: string): Node {
    const n = this.store.getNode(sid, nid);
    if (!n) throw Object.assign(new Error(`node ${nid} not found`), { code: "not_found" });
    return n;
  }

  async pfStart(input: PfStartInput): Promise<PfStartOutput> {
    const sid = rid("s");
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
        "루트 노드다. 이 작업이 툴 1회 호출로 가능한지 판단하라. 가능하면 실행 후 pf_report로 보고하고, 너무 크면 pf_resolve(split)로 분해하라.",
    };
  }

  async pfNext(sessionId: string): Promise<PfNextOutput> {
    const s = this.sess(sessionId);
    const nodes = [...this.store.getNodes(sessionId).values()];
    if (nodes.length === 0) return { done: true };
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const ready = nodes
      .filter((n) => (n.status === "open" || n.status === "probing") && n.dependsOn.every((d) => byId.get(d) && isTerminalLeafCandidate(byId.get(d)!)))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    if (ready.length === 0) {
      const pending = nodes.some((n) => n.status === "open" || n.status === "probing" || n.status === "needs_human");
      if (!pending) return { done: true };
      // needs_human만 남았으면 done이 아니라 대기 — 첫 번째를 안내용으로 반환하지 않고 done:false 유지?
      // M1 단순화: needs_human 노드가 있으면 해당 노드를 반환해 조언을 유도한다.
      const h = nodes.filter((n) => n.status === "needs_human").sort((a, b) => (a.id < b.id ? -1 : 1))[0];
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
    void s;
    if (n.sideEffect === "external") {
      return {
        done: false,
        node: n,
        instruction: `노드 ${n.id}는 외부 부작용(external)이다. 실제 실행 금지. dry-run으로 수행할 계획을 pf_report 대신 pf_resolve(ask_human)로 보고하고 사람 승인을 받아라.`,
      };
    }
    return {
      done: false,
      node: n,
      instruction: `노드 ${n.id}(${n.goal}): 툴 1회로 가능한지 판단하라. 가능하면 실행 후 pf_report, 아니면 pf_resolve(split). 반복 작업이면 iterate를 함께 제출하라.`,
    };
  }

  async pfReport(input: PfReportInput): Promise<PfReportOutput> {
    const s = this.sess(input.sessionId);
    const n = this.node(input.sessionId, input.nodeId);
    if (n.locked) throw Object.assign(new Error(`node ${n.id} is locked`), { code: "conflict" });
    if (n.status !== "open" && n.status !== "probing")
      throw Object.assign(new Error(`node ${n.id} is not reportable (${n.status})`), { code: "conflict" });

    // external 차단 (§5)
    if (n.sideEffect === "external") {
      const updated: Node = {
        ...n,
        status: "needs_human",
        attempts: [
          ...n.attempts,
          {
            id: rid("a"),
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
        instruction: `외부 부작용 노드는 실제 실행 금지. dry-run 계획을 세워 pf_resolve(ask_human)로 사람 승인을 요청하라.`,
      };
    }

    // catalog 확인
    const cat = s.toolCatalog.find((t) => t.server === input.tool.server && t.name === input.tool.name);
    if (!cat) throw Object.assign(new Error(`unknown tool ${input.tool.server}/${input.tool.name}`), { code: "bad_request" });

    const artifactsMap: Record<string, string> = { ...(input.artifactContents ?? {}) };
    const { verdict, failedConstraints, unverified } = this.evaluate(n.constraints, {
      resultSummary: input.resultSummary,
      resultJson: input.resultJson,
      artifacts: artifactsMap,
    });

    const attempt = {
      id: rid("a"),
      at: new Date().toISOString(),
      tool: input.tool,
      args: input.args,
      resultSummary: input.resultSummary,
      artifacts: input.artifacts ?? [],
      verdict,
      failedConstraints,
    } as Node["attempts"][number];
    void unverified;

    let next: Node;
    if (verdict === "pass") {
      // tool/args 확정: 실제 실행값을 fixed ArgSpec으로 기록
      const args: Record<string, ArgSpec> = {};
      for (const [k, v] of Object.entries(input.args)) args[k] = { kind: "fixed", value: v };
      next = {
        ...n,
        status: "leaf",
        tool: { server: input.tool.server, name: input.tool.name, schemaHash: cat.schemaHash },
        args,
        attempts: [...n.attempts, attempt],
      };
      next.hash = computeNodeHash({ goal: next.goal, args: next.args, constraints: next.constraints, dependsOn: next.dependsOn });
      this.store.saveNode(s.id, next);
      return { verdict, failedConstraints, instruction: `통과. 노드 ${n.id}가 leaf로 확정됐다. pf_next로 다음 노드를 받아라.` };
    }
    // fail
    const retries = n.retries + 1;
    if (retries >= s.limits.maxRetries) {
      next = { ...n, status: "needs_human", retries, attempts: [...n.attempts, attempt] };
      this.store.saveNode(s.id, next);
      return {
        verdict,
        failedConstraints,
        instruction: `실패(재시도 소진). 노드 ${n.id}가 needs_human이 됐다. 원인을 좁혀 pf_advise로 조언을 받거나 pf_resolve(split)로 분해하라.`,
      };
    }
    next = { ...n, status: "probing", retries, attempts: [...n.attempts, attempt] };
    this.store.saveNode(s.id, next);
    return {
      verdict,
      failedConstraints,
      instruction: `실패(재시도 ${retries}/${s.limits.maxRetries}). 조언을 반영해 다시 실행 후 pf_report하라. 한 번에 안 되면 pf_resolve(split).`,
    };
  }

  async pfResolve(input: PfResolveInput): Promise<PfResolveOutput> {
    const s = this.sess(input.sessionId);
    const n = this.node(input.sessionId, input.nodeId);

    switch (input.decision) {
      case "ask_human": {
        const next = { ...n, status: "needs_human" as const };
        this.store.saveNode(s.id, next);
        return { node: next, instruction: `노드 ${n.id}를 needs_human으로 전환했다. pf_advise를 기다려라.` };
      }
      case "retry": {
        if (n.locked) throw Object.assign(new Error("locked"), { code: "conflict" });
        const retries = n.retries + 1;
        if (retries > s.limits.maxRetries) {
          const next = { ...n, status: "needs_human" as const, retries };
          this.store.saveNode(s.id, next);
          return { node: next, instruction: "재시도 한도 초과로 needs_human." };
        }
        const next = { ...n, status: "probing" as const, retries };
        this.store.saveNode(s.id, next);
        return { node: next, instruction: `재시도 ${retries}/${s.limits.maxRetries}. 실행 후 pf_report.` };
      }
      case "split": {
        if (n.locked) throw Object.assign(new Error(`locked node ${n.id} cannot be split`), { code: "conflict" });
        // 조상이 아니라 "이 노드가 잠긴 노드의 조상"인 경우도 금지
        const all = [...this.store.getNodes(s.id).values()];
        const isAncestorOfLocked = all.some((x) => x.locked && (x.id === n.id || x.id.startsWith(n.id + ".")));
        if (isAncestorOfLocked && all.some((x) => x.locked && x.id !== n.id && x.id.startsWith(n.id + ".")))
          throw Object.assign(new Error("ancestor of locked node"), { code: "conflict" });
        if (!input.children || input.children.length === 0)
          throw Object.assign(new Error("split requires children"), { code: "bad_request" });
        if (n.depth + 1 > s.limits.maxDepth) {
          const next = { ...n, status: "needs_human" as const };
          this.store.saveNode(s.id, next);
          return { node: next, instruction: `분해 깊이가 maxDepth(${s.limits.maxDepth})를 초과해 needs_human으로 전환했다.` };
        }
        if (all.length + input.children.length > s.limits.maxNodes)
          throw Object.assign(new Error("maxNodes exceeded"), { code: "bad_request" });
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
        if (!input.tool) throw Object.assign(new Error("leaf requires tool"), { code: "bad_request" });
        const cat = s.toolCatalog.find((t) => t.server === input.tool!.server && t.name === input.tool!.name);
        if (!cat) throw Object.assign(new Error("unknown tool"), { code: "bad_request" });
        const last = n.attempts[n.attempts.length - 1];
        if (!last || last.verdict !== "pass")
          throw Object.assign(new Error("leaf requires passing attempt. report first."), { code: "conflict" });
        const argSpecs = input.argSpecs ?? {};
        // var 후보 경고: params 값과 동일한 fixed
        const warnings: string[] = [];
        for (const [k, spec] of Object.entries(argSpecs)) {
          if (spec.kind === "fixed") {
            const v = (spec as { value: unknown }).value;
            if (typeof v === "string" && Object.values(s.params).includes(v))
              warnings.push(`arg ${k} 값 "${v}"이 params와 동일 — var(${"${params.*"}) 후보`);
          }
        }
        if (input.sideEffect) n.sideEffect = input.sideEffect;
        const next: Node = {
          ...n,
          status: "leaf",
          tool: { server: input.tool.server, name: input.tool.name, schemaHash: cat.schemaHash },
          args: argSpecs,
        };
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
    // hash가 바뀌면 dependsOn 하위 노드만 stale 처리 (BFS 하류)
    if (oldHash !== next.hash) {
      const all = [...this.store.getNodes(s.id).values()];
      const downstream = all.filter((x) => x.dependsOn.includes(nodeId));
      const queue = [...downstream];
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
    return { session: s, nodes: [...this.store.getNodes(sessionId).values()].sort((a, b) => (a.id < b.id ? -1 : 1)) };
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
