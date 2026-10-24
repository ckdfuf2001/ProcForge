import { randomUUID } from "node:crypto";
import {
  computeNodeHash,
  ConstraintSchema,
  MapSpecSchema,
  UntilSpecSchema,
  ToolCatalogEntrySchema,
  type ArgSpec,
  type Constraint,
  type Node,
  type Session,
  type SessionSummary,
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
  PreviewEditInput,
  AmendAttemptArtifactsInput,
  PfStartInput,
  PfStartOutput,
  PfImportProcedureInput,
  PfImportProcedureOutput,
  PfWriteGoldenInput,
  ChangeMeta,
} from "@procforge/shared/core-client.js";
import { createMemoryStore } from "./store.js";
import type { Store } from "@procforge/shared/store.js";
import { TxStore } from "./txn.js";
import { defaultEvaluate } from "./evaluate.js";
import { adviceToConstraints, suggestsNumericRef } from "./advice.js";
import { compareNodeIds } from "@procforge/shared/ids.js";

/** M7-ui4: 목표 상한 (UI 입력도 core와 같은 상한으로 검증한다). */
// M7-ui4-f: goal 상한은 순수 편집 함수가 정의한다 (preview=실제 편집 동일).
export { GOAL_MAX_LEN } from "./edit.js";
import {
  autoConstraints,
  decideReportVerdict,
  resultJsonMetaOf,
} from "@procforge/shared/report.js";
export { autoConstraints, resultJsonMetaOf };

function newAttemptId(): string {
  return randomUUID();
}

function err(code: ErrorCode, message: string): ProcForgeError {
  return pfError(code, message);
}

import {
  checkUnknownKeys,
  readSchemaProps,
  selfAndAncestors,
  similarKey,
  varRefNodeId,
} from "@procforge/shared/args-schema.js";
import { checkFixedAgainstInputSchema } from "@procforge/shared/validator.js";
import { applyEdit, type EditChange } from "./edit.js";

import {
  PROCEDURE_NAME_RE,
  buildImportSession,
  type ProcedureDoc,
} from "@procforge/shared/procedure.js";
import { validateTree } from "@procforge/shared/validator.js";
import { combineHashes } from "@procforge/shared/hash.js";
import type {
  Actor,
  EventDetail,
  EventEntry,
  HistoryNode,
  DecompositionEvent,
  DecompositionHistoryEntry,
} from "@procforge/shared/dto.js";
import {
  pfError,
  type ErrorCode,
  type ProcForgeError,
} from "@procforge/shared/errors.js";
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
import {
  effectiveDeps,
  expandDepLeafs,
  hasCycle,
  hasLineageDep,
} from "@procforge/shared/deps.js";

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
    const waitingOn = [
      ...new Set([
        ...n.dependsOn.filter(unresolved),
        ...effectiveDeps(n, byId).filter(unresolved),
      ]),
    ];
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
      const related = new Set([
        ...waitingOn,
        ...waitingOn.flatMap((d) => expandDepLeafs(d, byId)),
      ]);
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
    private opts: {
    sessionTtlMs?: number;
    /** M7-ui4-h: 시각 주입 (가짜 시계). TTL 판정·lastWriteAt 기록 모두 이 값을 쓴다. */
    now?: () => number;
  } = {},
  ) {}

  private get sessionTtlMs(): number {
    return this.opts.sessionTtlMs ?? 30 * 24 * 3600 * 1000;
  }

  /** M7-ui4-h: 주입된 시계 (없으면 벽시계) */
  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  /** 변경 메서드 안에서는 tx 오버레이 경유. NOTE: 본문은 await 없이 동기 실행 */
  private get store(): Store {
    return this.tx ?? this.base;
  }

  /**
   * 세션 신선도 확인 + touch (M4.2-2.5, App fresh 이동). 없으면 session_not_found.
   * M7-ui2-b: 읽기 전용 경로(UI 폴링)는 저장소를 건드리지 않는다.
   * touch는 쓰기 경로만 doing — 화면을 보기만 해도 세션 파일이 바뀌면 안 된다.
   */
  private checkFresh(sessionId: string): Session {
    return this.checkFreshWith(sessionId, true);
  }

  /** 읽기 전용 확인 (touch 없음. 만료 판정은 같은 규칙) */
  private checkFreshRead(sessionId: string): Session {
    return this.checkFreshWith(sessionId, false);
  }

  private checkFreshWith(sessionId: string, _touch: boolean): Session {
    const s = this.store.getSession(sessionId);
    if (!s) throw err("session_not_found", `세션 없음: ${sessionId}`);
    // M7-ui4-a: 판정 기준은 **디스크**에 남은 값이다 (`lastWriteAt ?? createdAt`).
    // 메모리 상태에 의존하면 프로세스 재시작 후, 그리고 원격 core(요청마다
    // store를 새로 만드는 구조)에서 판정이 사라진다.
    // 읽기는 기준을 바꾸지 않는다 — 화면만 봐도 세션이 살아 있으면 안 된다.
    // M7-ui4-h: 판정 시각도 주입된 시계를 쓴다 (기록 시각과 판정 시각이 어긋나면 안 된다).
    const raw = s.lastWriteAt ?? s.createdAt;
    const base = Date.parse(raw);
    if (!Number.isFinite(base)) return s;
    if (this.now() - base > this.sessionTtlMs) {
      throw err("session_not_found", `세션 만료: ${sessionId}`);
    }
    return s;
  }

  /**
   * R6 변경 트랜잭션 (M4.2-0.5): expectedRevision 비교 → 본문(버퍼링) →
   * revision+1 → 이벤트 기록 → 저장. 쓰기 없으면 그대로 반환.
   */
  private async change<R>(
    sessionId: string,
    op: { method: string; expectedRevision?: number; actor?: Actor },
    body: () => {
      result: R;
      summary: string;
      /** M8-ui1: split 등 변경별 상세 (nodesAfter는 change()가 채운다) */
      detail?: EventDetail;
    },
  ): Promise<{ result: R; revision: number; changedNodeIds: string[] }> {
    return this.base.withLock(sessionId, () => {
      const pre = this.checkFresh(sessionId);
      if (
        op.expectedRevision !== undefined &&
        pre.revision !== op.expectedRevision
      ) {
        throw err(
          "conflict",
          `revision mismatch: expected ${op.expectedRevision}, actual ${pre.revision}`,
        );
      }
      const before = new Map<string, string>();
      for (const [id, n] of this.base.getNodes(sessionId))
        before.set(id, n.hash);
      const beforeIds = [...before.keys()];
      const prev = this.tx;
      const tx = new TxStore(this.base);
      this.tx = tx;
      try {
        const out = body() as
          | { result: R; summary: string; detail?: EventDetail }
          | Promise<unknown>;
        // M4.2-2.5-7: 본문은 동기 실행 (await 금지). Promise 반환은 즉시 internal 실패.
        if (out instanceof Promise)
          throw err("internal", "change() body must be sync");
        const { result, summary, detail: bodyDetail } = out;
        const changed = tx.writtenNodeIds(sessionId);
        if (changed.length === 0 && !tx.sessionWritten(sessionId)) {
          return {
            result,
            revision: pre.revision,
            changedNodeIds: [] as string[],
          };
        }
        const cur = tx.getSession(sessionId);
        if (!cur) throw err("not_found", `session ${sessionId} not found`);
        // M7-ui4-h: **커밋 세션에 core가** lastWriteAt를 찍는다.
        // 저장소가 찍으면 테스트용 메모리 store와 판정이 달라지고(저장소가 모르는
        // 규칙이 되는 셈), 시각도 주입 불가다. 여기서 찍으면 파일/메모리·재시작·
        // 원격이 같은 규칙을 쓴다.
        const bumped: Session = {
          ...cur,
          revision: cur.revision + 1,
          lastWriteAt: this.nowIso(),
        };
        tx.saveSession(bumped);
        const after = new Map<string, string>();
        for (const [id, n] of tx.getNodes(sessionId)) after.set(n.id, n.hash);
        const pick = (m: Map<string, string>) =>
          combineHashes(changed.map((id) => m.get(id) ?? `missing:${id}`));
        // M8-ui1: 변경된 노드의 사본을 이벤트에 남긴다 (revision별 트리 복원용).
        const nodesAfter = [...changed]
          .sort(compareNodeIds)
          .map((id) => tx.getNode(sessionId, id))
          .filter((n): n is Node => n !== undefined)
          .map((n) => this.historyNodeOf(n));
        const removedIds = beforeIds
          .filter((id) => !after.has(id))
          .sort(compareNodeIds);
        const detail: EventDetail = {
          ...(bodyDetail ?? {}),
          nodesAfter,
          ...(removedIds.length > 0 ? { removedIds } : {}),
        };
        tx.appendEvents(sessionId, [
          {
            seq: bumped.revision,
            revision: bumped.revision,
            at: this.nowIso(),
            actor: op.actor ?? "host",
            method: op.method,
            nodeIds: [...changed].sort(),
            beforeHash: pick(before),
            afterHash: pick(after),
            summary,
            detail,
          },
        ]);
        tx.commit();
        return {
          result,
          revision: bumped.revision,
          changedNodeIds: [...changed].sort(),
        };
      } finally {
        this.tx = prev;
      }
    });
  }

  /** M8-ui1: 노드 → 이벤트/트리 스냅샷 (attempts 등 큰 필드는 뺀다) */
  private historyNodeOf(n: Node): HistoryNode {
    return {
      id: n.id,
      parentId: n.parentId,
      goal: n.goal,
      status: n.status,
      depth: n.depth,
      children: [...n.children],
      dependsOn: [...n.dependsOn],
      locked: n.locked,
      sideEffect: n.sideEffect,
      ...(n.staleSince ? { staleSince: { ...n.staleSince } } : {}),
      ...(n.reverifySince ? { reverifySince: { ...n.reverifySince } } : {}),
      hash: n.hash,
    };
  }

  /**
   * M8-ui1: 이 노드의 직전 split/report 이후 등록된 조언 id 목록.
   * 분해 사유의 "무엇 때문에 다시 나눴는가"를 자동으로 잇는다.
   * 구 세션의 조언에는 id가 없으므로 자동으로 비어 있다.
   */
  private causeAdviceFor(
    sid: string,
    nodeId: string,
  ): {
    ids: string[];
    copies: { id: string; textPreview: string; actor: Actor }[];
  } {
    let cutoff = -1;
    // 조언 revision → 등록 actor (pfAdvise 이벤트에서 복원).
    const adviseActor = new Map<number, Actor>();
    for (const e of this.store.readEvents(sid)) {
      if (e.method === "pfAdvise" && e.nodeIds.includes(nodeId))
        adviseActor.set(e.revision, e.actor);
      const isSplit = e.method === "pfResolve" && e.summary.startsWith("split ");
      const isReport = e.method === "pfReport";
      if (!isSplit && !isReport) continue;
      if (!e.nodeIds.includes(nodeId)) continue;
      if (e.revision > cutoff) cutoff = e.revision;
    }
    const n = this.store.getNode(sid, nodeId);
    if (!n) return { ids: [], copies: [] };
    const picked = n.advice.filter(
      (a) =>
        typeof a.id === "string" &&
        a.revision !== undefined &&
        a.revision > cutoff,
    );
    return {
      ids: picked.map((a) => a.id as string),
      // M8-ui2 정정: 이벤트에 사본을 남긴다 (textPreview ≤ 200자, actor 포함).
      copies: picked.map((a) => ({
        id: a.id as string,
        textPreview: a.text.length > 200 ? a.text.slice(0, 200) : a.text,
        actor: adviseActor.get(a.revision as number) ?? "host",
      })),
    };
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
    const depHs = [
      ...new Set(
        effectiveDeps(n, byId).map(
          (id) => byId.get(id)?.hash ?? `missing:${id}`,
        ),
      ),
    ].sort();
    const map = (n as { map?: unknown }).map;
    const until = (n as { until?: unknown }).until;
    const stateWrites = (n as { stateWrites?: unknown }).stateWrites;
    return computeNodeHash({
      goal: n.goal,
      args: n.args,
      constraints: n.constraints,
      dependsOn: depHs,
      ...(map !== undefined ? { map } : {}),
      ...(until !== undefined ? { until } : {}),
      ...(stateWrites !== undefined ? { stateWrites } : {}),
    });
  }

  /**
   * M8-1-0: (재)작업 시작 전환.
   * open(재개)·needs_reverify(자기 재검증)를 probing 으로 넘긴다.
   * pfNext·pfReport 가 **같은 함수**를 쓴다 — 재시도 한도 리셋 규칙이
   * 경로마다 어긋나지 않게 (pf_next 를 거치지 않고 바로 보고하는 경로도 동일).
   */
  private enterProbing(n: Node): { node: Node; entered: boolean } {
    if (n.status !== "open" && n.status !== "needs_reverify")
      return { node: n, entered: false };
    const reverify = n.status === "needs_reverify";
    return {
      node: {
        ...n,
        status: "probing" as const,
        // 재검증은 새 시도다 — 재시도 한도는 기본값으로 리셋한다.
        ...(reverify ? { retries: 0 } : {}),
      },
      entered: true,
    };
  }

  /**
   * M8-1-0: 확정 leaf의 hash를 바꾼 쓰기 → needs_reverify.
   * hash가 같으면 leaf 유지(순수 메모). leaf가 아닌 노드는 호출부 동작 유지.
   */
  private withLeafReverify(
    prev: Node,
    next: Node,
    cause: "advise" | "edit_args" | "edit_node",
    revision: number,
  ): Node {
    if (prev.status !== "leaf") return next;
    if (next.hash === prev.hash) return { ...next, status: "leaf" };
    return {
      ...next,
      status: "needs_reverify",
      reverifySince: {
        revision,
        causeNodeId: prev.id,
        cause,
      },
    };
  }

  /**
   * stale 전파 일반화 (M3.4-6, M3.4.3-3, 구 §5 규칙): origin 변경 후, 펼친 의존에
   * origin을 포함하는 하류 노드의 hash를 재계산·저장. leaf는 open으로 되돌리고,
   * split은 상태를 유지한 채 자손으로 계속 (재-split 불필요).
   */
  private propagateStale(sid: string, originId: string, atRevision?: number): void {
    const queue = [originId];
    const seen = new Set<string>([originId]);
    const rev = atRevision ?? this.store.getSession(sid)?.revision ?? 0;
    const marked = new Set<string>();
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const all = this.store.getNodes(sid);
      for (const n of all.values()) {
        if (n.id === cur || seen.has(n.id)) continue;
        if (!effectiveDeps(n, all).includes(cur)) continue;
        seen.add(n.id);
        const nh = this.hashFor(sid, n);
        if (nh === n.hash) continue;
        // M7-ui2-a: split은 상태를 유지하고 stale 표시도 미기록한다.
        // (자손 leaf의 표시가 실제 작업 단위 — split 표시까지 켜면噪声)
        if (n.status === "split") {
          this.store.saveNode(sid, { ...n, hash: nh, staleSince: undefined });
          continue;
        }
        const reopened = n.status === "leaf" ? ("open" as const) : n.status;
        this.store.saveNode(sid, {
          ...n,
          hash: nh,
          status: reopened,
          staleSince: n.staleSince ?? { revision: rev, causeNodeId: originId },
        });
        marked.add(n.id);
        queue.push(n.id);
      }
    }
    // M7-ui2-a: 이 번 전파에서 표시한 자손이 모두 해제되면 split 표시도 해제.
    this.clearStaleSplits(sid, marked);
  }

  /** M7-ui2-a: 자손 leaf가 모두 stale 표시를 잃은 split은 표시를 해제한다. */
  private clearStaleSplits(sid: string, changed: Set<string>): void {
    if (changed.size === 0) return;
    const all = this.store.getNodes(sid);
    for (const n of all.values()) {
      if (n.status !== "split" || !n.staleSince) continue;
      const touched = [...all.values()]
        .filter((m) => m.id !== n.id && effectiveDeps(m, all).includes(n.id))
        .filter((m) => changed.has(m.id) || m.staleSince !== undefined);
      if (touched.length === 0) continue;
      const stillStale = touched.some((m) => m.staleSince !== undefined);
      if (!stillStale) {
        this.store.saveNode(sid, { ...n, staleSince: undefined });
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
      createdAt: this.nowIso(),
      // M7-ui4-h: 시작도 쓰기다 — TTL 기준을 심는다.
      lastWriteAt: this.nowIso(),
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
    root.hash = computeNodeHash({
      goal: root.goal,
      args: {},
      constraints: [],
      dependsOn: [],
    });
    this.store.saveNode(sid, root);
    return {
      session,
      node: root,
      instruction:
        `루트 노드다. 이 작업이 툴 1회 호출로 가능한지 판단하라. 가능하면 실행 후 pf_report(selfVerdict/selfReason 필수)로 보고하고, 너무 크면 pf_split으로 분해하라. ` +
        `탐색 실행(probing)은 .procforge/sandbox/${sid}/ 작업 사본에서만 하라. ` +
        `항목 반복은 map, 페이지는 until, 지난 실행 기억은 state를 쓰라. ` +
        `offset·cursor 증가 연산은 ref로 못 하므로 until 본문을 script로 받아라.`,
    };
  }

  async pfNext(input: PfNextInput): Promise<PfNextOutput> {
    const sessionId = input.sessionId;
    const c = await this.change<PfNextPayload>(
      sessionId,
      {
        method: "pfNext",
        expectedRevision: input.expectedRevision,
        actor: input.actor,
      },
      () => {
        this.sess(sessionId);
        const nodes = [...this.store.getNodes(sessionId).values()];
        if (nodes.length === 0)
          return { result: { done: true }, summary: "next done" };
        const byId = new Map(nodes.map((n) => [n.id, n]));
        const ready = nodes
          .filter(
            (n) =>
              (n.status === "open" ||
                n.status === "probing" ||
                n.status === "needs_reverify") &&
              effectiveDeps(n, byId).every((d) => {
                const dep = byId.get(d);
                return dep !== undefined && isResolved(dep, byId);
              }),
          )
          .sort((a, b) => compareNodeIds(a.id, b.id));
        if (ready.length === 0) {
          const pending = nodes.some(
            (n) =>
              n.status === "open" ||
              n.status === "probing" ||
              n.status === "needs_reverify" ||
              n.status === "needs_human",
          );
          if (!pending) return { result: { done: true }, summary: "next done" };
          const h = nodes
            .filter((n) => n.status === "needs_human")
            .sort((a, b) => compareNodeIds(a.id, b.id))[0];
          if (h) {
            return {
              result: {
                done: false,
                node: h,
                instruction: `노드 ${h.id}는 사람의 조언이 필요하다. pf_advise로 조언을 등록하라.`,
                enteredProbing: false,
              },
              summary: `next needs_human ${h.id}`,
            };
          }
          // M3.4.3-1 교착: ready 0 + pending + needs_human 없음
          const stuck = nodes
            .filter(
              (n) =>
                n.status === "open" ||
                n.status === "probing" ||
                n.status === "needs_reverify",
            )
            .sort((a, b) => compareNodeIds(a.id, b.id));
          const { blocked, causes } = computeDeadlock(stuck, byId);
          // 원인 노드 needs_human 승격. 승격 가능 원인이 하나도 없으면 첫 stuck 자승격.
          // (빈 split 등 승격 불가 원인만 있을 때 무한 동일 blocked 방지)
          const promoted: string[] = [];
          for (const cid of causes) {
            const c = this.node(sessionId, cid);
            if (
              c.status === "open" ||
              c.status === "probing" ||
              c.status === "needs_reverify"
            ) {
              this.store.saveNode(sessionId, { ...c, status: "needs_human" });
              promoted.push(cid);
            }
          }
          if (blocked.length > 0 && promoted.length === 0 && stuck.length > 0) {
            const f = this.node(sessionId, stuck[0].id);
            if (
              f.status === "open" ||
              f.status === "probing" ||
              f.status === "needs_reverify"
            ) {
              this.store.saveNode(sessionId, { ...f, status: "needs_human" });
            }
          }
          const first = stuck[0];
          const causeIds = causes.join(",");
          return {
            result: {
              done: false,
              node: first,
              blocked,
              instruction:
                `교착: ${blocked.map((b) => `${b.nodeId}(${b.reason})`).join(", ")}. ` +
                `원인 노드(${causeIds || "없음"})에 pf_advise 또는 pf_reopen 하라.`,
              enteredProbing: false,
            },
            summary: `next deadlock ${first.id}`,
          };
        }
        const n = ready[0];
        if (n.sideEffect === "external") {
          return {
            result: {
              done: false,
              node: n,
              instruction: `노드 ${n.id}는 외부 부작용(external)이다. 실제 실행 금지. dry-run으로 수행할 계획을 pf_report 대신 pf_ask_human으로 보고하고 사람 승인을 받아라.`,
              enteredProbing: false,
            },
            summary: `next external ${n.id}`,
          };
        }
        // M4.2-2.5.1-3: 분기 시 open→probing 전환 저장. 처음 전환될 때만 enteredProbing.
        // M8-1-0: needs_reverify도 probing으로 전환하고 재시도 한도를 리셋한다
        // (attempt 이력은 유지 — 재확정 가드는 revision으로 판정한다).
        const { node: disp, entered: entering } = this.enterProbing(n);
        if (entering) this.store.saveNode(sessionId, disp);
        return {
          result: {
            done: false,
            node: disp,
            instruction: n.suggestedArgs
              ? `사람이 인자를 수정함(node.suggestedArgs 참조). 이 인자로 실행 후 pf_report.`
              : `노드 ${n.id}(${n.goal}): 툴 1회로 가능한지 판단하라. 가능하면 sandbox(.procforge/sandbox/${sessionId}/) 사본에서 실행 후 ` +
                `pf_report(selfVerdict/selfReason 필수), 아니면 pf_split. pass여도 leaf 자동 확정 없음 — pf_confirm_leaf(tool, argSpecs) 제출이 필요하다. ` +
                `항목 반복은 map, 페이지는 until, 지난 실행 기억은 state를 쓰라. ` +
                `offset·cursor 증가 연산은 ref로 못 하므로 until 본문을 script로 받아라.`,
            enteredProbing: entering,
          },
          summary: `next ${n.id}`,
        };
      },
    );
    return {
      ...c.result,
      revision: c.revision,
      changedNodeIds: c.changedNodeIds,
    };
  }

  async pfReport(input: PfReportInput): Promise<PfReportOutput> {
    const c = await this.change<
      Omit<PfReportOutput, "revision" | "changedNodeIds">
    >(
      input.sessionId,
      {
        method: "pfReport",
        expectedRevision: input.expectedRevision,
        actor: input.actor,
      },
      () => {
        const s = this.sess(input.sessionId);
        let n = this.node(input.sessionId, input.nodeId);
        if (!input.selfVerdict || !input.selfReason)
          throw err("bad_request", "selfVerdict and selfReason are required");
        if (n.locked) throw err("conflict", `node ${n.id} is locked`);
        // M8-1-0: 재검증 대기(needs_reverify) 노드도 새 attempt를 보고할 수 있다.
        // (pf_next를 거치지 않고 바로 재검증 결과를 제출하는 경로)
        if (
          n.status !== "open" &&
          n.status !== "probing" &&
          n.status !== "needs_reverify"
        )
          throw err("conflict", `node ${n.id} is not reportable (${n.status})`);

        // M8-1-0: 재검증 대기를 **pf_next 없이** 바로 보고하는 경로도 같은 전환을 탄다
        // (probing 전환 + 재시도 한도 리셋). 이벤트에는 이 전환이 남는다.
        if (n.status === "needs_reverify") {
          const moved = this.enterProbing(n);
          n = moved.node;
          this.store.saveNode(s.id, n);
        }

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
            result: {
              verdict: "fail",
              failedConstraints: [],
              instruction: `외부 부작용 노드는 실제 실행 금지. dry-run 계획을 세워 pf_ask_human으로 사람 승인을 요청하라.`,
            },
            summary: `report ${n.id} blocked-external`,
          };
        }

        // catalog 확인
        const cat = s.toolCatalog.find(
          (t) => t.server === input.tool.server && t.name === input.tool.name,
        );
        if (!cat)
          throw err(
            "bad_request",
            `unknown tool ${input.tool.server}/${input.tool.name}`,
          );

        // llm_rubric 사유 확인 (M1.5-3)
        const rubricIds = n.constraints
          .filter((c) => c.kind === "llm_rubric")
          .map((c) => c.id);
        const missingReasons = rubricIds.filter(
          (id) => !input.rubricReasons?.[id],
        );
        // M5.8.2 후속: 실데이터는 로컬 attempt 파일, core는 메타만 (R8 4KB).
        // M6.1-1: 사전평가 경로는 local이 계산한 메타 사용.
        const reportMeta =
          input.resultJsonMeta ??
          (input.resultJson !== undefined
            ? resultJsonMetaOf(input.resultJson)
            : undefined);
        const attemptBase = {
          id: input.attemptId ?? newAttemptId(),
          at: new Date().toISOString(),
          // M8-1-0: 재확정 가드가 "재검증 이후 attempt"를 revision으로 판정한다.
          revision: s.revision + 1,
          tool: input.tool,
          args: input.args,
          resultSummary: input.resultSummary,
          artifacts: input.artifacts ?? [],
          ...(input.rubricReasons
            ? { rubricReasons: input.rubricReasons }
            : {}),
          ...(reportMeta ? { resultJsonMeta: reportMeta } : {}),
        };
        if (missingReasons.length > 0) {
          // M1.5-3: 사유 없으면 needs_human (재시도 차감 없음 — 프로토콜 오류扱い)
          const next: Node = {
            ...n,
            status: "needs_human",
            attempts: [
              ...n.attempts,
              {
                ...attemptBase,
                verdict: "fail" as const,
                failedConstraints: missingReasons,
              },
            ],
          };
          this.store.saveNode(s.id, next);
          return {
            result: {
              verdict: "fail",
              failedConstraints: missingReasons,
              unverified: rubricIds,
              instruction: `llm_rubric 판정 사유 누락(${missingReasons.join(",")}). needs_human. pf_advise로 조언을 보충하거나 pf_retry 후 rubricReasons에 id별 판정 사유를 채워 다시 pf_report하라.`,
            },
            summary: `report ${n.id} rubric-missing`,
          };
        }

        // verdict 계산 (M1.5-2): constraints가 비었으면 selfVerdict 사용.
        // M3.5.1-1: source:auto 제약은 매 pass마다 재생성(human 유지). 평가는
        // human + 재생성분으로 (낡은 attempt 키 pin 제거).
        const artifactsMap: Record<string, string> = {
          ...(input.artifactContents ?? {}),
        };
        const human = n.constraints.filter((c) => c.source !== "auto");
        let verdict: "pass" | "fail";
        let failedConstraints: string[];
        let unverified: string[] | undefined;
        let freshAuto: Constraint[];
        if (input.localEvaluation) {
          // M6.1-1: 원격 사전평가 신뢰 경로. 원문 병행 금지, 메타 필수.
          if (input.resultJson !== undefined)
            throw err(
              "bad_request",
              "localEvaluation과 resultJson 병행 금지 (메타+판정만 전송)",
            );
          if (!input.resultJsonMeta)
            throw err("bad_request", "localEvaluation에는 resultJsonMeta 필수");
          freshAuto = input.autoConstraints ?? [];
          verdict = input.localEvaluation.verdict;
          failedConstraints = [...input.localEvaluation.failedConstraints];
          if (
            input.selfVerdict === "fail" &&
            !failedConstraints.includes("self")
          )
            failedConstraints.push("self");
          unverified = input.localEvaluation.unverified;
        } else {
          freshAuto = autoConstraints(
            input.resultJson,
            input.artifacts ?? [],
            input.artifactSources,
            input.verifiedJsonKeys,
          );
          const ev = decideReportVerdict({
            storedConstraints: n.constraints,
            freshAuto,
            selfVerdict: input.selfVerdict,
            evaluate: this.evaluate,
            ctx: {
              resultSummary: input.resultSummary,
              resultJson: input.resultJson,
              artifacts: artifactsMap,
            },
          });
          verdict = ev.verdict;
          failedConstraints = ev.failedConstraints;
          unverified = ev.unverified;
        }

        if (verdict === "pass") {
          // M1.5-1: pass여도 leaf 자동 확정 없음. probing 유지 + resolve 요구.
          // M3.5.1-1: auto 제약 재생성 저장 (human 유지).
          // M7-ui2: 재실행 성공 → stale 표시 해제.
          const constraints = [...human, ...freshAuto];
          const next: Node = {
            ...n,
            status: "probing",
            constraints,
            staleSince: undefined,
            suggestedArgs: undefined,
            attempts: [
              ...n.attempts,
              {
                ...attemptBase,
                verdict: "pass" as const,
                failedConstraints: [],
              },
            ],
          };
          next.hash = this.hashFor(s.id, next);
          this.store.saveNode(s.id, next);
          if (next.hash !== n.hash) this.propagateStale(s.id, n.id, s.revision + 1);
          const autoNote =
            freshAuto.length > 0
              ? ` 결과 형태 기반 auto constraint ${freshAuto.length}개 부착.`
              : "";
          return {
            result: {
              verdict,
              failedConstraints: [],
              unverified,
              instruction:
                `통과. 그러나 leaf 자동 확정은 하지 않는다.${autoNote} pf_confirm_leaf(tool, argSpecs)로 확정 신청하라. ` +
                `argSpecs는 마지막 실행 인자 키를 모두 분류(fixed/var/generated)해야 하며 누락 시 bad_request.`,
            },
            summary: `report ${n.id} pass`,
          };
        }
        // fail → 재시도 경계 (M1.5-6)
        const { status, retries } = consumeRetry(n, s.limits);
        const next: Node = {
          ...n,
          status,
          retries,
          // M7-ui2: 재실행됨 → stale 표시 해제.
          staleSince: undefined,
          suggestedArgs: undefined,
          attempts: [
            ...n.attempts,
            { ...attemptBase, verdict: "fail" as const, failedConstraints },
          ],
        };
        this.store.saveNode(s.id, next);
        return {
          result: {
            verdict,
            failedConstraints,
            unverified,
            instruction:
              status === "needs_human"
                ? `실패(재시도 소진: 총 ${n.attempts.length + 1}회). needs_human. 사유: ${input.selfReason}. pf_advise로 조언을 받거나 pf_split으로 분해하라.`
                : `실패(재시도 ${retries}/${s.limits.maxRetries}). 사유: ${input.selfReason}. 반영해 다시 실행 후 pf_report하라.`,
          },
          summary: `report ${n.id} fail`,
        };
      },
    );
    return {
      ...c.result,
      revision: c.revision,
      changedNodeIds: c.changedNodeIds,
    };
  }

  async pfResolve(input: PfResolveInput): Promise<PfResolveOutput> {
    const c = await this.change<
      Omit<PfResolveOutput, "revision" | "changedNodeIds">
    >(
      input.sessionId,
      {
        method: "pfResolve",
        expectedRevision: input.expectedRevision,
        actor: input.actor,
      },
      () => {
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
              return {
                result: {
                  node: next,
                  instruction: `dry-run 계획을 저장했다. pf_approve로 승인/거부를 받아라.`,
                },
                summary: `ask_human ${n.id} plan`,
              };
            }
            const next = { ...n, status: "needs_human" as const };
            this.store.saveNode(s.id, next);
            return {
              result: {
                node: next,
                instruction: `노드 ${n.id}를 needs_human으로 전환했다. pf_advise를 기다려라.`,
              },
              summary: `ask_human ${n.id}`,
            };
          }
          case "retry": {
            if (n.locked) throw err("conflict", "locked");
            const { status, retries } = consumeRetry(n, s.limits);
            const next = { ...n, status, retries };
            this.store.saveNode(s.id, next);
            return {
              result: {
                node: next,
                instruction:
                  status === "needs_human"
                    ? "재시도 한도 초과로 needs_human."
                    : `재시도 ${retries}/${s.limits.maxRetries}. 실행 후 pf_report.`,
              },
              summary: `retry ${n.id} ${status}`,
            };
          }
          case "split": {
            if (n.locked)
              throw err("conflict", `locked node ${n.id} cannot be split`);
            // M5.5-1: map 노드는 분해 불가 (템플릿 인라인)
            // M5.5-2: until 노드는 분해 불가 (본문 1개 고정)
            if ((n as { kind?: string }).kind === "map")
              throw err("bad_request", `map 노드는 분해 불가: ${n.id}`);
            if ((n as { kind?: string }).kind === "until")
              throw err("bad_request", `until 노드는 분해 불가: ${n.id}`);
            // M8-ui1: 분해 사유·대안 (core는 optional — import·fixture 호환).
            // 길이·개수 검증은 core가 단일 기준으로 삼는다.
            const reason = input.reason?.trim();
            if (reason !== undefined && (reason.length < 10 || reason.length > 1000))
              throw pfError(
                "bad_request",
                `reason은 10~1000자여야 한다 (현재 ${reason.length}자).`,
                "왜 이렇게 나눴는지 10자 이상으로 설명해라.",
              );
            const alternatives = (input.alternatives ?? []).map((a) => a.trim());
            if (alternatives.length > 3)
              throw pfError(
                "bad_request",
                `alternatives는 최대 3개다 (현재 ${alternatives.length}개).`,
                "버린 대안은 3개까지만 적어라.",
              );
            for (const a of alternatives)
              if (a.length === 0 || a.length > 300)
                throw pfError(
                  "bad_request",
                  "alternatives 항목은 1~300자여야 한다.",
                  "대안 설명을 300자 이내로 줄여라.",
                );
            const all = [...this.store.getNodes(s.id).values()];
            if (
              all.some(
                (x) => x.locked && x.id !== n.id && x.id.startsWith(n.id + "."),
              )
            )
              throw err("conflict", "ancestor of locked node");
            if (!input.children || input.children.length === 0)
              throw err("bad_request", "split requires children");
            if (n.depth + 1 > s.limits.maxDepth) {
              const next = { ...n, status: "needs_human" as const };
              this.store.saveNode(s.id, next);
              return {
                result: {
                  node: next,
                  instruction: `분해 깊이가 maxDepth(${s.limits.maxDepth})를 초과해 needs_human으로 전환했다.`,
                },
                summary: `split ${n.id} maxdepth`,
              };
            }
            if (all.length + input.children.length > s.limits.maxNodes)
              throw err("bad_request", "maxNodes exceeded");
            // M3.4.4-3: 자식 dependsOn은 기존 노드 또는 같은 요청의 형제만 허용
            {
              const siblingIds = new Set(
                input.children.map((_, i) => `${n.id}.${i + 1}`),
              );
              const existing = new Set(all.map((x) => x.id));
              for (const c of input.children) {
                for (const d of c.dependsOn ?? []) {
                  if (!existing.has(d) && !siblingIds.has(d)) {
                    throw err(
                      "bad_request",
                      `dep_missing: unknown dependsOn ${d}. 기존 노드 또는 형제만 지정하라.`,
                    );
                  }
                }
              }
            }
            // M3.4.3-2: 펼친 그래프 기준 순환이면 분해 거부 (저장 전)
            {
              const tentative = new Map(
                all.map((x) => [x.id, { ...x } as Node]),
              );
              input.children.forEach((c, i) => {
                const id = `${n.id}.${i + 1}`;
                tentative.set(id, {
                  id,
                  parentId: n.id,
                  dependsOn: c.dependsOn ?? [],
                  children: [],
                  status: "open",
                } as unknown as Node);
              });
              const parentAsSplit = {
                ...n,
                status: "split" as const,
                children: input.children.map((_, i) => `${n.id}.${i + 1}`),
              };
              tentative.set(n.id, parentAsSplit);
              if (hasCycle([...tentative.values()]))
                throw err("bad_request", "split creates dependency cycle");
              for (const c of input.children.map(
                (_, i) => `${n.id}.${i + 1}`,
              )) {
                if (hasLineageDep(tentative.get(c)!, tentative))
                  throw err(
                    "bad_request",
                    "split creates dependency cycle (lineage)",
                  );
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
            const withHashes = created.map((c) => ({
              ...c,
              hash: this.hashFor(s.id, c, base),
            }));
            for (const h of withHashes) this.store.saveNode(s.id, h);
            const next: Node = {
              ...n,
              status: "split",
              // M8-1-0: 재검증 대기 중 분해하면 재검증 표시는 더 이상 유효하지 않다.
              reverifySince: undefined,
              children: withHashes.map((c) => c.id),
              // M8-ui1: 분해 사유를 부모 노드에 남긴다 (hash 계산 대상 아님 —
              // computeNodeHash는 goal/args/constraints/dependsOn만 본다).
              ...(reason !== undefined ? { splitReason: reason } : {}),
            };
            next.hash = this.hashFor(s.id, next);
            this.store.saveNode(s.id, next);
            this.propagateStale(s.id, n.id, s.revision + 1);
            // M8-ui1: 이번 분해를 요구한 조언 (직전 split/report 이후 등록분).
            const cause = this.causeAdviceFor(s.id, n.id);
            // M5.8.1-4(a): 형제 2개 이상인데 ref/dependsOn 전부 비어 있으면 경고.
            const depWarn =
              withHashes.length >= 2 &&
              withHashes.every((c) => c.dependsOn.length === 0)
                ? ` 경고: 의존 없음 — 형제 ${withHashes.length}개 전부 dependsOn 비어 있음. 데이터 흐름이 있으면 pf_edit_node로 dependsOn을 연결하라.`
                : "";
            return {
              result: {
                node: next,
                created: withHashes,
                instruction: `분해 완료. 자식 ${withHashes.length}개를 순서대로 pf_next로 처리하라.${depWarn}`,
              },
              summary: `split ${n.id} +${withHashes.length}`,
              detail: {
                parentId: n.id,
                childIds: withHashes.map((c) => c.id),
                ...(reason !== undefined ? { reason } : {}),
                ...(alternatives.length > 0 ? { alternatives } : {}),
                ...(cause.ids.length > 0
                  ? { causeAdviseIds: cause.ids, causeAdvice: cause.copies }
                  : {}),
              },
            };
          }
          case "leaf": {
            // M1.5-1: leaf 확정은 여기서만. pass여도 report에서 자동 확정 없음.
            if (n.locked) throw err("conflict", `node ${n.id} is locked`);
            if (
              n.status !== "probing" &&
              n.status !== "open" &&
              n.status !== "needs_reverify"
            )
              throw err(
                "conflict",
                `node ${n.id} is not resolvable (${n.status})`,
              );
            if (!input.tool) throw err("bad_request", "leaf requires tool");
            const cat = s.toolCatalog.find(
              (t) =>
                t.server === input.tool!.server && t.name === input.tool!.name,
            );
            if (!cat) throw err("bad_request", "unknown tool");
            // M5.8.1-1: runner 실행 가능 집합 소속 판정 (집합 계산은 LocalServices,
            // 판정은 core. R1~R4: server/App에 판단 if 금지).
            if (
              input.runnableTools !== undefined &&
              !input.runnableTools.includes(
                `${input.tool!.server}/${input.tool!.name}`,
              )
            ) {
              throw err(
                "bad_request",
                `runner에서 실행할 수 없음: ${input.tool!.server}/${input.tool!.name}. ` +
                  `대안: MCP 도구로 다시 확정하거나 kind:"script"로 확정하라 ` +
                  `(bash로 실행한 내용은 scripts/<노드>.py|mjs로 옮겨라).`,
              );
            }
            // M5.8.1-1: 경로 역할(in/out/inout) 확정 시 검증. 명령 문자열은 경로가
            // 아니다 — 키가 command/script/code 계열이거나 값에 공백·셸 메타문자가
            // 있으면 거부 (fixed만 검사. var 참조의 $ 등은 제외).
            for (const [k, spec] of Object.entries(input.argSpecs ?? {})) {
              const ps = spec as {
                kind?: string;
                path?: string;
                value?: unknown;
              };
              if (
                ps.kind === "fixed" &&
                (ps.path === "in" || ps.path === "out" || ps.path === "inout")
              ) {
                const keyFam = /(^|[_-])(command|script|code)$/i.test(k);
                const badVal =
                  typeof ps.value === "string" &&
                  /[ \t\n\r|&;<>()$`'"\\*?!#~]/.test(ps.value);
                if (keyFam || badVal) {
                  throw err(
                    "bad_request",
                    `argSpecs 경로 역할 부적합: ${k} (path:"${ps.path}"). ` +
                      `명령 문자열은 경로가 아니다. kind:"script"로 확정하라 (scripts/<노드>.py|mjs).`,
                  );
                }
              }
            }
            const last = n.attempts[n.attempts.length - 1];
            // M2.6-4: external은 승인된 dry-run 계획으로만 확정 (실행 없음)
            const isApprovedExternalPlan =
              n.sideEffect === "external" &&
              n.approval !== undefined &&
              last !== undefined &&
              last.verdict === undefined;
            if (!isApprovedExternalPlan) {
              if (!last || last.verdict !== "pass")
                throw err(
                  "conflict",
                  "leaf requires passing attempt. report first.",
                );
            }
            // M8-1-0: 재검증 이후의 attempt만 재확정에 쓸 수 있다.
            if (n.reverifySince) {
              if (
                last!.revision === undefined ||
                last!.revision <= n.reverifySince.revision
              )
                throw err(
                  "bad_request",
                  `재검증 필요: 새 pf_report 후 confirm (attempt ${last!.id}는 재검증 이전 것이다).`,
                );
            }
            if (
              last!.tool.server !== input.tool.server ||
              last!.tool.name !== input.tool.name
            )
              throw err(
                "bad_request",
                `leaf tool must match last attempt (${last!.tool.server}/${last!.tool.name})`,
              );
            if (!input.argSpecs)
              throw err("bad_request", "leaf requires argSpecs");
            const missing = Object.keys(last.args).filter(
              (k) => !(k in input.argSpecs!),
            );
            if (missing.length > 0)
              throw err(
                "bad_request",
                `argSpecs missing: ${missing.join(",")}`,
              );
            // M3.4.3-4: additionalProperties:false 스키마는 등록 외 키 거부 (공용 검사)
            const { unknownKeys, suggestions } = checkUnknownKeys(
              Object.keys(input.argSpecs),
              cat.inputSchema,
            );
            if (unknownKeys.length > 0) {
              const hints = unknownKeys.map((k) =>
                suggestions[k]?.length
                  ? `${k} (유사: ${suggestions[k].join(", ")})`
                  : k,
              );
              throw err(
                "bad_args",
                `argSpecs unknown: ${hints.join("; ")}. 등록된 인자만 사용하라.`,
              );
            }
            const warnings: string[] = [];
            // M5.8.2 후속: probing 대조는 LocalServices가 수행, core는 규칙 적용.
            // mismatch → 거부, unverifiable → 경고 (strict면 거부).
            for (const c of (
              input as {
                refCheck?: {
                  key: string;
                  verdict: string;
                  probing?: string;
                  resolved?: string;
                }[];
              }
            ).refCheck ?? []) {
              if (c.verdict === "mismatch") {
                throw err(
                  "bad_request",
                  `probing 인자가 ref 해석값과 다름: ${n.id}.${c.key} ` +
                    `(probing=${c.probing ?? "-"} 해석=${c.resolved ?? "-"}). ` +
                    `probing에 ref 해석값을 그대로 쓰라.`,
                );
              }
            }
            {
              const unv = (
                (input as { refCheck?: { key: string; verdict: string }[] })
                  .refCheck ?? []
              ).filter((c) => c.verdict === "unverifiable");
              if (unv.length > 0) {
                if ((input as { strict?: unknown }).strict === true) {
                  throw err(
                    "bad_request",
                    `ref 검증 불가: ${unv.map((c) => `${n.id}.${c.key}`).join(", ")} (상류 resultJson 없음)`,
                  );
                }
                warnings.push(
                  `검증 불가: ${unv.map((c) => `${n.id}.${c.key}`).join(", ")} (상류 resultJson 없음)`,
                );
              }
            }
            // M5.3-0-4: 증거 없는 leaf 경고. attempt에 결과물(artifact)이 하나도
            // 없으면 호스트 주장(resultSummary)만으로 확정하는 셈이므로 경고한다
            // (거부 아님). resultJson은 저장되지 않아 증거로 쓸 수 없다 (DECISIONS).
            {
              const hasArtifacts =
                ((last?.artifacts ?? []) as unknown[]).length > 0;
              if (!hasArtifacts)
                warnings.push(
                  `증거 없음: 결과물(artifact) 없이 확정 (${input.tool!.server}/${input.tool!.name}) — 가짜 leaf 주의`,
                );
            }
            // M5.3-0-1: required 키 강제 (누락 → bad_request + 목록).
            // 스키마에 required가 없으면 확정 시 경고 (검증 불가).
            const required = readSchemaProps(cat.inputSchema).required ?? [];
            const missingRequired = required.filter(
              (r) => !(r in input.argSpecs!),
            );
            if (missingRequired.length > 0)
              throw err(
                "bad_request",
                `argSpecs missing required: ${missingRequired.join(",")}`,
              );
            if (required.length === 0)
              warnings.push(
                `스키마 required 없음 (${input.tool!.server}/${input.tool!.name}) — 필수 인자 검증 불가`,
              );
            for (const [k, spec] of Object.entries(input.argSpecs)) {
              if (spec.kind === "fixed") {
                const v = (spec as { value: unknown }).value;
                if (
                  typeof v === "string" &&
                  Object.values(s.params).includes(v)
                )
                  warnings.push(
                    `arg ${k} 값 "${v}"이 params와 동일 — var(${"${params.*"}) 후보`,
                  );
              }
            }
            // M3.6-5: dependsOn 중 var/generated 어디에서도 참조되지 않으면 경고 (에러 아님)
            {
              const referenced = new Set<string>();
              // M5.5-1: map over 대상도 데이터 흐름으로 인정
              const mapOver = (n as { map?: { over?: unknown } }).map?.over;
              if (typeof mapOver === "string") {
                const oid = varRefNodeId(mapOver);
                if (oid)
                  for (const a of selfAndAncestors(oid)) referenced.add(a);
              }
              for (const spec of Object.values(input.argSpecs)) {
                if (spec.kind === "var") {
                  const id = varRefNodeId((spec as { ref: string }).ref);
                  if (id)
                    for (const a of selfAndAncestors(id)) referenced.add(a);
                } else if (spec.kind === "generated") {
                  for (const inp of (spec as { inputs?: string[] }).inputs ??
                    []) {
                    if (/^\d+(\.\d+)*$/.test(inp))
                      for (const a of selfAndAncestors(inp)) referenced.add(a);
                    else referenced.add(inp);
                  }
                }
              }
              for (const d of n.dependsOn) {
                if (!referenced.has(d))
                  warnings.push(
                    `dep_without_dataflow: ${d} (어느 var/generated 인자에서도 참조되지 않음)`,
                  );
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
              // M8-1-0: 재확정으로 재검증·stale 표시를 모두 해제한다.
              reverifySince: undefined,
              staleSince: undefined,
              tool: {
                server: input.tool.server,
                name: input.tool.name,
                schemaHash: cat.schemaHash,
              },
              args: input.argSpecs,
              attempts,
              // M3.6-4: golden 출력 안의 params 값은 자리표시자로 저장 (재바인딩 대비)
              // M5.3.1-4: golden.output은 녹화 원문 그대로 (템플릿 치환 금지, replay 전용).
              golden: {
                fixtures: [...finalArtifacts],
                output: last!.resultSummary,
                attemptId: last!.id,
                ignore: input.goldenIgnore ?? [],
              },
            };
            if (input.sideEffect) next.sideEffect = input.sideEffect;
            next.hash = this.hashFor(s.id, next);
            this.store.saveNode(s.id, next);
            this.propagateStale(s.id, n.id, s.revision + 1);
            return {
              result: {
                node: next,
                // 경고가 있어도 다음 도구 언급 유지 (기계 추종 계약: pf_next).
                instruction:
                  warnings.length > 0
                    ? `leaf 확정. 경고: ${warnings.join("; ")}. pf_next로 계속하라.`
                    : `leaf 확정. pf_next로 계속하라.`,
              },
              summary: `leaf ${n.id} ${input.tool.server}/${input.tool.name}`,
            };
          }
        }
      },
    );
    return {
      ...c.result,
      revision: c.revision,
      changedNodeIds: c.changedNodeIds,
    };
  }

  async pfAdvise(input: PfAdviseInput): Promise<PfAdviseOutput> {
    const c = await this.change<
      Omit<PfAdviseOutput, "revision" | "changedNodeIds">
    >(
      input.sessionId,
      {
        method: "pfAdvise",
        expectedRevision: input.expectedRevision,
        actor: input.actor,
      },
      () => {
        const s = this.sess(input.sessionId);
        const n = this.node(input.sessionId, input.nodeId);
        // M8-1-0: 잠긴 **확정 leaf**에 대한 쓰기는 거절한다(재검증 전이 대상).
        // non-leaf(잠긴 split 등)의 조언 거부는 M8-1-0 이전 동작을 그대로 둔다 —
        // 범위를 넓히면 기존 경로(잠긴 split에 의견)가 바뀐다.
        if (n.locked && n.status === "leaf")
          throw err("conflict", `node ${n.id} is locked`);
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
              rejected.push({
                proposal: p,
                reason: `형식 오류: ${parsed.error.issues[0]?.message ?? "invalid"}`,
              });
              continue;
            }
            const c = parsed.data;
            if (c.kind === "llm_rubric") {
              rejected.push({
                proposal: p,
                reason: "llm_rubric은 제안 불가 (자동 판정 불가)",
              });
              continue;
            }
            try {
              const r = this.evaluate([c], {
                resultSummary: last?.resultSummary,
                resultJson,
                artifacts: fx,
              });
              if (r.unverified && r.unverified.length > 0) {
                rejected.push({
                  proposal: p,
                  reason: "판정 불가 (runner 위임 항목 포함)",
                });
                continue;
              }
              adopted.push({
                ...c,
                source: "human",
                note: c.note ?? input.text,
              });
            } catch (e) {
              rejected.push({
                proposal: p,
                reason: e instanceof Error ? e.message : String(e),
              });
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
              ` 금액 비교가 필요하면 numeric_match(expected=$<노드>.<필드> 또는 \${params.x}, tolerance)를 ` +
              `proposedConstraints로 제안하라 (runner에서 판정).`;
          }
        }
        const next: Node = {
          ...n,
          constraints: [...n.constraints, ...constraints],
          advice: [
            ...n.advice,
            {
              at: new Date().toISOString(),
              text: input.text,
              // M8-ui1: 조언 id·revision (분해 reason의 causeAdviseIds 연결용)
              id: randomUUID(),
              revision: s.revision + 1,
            },
          ],
          status: n.status === "needs_human" ? "open" : n.status,
        };
        const oldHash = n.hash;
        next.hash = this.hashFor(s.id, next);
        const saved = this.withLeafReverify(n, next, "advise", s.revision + 1);
        this.store.saveNode(s.id, saved);
if (oldHash !== saved.hash) this.propagateStale(s.id, input.nodeId, s.revision + 1);
        const node = this.node(input.sessionId, input.nodeId);
        return {
          result: {
            constraints,
            rejected,
            node,
            ...(suggestNote ? { note: suggestNote } : {}),
          },
          summary: `advise ${input.nodeId} +${constraints.length}`,
        };
      },
    );
    return {
      ...c.result,
      revision: c.revision,
      changedNodeIds: c.changedNodeIds,
    };
  }

  /** 확정 인자 수정 (M4.2-2). leaf는 open으로, 수정분을 suggestedArgs에 저장 */
  async pfEditArgs(
    input: PfEditArgsInput,
  ): Promise<{ node: Node; instruction: string } & ChangeMeta> {
    const c = await this.change(
      input.sessionId,
      {
        method: "pfEditArgs",
        expectedRevision: input.expectedRevision,
        actor: input.actor,
      },
      () => {
        const s = this.sess(input.sessionId);
        const n = this.node(input.sessionId, input.nodeId);
        if (n.locked) throw err("conflict", `node ${n.id} is locked`);
        if (!n.args)
          throw err(
            "bad_request",
            `node ${n.id}에 확정된 인자가 없어 수정 불가. pf_confirm_leaf 먼저.`,
          );
        const set = input.patch.set ?? {};
        for (const [k, spec] of Object.entries(set)) {
          if (
            !spec ||
            (spec.kind !== "fixed" &&
              spec.kind !== "var" &&
              spec.kind !== "generated" &&
              spec.kind !== "script")
          ) {
            throw err("bad_request", `bad patch spec: ${k}`);
          }
        }
        const remove = new Set(input.patch.remove ?? []);
        if (Object.keys(set).length === 0 && remove.size === 0) {
          throw err(
            "bad_request",
            "변경 없음 (patch.set/remove 중 하나 필요).",
          );
        }
        const merged: Record<string, ArgSpec> = {};
        for (const [k, spec] of Object.entries(n.args)) {
          if (!remove.has(k)) merged[k] = spec;
        }
        Object.assign(merged, set);
        const cat = s.toolCatalog.find(
          (t) => t.server === n.tool?.server && t.name === n.tool?.name,
        );
        if (!n.tool || !cat)
          throw err(
            "bad_request",
            `node ${n.id}의 도구를 카탈로그에서 찾을 수 없어 검증 불가.`,
          );
        const problem = checkFixedAgainstInputSchema(merged, cat.inputSchema);
        if (problem) throw err("bad_request", problem);
        const next: Node = {
          ...n,
          args: merged,
          suggestedArgs: merged,
        };
        next.hash = this.hashFor(s.id, next);
        const saved = this.withLeafReverify(n, next, "edit_args", s.revision + 1);
        this.store.saveNode(s.id, saved);
        this.propagateStale(s.id, n.id, s.revision + 1);
        return {
          result: {
            node: saved,
            instruction: `인자 수정됨. pf_next로 계속하라.`,
          },
          summary: `editArgs ${n.id}`,
        };
      },
    );
    return {
      ...c.result,
      revision: c.revision,
      changedNodeIds: c.changedNodeIds,
    };
  }

  /**
 * M7-ui4: 편집 미리보기 (읽기 전용·커밋 없음).
 * pfEditArgs/pfEditNode와 **같은 검증·해시 규칙**을 쓰되, 노드 사본에
 * 대해서만 계산하고 저장소에는 아무것도 쓰지 않는다 (propagateStale의
 * dry-run). "이 변경으로 다시 실행될 노드"를 UI에 알려주기 위한 API.
 */
  async previewEdit(input: PreviewEditInput): Promise<{
    wouldStale: string[];
    newHash: string;
    revision: number;
    /** M8-1-0: 대상이 leaf이고 hash가 바뀌면 재검증 대상이 된다. */
    selfReverify: boolean;
  }> {
    // 읽기 전용 확인 (touch 없음) — 여기서 상태가 바뀌면 안 된다.
    const s = this.checkFreshRead(input.sessionId);
    const n = this.node(input.sessionId, input.nodeId);
    if (n.locked) throw err("conflict", `node ${n.id} is locked`);
    // M7-ui4-f: pfEditNode와 **같은 순수 함수**로 검증·적용한다.
    const applied = applyEdit(
      n,
      input.change as EditChange,
      {
        toolCatalog: s.toolCatalog,
        fail: (m: string) => {
          throw err("bad_request", m);
        },
      },
    );
    const next: Node = applied.next;
    // 2) 대상 해시 + stale 전파를 **사본 그래프에서** 계산한다.
    const byId = new Map<string, Node>();
    for (const m of this.store.getNodes(input.sessionId).values()) {
      byId.set(m.id, m);
    }
    const nextHash = this.hashFor(input.sessionId, next, byId);
    byId.set(next.id, { ...next, hash: nextHash });
    const wouldStale: string[] = [];
    if (nextHash !== n.hash) {
      const queue = [n.id];
      const seen = new Set<string>([n.id]);
      while (queue.length > 0) {
        const cur = queue.shift() as string;
        for (const m of [...byId.values()]) {
          if (m.id === cur || seen.has(m.id)) continue;
          if (!effectiveDeps(m, byId).includes(cur)) continue;
          seen.add(m.id);
          const mh = this.hashFor(input.sessionId, m, byId);
          if (mh === m.hash) continue;
          wouldStale.push(m.id);
          byId.set(m.id, { ...m, hash: mh });
          queue.push(m.id);
        }
      }
    }
    wouldStale.sort(compareNodeIds);
    return {
      wouldStale,
      newHash: nextHash,
      revision: s.revision,
      selfReverify: n.status === "leaf" && nextHash !== n.hash,
    };
  }

  /** 목표·검사 조건 직접 수정 (M4.2-2) */
  async pfEditNode(
    input: PfEditNodeInput,
  ): Promise<{ node: Node; instruction: string } & ChangeMeta> {
    const c = await this.change(
      input.sessionId,
      {
        method: "pfEditNode",
        expectedRevision: input.expectedRevision,
        actor: input.actor,
      },
      () => {
        const s = this.sess(input.sessionId);
        const n = this.node(input.sessionId, input.nodeId);
        if (n.locked) throw err("conflict", `node ${n.id} is locked`);
        const adds = input.addConstraints ?? [];
        const removes = input.removeConstraintIds ?? [];
        const mapChanged = input.map !== undefined;
        const untilChanged = input.until !== undefined;
        const stateChanged = input.stateWrites !== undefined;
        const retryChanged = (input as { retry?: unknown }).retry !== undefined;
        const depChanged = input.dependsOn !== undefined;
        if (
          input.goal === undefined &&
          adds.length === 0 &&
          removes.length === 0 &&
          !mapChanged &&
          !untilChanged &&
          !stateChanged &&
          !retryChanged &&
          !depChanged
        ) {
          throw err(
            "bad_request",
            "변경 없음 (goal/addConstraints/removeConstraintIds/map/until/stateWrites/retry/dependsOn 중 하나 필요).",
          );
        }
        // M7-ui4-f: previewEdit와 **같은 순수 함수**로 검증·적용한다
        // (goal 상한·trim·중복 constraint까지 미리보기와 결과가 같아야 한다).
        // map/until/stateWrites/retry 만 주는 편집은 이 함수가 모르는 필드라
        // 대상만 그대로 통과시킨다 (없다고 "변경 없음"으로 거절하지 않는다).
        const edited =
          input.goal !== undefined ||
          adds.length > 0 ||
          removes.length > 0 ||
          depChanged
            ? applyEdit(
                n,
                {
                  ...(input.goal !== undefined ? { goal: input.goal } : {}),
                  ...(adds.length > 0 ? { addConstraints: adds } : {}),
                  ...(removes.length > 0 ? { removeConstraintIds: removes } : {}),
                  ...(depChanged ? { dependsOn: input.dependsOn } : {}),
                },
                {
                  fail: (m: string) => {
                    throw err("bad_request", m);
                  },
                },
              )
            : { next: n, changed: false };
        const constraints = edited.next.constraints;
        const goalChanged = edited.next.goal !== n.goal;
        const status = edited.next.status;
        // M5.5-1: map 실행 명세 설정 (kind:"map" 동반).
        let kind = (n as { kind?: string }).kind;
        let mapSpec = (n as { map?: unknown }).map;
        if (mapChanged) {
          const parsed = MapSpecSchema.safeParse(input.map);
          if (!parsed.success)
            throw err(
              "bad_request",
              `bad map: ${parsed.error.issues[0]?.message ?? "invalid"}`,
            );
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(parsed.data.as)) {
            throw err(
              "bad_request",
              `bad map.as: ${parsed.data.as} (영문·숫자·밑줄)`,
            );
          }
          if (
            parsed.data.policy.kind === "threshold" &&
            parsed.data.policy.ratio === undefined
          ) {
            throw err("bad_request", "map threshold 정책은 ratio 필요 (0~1)");
          }
          if (Array.isArray(n.children) && n.children.length > 0) {
            throw err(
              "bad_request",
              `map 노드는 자식을 가질 수 없음: ${n.id} (템플릿은 인라인)`,
            );
          }
          kind = "map";
          mapSpec = parsed.data;
        }
        // M5.5-2: until 실행 명세 설정 (kind:"until" 동반, 트리 자식 없음)
        let untilSpec = (n as { until?: unknown }).until;
        if (untilChanged) {
          const parsed = UntilSpecSchema.safeParse(input.until);
          if (!parsed.success)
            throw err(
              "bad_request",
              `bad until: ${parsed.error.issues[0]?.message ?? "invalid"}`,
            );
          if (
            parsed.data.carry !== undefined &&
            !/^\$self\.[A-Za-z0-9_.-]+$/.test(parsed.data.carry)
          ) {
            throw err(
              "bad_request",
              `bad until.carry: ${parsed.data.carry} ("$self.경로" 형태)`,
            );
          }
          if (Array.isArray(n.children) && n.children.length > 0) {
            throw err(
              "bad_request",
              `until 노드는 자식을 가질 수 없음: ${n.id} (템플릿은 인라인)`,
            );
          }
          if (kind !== undefined && kind !== "until")
            throw err("bad_request", `map/until 중복 불가: ${n.id}`);
          kind = "until";
          untilSpec = parsed.data;
        }
        // M5.5-3: stateWrites 선언
        let stateWritesSpec = (n as { stateWrites?: unknown }).stateWrites;
        if (stateChanged) {
          const sw = input.stateWrites;
          if (!Array.isArray(sw))
            throw err("bad_request", "bad stateWrites: 배열 필요");
          for (const e of sw) {
            const ee = e as { key?: unknown; from?: unknown };
            if (
              typeof ee?.key !== "string" ||
              ee.key.length === 0 ||
              typeof ee?.from !== "string" ||
              ee.from.length === 0
            ) {
              throw err(
                "bad_request",
                "bad stateWrites: {key, from} 비어 있음",
              );
            }
            if (!(ee.from as string).startsWith("$")) {
              throw err(
                "bad_request",
                `bad stateWrites.from: ${ee.from} ($ 참조 필요)`,
              );
            }
          }
          stateWritesSpec = sw;
        }
        // M5.7-3: script 재시도 선언 (멱등 opt-in, 1..10).
        let retrySpec = (n as { retry?: unknown }).retry as
          { attempts?: unknown } | undefined;
        if (retryChanged) {
          const ra = (input as { retry?: { attempts?: unknown } }).retry
            ?.attempts;
          if (
            !Number.isInteger(ra) ||
            (ra as number) < 1 ||
            (ra as number) > 10
          ) {
            throw err("bad_request", "bad retry: attempts 1..10 정수 필요");
          }
          retrySpec = { attempts: ra as number };
        }
        const next: Node = {
          ...n,
          goal: input.goal ?? n.goal,
          constraints,
          status,
        };
        // M5.8.1-4(b): dependsOn 사후 편집. 기존 노드만, 자기 참조·순환 거부.
        // 해시 재계산 + propagateStale은 아래 공용 경로 (revision 증가 포함).
        if (depChanged) {
          const deps = input.dependsOn as unknown;
          if (
            !Array.isArray(deps) ||
            deps.some((d) => typeof d !== "string" || d.length === 0)
          ) {
            throw err("bad_request", "bad dependsOn: 문자열 배열 필요");
          }
          if ((deps as string[]).includes(n.id))
            throw err("bad_request", `bad dependsOn: 자기 참조 ${n.id}`);
          const all = [...this.store.getNodes(s.id).values()];
          const existing = new Set(all.map((x) => x.id));
          const missing = (deps as string[]).filter((d) => !existing.has(d));
          if (missing.length > 0) {
            throw err(
              "bad_request",
              `dep_missing: unknown dependsOn ${missing.join(",")}. 기존 노드만 지정하라.`,
            );
          }
          const tentative = new Map(all.map((x) => [x.id, { ...x } as Node]));
          tentative.set(n.id, {
            ...n,
            dependsOn: [...(deps as string[])],
          } as Node);
          if (hasCycle([...tentative.values()]))
            throw err("bad_request", "dependsOn creates dependency cycle");
          if (hasLineageDep(tentative.get(n.id)!, tentative))
            throw err(
              "bad_request",
              "dependsOn creates dependency cycle (lineage)",
            );
          next.dependsOn = [...(deps as string[])];
        }
        if (kind !== undefined) (next as { kind?: string }).kind = kind;
        if (mapSpec !== undefined) (next as { map?: unknown }).map = mapSpec;
        if (untilSpec !== undefined)
          (next as { until?: unknown }).until = untilSpec;
        if (stateWritesSpec !== undefined)
          (next as { stateWrites?: unknown }).stateWrites = stateWritesSpec;
        if (retrySpec !== undefined)
          (next as { retry?: unknown }).retry = retrySpec;
        next.hash = this.hashFor(s.id, next);
        const saved = this.withLeafReverify(n, next, "edit_node", s.revision + 1);
        this.store.saveNode(s.id, saved);
        this.propagateStale(s.id, n.id, s.revision + 1);
        return {
          result: {
            node: saved,
            instruction: `노드 수정됨. pf_next로 계속하라.`,
          },
          summary: `editNode ${n.id}`,
        };
      },
    );
    return {
      ...c.result,
      revision: c.revision,
      changedNodeIds: c.changedNodeIds,
    };
  }

  /** 카탈로그 저장 (M4.2-2, 수집은 local이 하고 core는 저장만) */
  async pfUpdateCatalog(input: {
    sessionId: string;
    entries: unknown[];
    expectedRevision?: number;
    actor?: Actor;
  }): Promise<ChangeMeta> {
    const c = await this.change(
      input.sessionId,
      {
        method: "pfUpdateCatalog",
        expectedRevision: input.expectedRevision,
        actor: input.actor,
      },
      () => {
        const s = this.sess(input.sessionId);
        if (!Array.isArray(input.entries))
          throw err("bad_request", "entries 배열 필요.");
        const parsed: Session["toolCatalog"] = [];
        for (const e of input.entries) {
          const r = ToolCatalogEntrySchema.safeParse(e);
          if (!r.success)
            throw err(
              "bad_request",
              `bad catalog entry: ${r.error.issues[0]?.message ?? "invalid"}`,
            );
          parsed.push(r.data);
        }
        // M7-ui4-h: 카탈로그 갱신도 쓰기다 — 기준 시각 갱신
        this.store.saveSession({ ...s, toolCatalog: parsed, lastWriteAt: this.nowIso() });
        return {
          result: undefined as void,
          summary: `updateCatalog ${parsed.length}`,
        };
      },
    );
    return { revision: c.revision, changedNodeIds: c.changedNodeIds };
  }

  /** attempt artifacts 교체 (M4.2-1, server 직접 저장 대체) */
  async amendAttemptArtifacts(
    input: AmendAttemptArtifactsInput,
  ): Promise<{ node: Node } & ChangeMeta> {
    const c = await this.change(
      input.sessionId,
      {
        method: "amendAttemptArtifacts",
        expectedRevision: input.expectedRevision,
        actor: input.actor,
      },
      () => {
        const n = this.node(input.sessionId, input.nodeId);
        if (n.locked) throw err("conflict", `node ${n.id} is locked`);
        const idx = n.attempts.findIndex((a) => a.id === input.attemptId);
        if (idx === -1)
          throw err("not_found", `attempt ${input.attemptId} not found`);
        const next: Node = {
          ...n,
          attempts: n.attempts.map((a, i) =>
            i === idx ? { ...a, artifacts: [...input.artifacts] } : a,
          ),
        };
        this.store.saveNode(input.sessionId, next);
        return {
          result: next,
          summary: `amend ${input.nodeId} ${input.attemptId} ${input.artifacts.length}`,
        };
      },
    );
    return {
      node: c.result,
      revision: c.revision,
      changedNodeIds: c.changedNodeIds,
    };
  }

  /** 절차서 import (M6.1-2. CLI·테스트용. 세션 직접 저장의 core 경로) */
  async pfImportProcedure(
    input: PfImportProcedureInput,
  ): Promise<PfImportProcedureOutput> {
    const { session, nodes } = buildImportSession(
      input.doc as ProcedureDoc,
      input.params ?? {},
    );
    // M7-ui4-h: import도 쓰기다 — 기준 시각 심는다
    this.store.saveSession({ ...session, lastWriteAt: this.nowIso() });
    for (const n of nodes) this.store.saveNode(session.id, n);
    return { sessionId: session.id };
  }

  /** golden 쓰기 (M6.1-2. 원격 record 경로. output만 갱신, fixtures는 pf_report 소유) */
  async pfWriteGolden(
    input: PfWriteGoldenInput,
  ): Promise<{ node: Node } & ChangeMeta> {
    const c = await this.change(
      input.sessionId,
      {
        method: "pfWriteGolden",
        expectedRevision: input.expectedRevision,
        actor: input.actor,
      },
      () => {
        const n = this.node(input.sessionId, input.nodeId);
        if (n.locked) throw err("conflict", `node ${n.id} is locked`);
        const next: Node = {
          ...n,
          golden: {
            fixtures: [...input.golden.fixtures],
            output: input.golden.output,
            attemptId: input.golden.attemptId ?? n.golden?.attemptId,
            ignore: input.golden.ignore ?? [],
          },
        };
        next.hash = this.hashFor(input.sessionId, next);
        this.store.saveNode(input.sessionId, next);
        return {
          result: next,
          summary: `write-golden ${input.nodeId}`,
        };
      },
    );
    return {
      node: c.result,
      revision: c.revision,
      changedNodeIds: c.changedNodeIds,
    };
  }

  /** 절차서 문서 조립 (M4.2-1, 읽기 전용. 검증·params 경고 포함) */
  async pfBuildProcedure(
    sessionId: string,
    name: string,
  ): Promise<{ doc: ProcedureDoc; warnings: string[] }> {
    if (!PROCEDURE_NAME_RE.test(name)) {
      throw err(
        "bad_request",
        `bad procedure name: ${name} (소문자·숫자·하이픈, 1~64자)`,
      );
    }
    const session = this.sess(sessionId);
    const nodes = [...this.store.getNodes(sessionId).values()];
    if (nodes.length === 0) throw err("bad_request", "빈 세션");
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // 전 노드 resolved 확인
    const unresolved = nodes
      .filter((n) => !isResolved(n, byId))
      .map((n) => n.id);
    if (unresolved.length > 0) {
      throw err("bad_request", `미해결 노드: ${unresolved.join(", ")}`);
    }
    // M4.1-4: 구조 검증 (10종). 오류 있으면 목록과 함께 거부.
    // M5.8.2 후속: var ref 필드 검증은 App.finalize 사전검사가 담당
    // (core attempt에는 resultJson 실데이터가 없음).
    const violations = validateTree(session, nodes);
    if (violations.length > 0) {
      throw err(
        "bad_request",
        `검증 오류 ${violations.length}건: ${violations.map((v) => `[${v.code}]${v.nodeId ? ` ${v.nodeId}` : ""} ${v.message}`).join("; ")}`,
      );
    }
    // fixed == params 경고 (재사용 깨짐). M4.1-3: 부분 문자열 포함까지 확대
    const warnings: string[] = [];
    const paramEntries = Object.entries(session.params).filter(
      ([, v]) => v.length >= 3,
    );
    for (const n of nodes) {
      if (n.args) {
        for (const [k, spec] of Object.entries(n.args)) {
          const s = spec as ArgSpec;
          if (
            s.kind !== "fixed" ||
            typeof (s as { value: unknown }).value !== "string"
          )
            continue;
          const v = (s as { value: string }).value;
          for (const [pk, pv] of paramEntries) {
            if (v === pv)
              warnings.push(
                `${n.id}.${k}="${v}": params 값과 동일한 fixed (var 후보)`,
              );
            else if (v.includes(pv))
              warnings.push(
                `${n.id}.${k}="${v}": params "${pk}" 값을 부분 포함 (var 후보)`,
              );
          }
        }
      }
      // M5.3.1-4: golden.output은 녹화 원문 그대로 두므로 (replay 전용)
      // params 값 포함 경고를 하지 않는다. 재바인딩 안전은 비교 시점
      // 마스킹 + required params가 담당.
    }
    const doc: ProcedureDoc = {
      format: "procforge-procedure",
      version: 1,
      name,
      sourceSession: sessionId,
      createdAt: new Date().toISOString(),
      params: Object.fromEntries(
        Object.entries(session.params).map(([k, v]) => [
          k,
          { type: "string", default: v, description: "" },
        ]),
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
          kind: (() => {
            const k = (n as { kind?: string }).kind;
            return k === "map" || k === "until"
              ? (k as "map" | "until")
              : undefined;
          })(),
          map: (n as { map?: unknown }).map,
          until: (n as { until?: unknown }).until,
          ...((n as { stateWrites?: { key: string; from: string }[] })
            .stateWrites !== undefined
            ? {
                stateWrites: (
                  n as { stateWrites?: { key: string; from: string }[] }
                ).stateWrites as { key: string; from: string }[],
              }
            : {}),
          // M5.7-3: script 재시도 선언 유지.
          ...((n as { retry?: { attempts: number } }).retry !== undefined
            ? {
                retry: (n as { retry?: { attempts: number } }).retry as {
                  attempts: number;
                },
              }
            : {}),
          sideEffect: n.sideEffect,
          constraints: n.constraints as unknown[],
          golden: n.golden
            ? { ...n.golden, ignore: n.golden.ignore ?? [] }
            : undefined,
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

  /** 세션 조회 (M4.2-2.5, 읽기 전용. TTL 판정, touch 없음 — M7-ui3-b) */
  async getSession(sessionId: string): Promise<Session> {
    return this.checkFreshRead(sessionId);
  }

  /** 노드 조회 (M4.2-2.5, 읽기 전용. touch 없음 — M7-ui2-b) */
  async getNode(sessionId: string, nodeId: string): Promise<Node> {
    this.checkFreshRead(sessionId);
    const n = this.store.getNode(sessionId, nodeId);
    if (!n) throw err("not_found", `node ${nodeId} not found`);
    return n;
  }

  /**
   * M8-ui2: 분해 라운드 이력 (읽기 전용. touch 없음).
   * 분해 이벤트마다 1건. 사유는 detail.reason(없으면 null).
   * parentId·childIds는 detail에 있으면 그것을, 없으면(구 세션) 이벤트 요약에서 복원한다.
   */
  async getDecompositionHistory(input: {
    sessionId: string;
  }): Promise<DecompositionHistoryEntry[]> {
    this.checkFreshRead(input.sessionId);
    const all = this.store.readEvents(input.sessionId);
    const out: DecompositionHistoryEntry[] = [];
    for (const e of all) {
      const round = this.roundOfEvent(e);
      if (round) out.push(round);
    }
    // M8-1-0 보정: 이벤트는 **그 노드를 만든 라운드**에 귀속한다.
    // (예전: "다음 분해 라운드 직전까지"라는 전역 경계 → 나중에 준 의견이 사라졌다)
    // 노드는 다시 나뉘거나 삭제될 때까지 그 라운드에 붙는다.
    const kinds = this.decompositionEventKinds(all);
    // 노드 → 만든 라운드 revision / 그 노드의 마지막 유효 revision(재분해·삭제 전)
    const createdAt = new Map<string, number>();
    for (const r of out) {
      for (const cid of r.childIds) {
        if (!createdAt.has(cid)) createdAt.set(cid, r.revision);
      }
    }
    const endAt = new Map<string, number>();
    for (const e of all) {
      for (const id of e.nodeIds) {
        const start = createdAt.get(id);
        if (start === undefined || e.revision <= start) continue;
        if (endAt.has(id)) continue;
        const reSplit =
          e.method === "pfResolve" && e.detail?.parentId === id;
        const removed = e.detail?.removedIds?.includes(id) === true;
        if (reSplit || removed) endAt.set(id, e.revision);
      }
    }
    for (let i = 0; i < out.length; i++) {
      const round = out[i]!;
      const children = new Set(round.childIds);
      const picked: DecompositionEvent[] = [];
      for (const e of all) {
        if (e.revision <= round.revision) continue;
        const kind = kinds.get(e);
        if (!kind) continue;
        const mine = e.nodeIds.filter((id) => {
          if (!children.has(id)) return false;
          const start = createdAt.get(id);
          if (start === undefined || e.revision <= start) return false;
          const end = endAt.get(id);
          if (end !== undefined && e.revision >= end) return false;
          return true;
        });
        if (mine.length === 0) continue;
        picked.push({
          revision: e.revision,
          at: e.at,
          actor: e.actor,
          method: e.method,
          summary: e.summary,
          kind,
          nodeIds: mine,
        });
      }
      if (picked.length > 0) out[i] = { ...round, events: picked };
    }
    return out;
  }

  /**
   * M8-1-0: 이벤트 1건의 타임라인 분류.
   * needs_reverify → probing 전이가 일어난 이벤트는 "reverify"(재검증)로 본다.
   * (pf_next 경로·pf_report 직접 경로 모두 같은 전이를 쓴다)
   */
  private decompositionEventKinds(
    all: EventEntry[],
  ): Map<EventEntry, DecompositionEvent["kind"]> {
    const out = new Map<EventEntry, DecompositionEvent["kind"]>();
    const statusByNode = new Map<string, string>();
    for (const e of all) {
      let reverify = false;
      for (const id of e.nodeIds) {
        const before = statusByNode.get(id);
        const after = e.detail?.nodesAfter?.find((n) => n.id === id)?.status;
        if (after === undefined || after === null) continue;
        if (before === "needs_reverify" && after === "probing") reverify = true;
        statusByNode.set(id, after);
      }
      const kind = reverify ? "reverify" : this.decompositionEventKind(e);
      if (kind) out.set(e, kind);
    }
    return out;
  }

  /**
   * M8-1-0: 이벤트 종류 (메서드 기준).
   * null = 타임라인에 넣지 않는 이벤트(분해 자체·잠금 등).
   */
  private decompositionEventKind(
    e: EventEntry,
  ): DecompositionEvent["kind"] | null {
    switch (e.method) {
      case "pfAdvise":
        return "advise";
      case "pfReport":
        return "report";
      case "pfResolve":
        return e.summary.startsWith("leaf ") ? "confirm" : null;
      case "pfEditArgs":
      case "pfEditNode":
        return "edit";
      default:
        return null;
    }
  }

  /** 분해 이벤트 1건 → 라운드 1건 (구 이벤트·신 이벤트 모두 처리) */
  private roundOfEvent(e: EventEntry): DecompositionHistoryEntry | null {
    const m = /^split (\S+)/.exec(e.summary);
    const parentId = e.detail?.parentId ?? m?.[1];
    if (!parentId) return null;
    // maxdepth 분해(needs_human 전환)는 라운드가 아니다.
    if (!e.detail?.parentId && e.summary.includes("maxdepth")) return null;
    const parentDepth = parentId.split(".").length - 1;
    const childIds =
      e.detail?.childIds ??
      e.nodeIds
        .filter(
          (id) =>
            id.startsWith(parentId + ".") &&
            id.split(".").length === parentDepth + 2,
        )
        .sort(compareNodeIds);
    // M8-ui2 정정: 노드 id 는 전역 불변식이 아니다 (import 는 임의 id 를 보존).
    // 부모의 그 시점 스냅샷에 depth 가 있으면 그 값을 쓰고, 없을 때만 ID 세그먼트로
    // 되돌린다. 어느 쪽을 썼는지 depthSource 로 드러낸다.
    const parentSnap = e.detail?.nodesAfter?.find((n) => n.id === parentId);
    const depth = parentSnap?.depth ?? parentDepth;
    const depthSource = parentSnap?.depth !== undefined ? "snapshot" : "id";
    return {
      revision: e.revision,
      at: e.at,
      actor: e.actor,
      depth,
      depthSource,
      parentId,
      childIds,
      reason: e.detail?.reason ?? null,
      alternatives: e.detail?.alternatives ?? [],
      causeAdviseIds: e.detail?.causeAdviseIds ?? [],
    };
  }

  /**
   * M8-ui2: 특정 revision 시점 트리 (읽기 전용. touch 없음).
   * 이벤트 detail.nodesAfter(변경분 스냅샷)를 되감아 그 시점 상태를 복원한다.
   * 패치가 없는 구간(구 세션)이 있으면 그 구간은 상태를 확정할 수 없다
   * → structureOnly=true, 해당 노드 상태는 null.
   */
  async getTreeAt(input: {
    sessionId: string;
    revision: number;
  }): Promise<{ nodes: HistoryNode[]; structureOnly: boolean }> {
    const s = this.checkFreshRead(input.sessionId);
    if (input.revision > s.revision)
      throw err(
        "bad_request",
        `revision ${input.revision} is ahead of session revision ${s.revision}`,
      );
    const all = this.store.readEvents(input.sessionId);
    const target = all.filter((e) => e.revision <= input.revision);
    const later = all.filter((e) => e.revision > input.revision);
    // 패치가 없는 이벤트(구 세션)가 하나라도 있으면 그 구간은 상태를 확정할 수 없다.
    let structureOnly = false;
    // 노드가 생성된 revision (분해로 생긴 자식만 revision>0, 나머지는 0).
    const createdAt = new Map<string, number>();
    // 그 시점까지의 마지막 스냅샷.
    const lastPatch = new Map<string, HistoryNode>();
    // 구 이벤트(패치 없음)가 건드린 노드 → 그 시점 상태를 확정할 수 없다.
    const legacyTouched = new Set<string>();
    // 1) 생성 revision은 **전체** 이벤트에서 본다 (미래에 생긴 노드를 걸러야 한다).
    for (const e of all) {
      if (e.detail?.childIds?.length) {
        for (const cid of e.detail.childIds) {
          if (!createdAt.has(cid)) createdAt.set(cid, e.revision);
        }
      } else if (!e.detail) {
        for (const cid of this.legacyChildIdsOf(e)) {
          if (!createdAt.has(cid)) createdAt.set(cid, e.revision);
        }
      }
    }
    // 2) 그 시점까지의 스냅샷을 모은다.
    for (const e of target) {
      const d = e.detail;
      if (!d) {
        // 구 이벤트: 상태 스냅샷이 없다. 구조만 알고, 상태는 아래에서 null 로 둔다.
        // structureOnly 는 "null 상태 노드가 있는가" 로만 정한다 (뒤에서 한 번).
        for (const id of e.nodeIds) legacyTouched.add(id);
        continue;
      }
      for (const n of d.nodesAfter ?? []) lastPatch.set(n.id, n);
      for (const id of d.removedIds ?? []) {
        lastPatch.delete(id);
        createdAt.delete(id);
      }
    }
    const nodes: HistoryNode[] = [];
    for (const n of this.store.getNodes(input.sessionId).values()) {
      const born = createdAt.get(n.id) ?? 0;
      if (born > input.revision) continue; // 아직 존재하지 않던 노드
      const patch = lastPatch.get(n.id);
      if (patch) {
        nodes.push({ ...patch });
        continue;
      }
      if (legacyTouched.has(n.id)) {
        // 구 이벤트만 건드린 노드 → 그 시점 상태를 알 수 없다.
        nodes.push({
          id: n.id,
          parentId: n.parentId,
          goal: null,
          status: null,
          depth: n.depth,
          children: [],
          dependsOn: [],
          locked: false,
          sideEffect: null,
          hash: null,
        });
        continue;
      }
      // 스냅샷이 없는 노드: 그 뒤에 손대지 않았다면 현재 값이 곧 그 시점 값이다.
      const touchedLater = later.some((e) => e.nodeIds.includes(n.id));
      if (touchedLater) {
        nodes.push({
          id: n.id,
          parentId: n.parentId,
          goal: null,
          status: null,
          depth: n.depth,
          children: [],
          dependsOn: [],
          locked: false,
          sideEffect: null,
          hash: null,
        });
        continue;
      }
      nodes.push(this.historyNodeOf(n));
    }
    nodes.sort((a, b) => compareNodeIds(a.id, b.id));
    for (const n of nodes) if (n.status === null) structureOnly = true;
    return { nodes, structureOnly };
  }

  /** 구 분해 이벤트에서 자식 id 목록을 복원 (summary + nodeIds) */
  private legacyChildIdsOf(e: EventEntry): string[] {
    const m = /^split (\S+)/.exec(e.summary);
    if (!m) return [];
    const parentId = m[1];
    const parentDepth = parentId.split(".").length - 1;
    return e.nodeIds
      .filter(
        (id) =>
          id.startsWith(parentId + ".") &&
          id.split(".").length === parentDepth + 2,
      )
      .sort(compareNodeIds);
  }

  /** 세션 목록 (M7-ui1, 읽기 전용. 테넌트 저장소 기준) */
  async getSessions(): Promise<{ sessions: SessionSummary[] }> {
    const sessions = this.store.listSessions().map((s) => {
      const nodes = this.store.getNodes(s.id);
      return {
        sessionId: s.id,
        request: s.request,
        revision: s.revision,
        createdAt: s.createdAt,
        // M7-ui4-a: TTL 기준을 UI에도 보여준다 (로컬 부가정보가 되짚지 않도록).
        lastWriteAt: s.lastWriteAt,
        rootId: s.rootId,
        nodeCount: nodes.size,
        rootStatus: nodes.get(s.rootId)?.status ?? "unknown",
      };
    });
    return { sessions };
  }

  /**
   * 이벤트 페이지 (M7-ui2, 읽기 전용. touch 없음 — M7-ui2-b).
   * pfNext·pfAdvise 등의 **쓰기 메서드가 아니므로** UI가 상태를 바꾸지 않는다.
   * nodeId 지정 시 그 노드가 건드린 이벤트만 (노드 이력 보기, M7-ui3).
   */
  async getEventsPage(input: {
    sessionId: string;
    afterRevision?: number;
    limit?: number;
    nodeId?: string;
    /**
     * M7-ui4-g: true면 **최신** limit건을 준다 (노드 이력용).
     * 기본(false)은 SSE 증분용 — 오래된 것부터 이어 준다.
     * 이력을 "처음 200건"으로 자르면 마지막 사건이 화면에서 사라진다.
     */
    tail?: boolean;
  }): Promise<{ events: EventEntry[]; lastRevision: number }> {
    const s = this.checkFreshRead(input.sessionId);
    const all = this.store.readEvents(input.sessionId);
    const after = input.afterRevision ?? 0;
    const limit = Math.min(input.limit ?? 200, 500);
    const scoped =
      input.nodeId === undefined
        ? all
        : all.filter((e) => e.nodeIds.includes(input.nodeId as string));
    const fresh = scoped.filter((e) => e.revision > after);
    const picked =
      input.tail === true
        ? fresh.slice(Math.max(0, fresh.length - limit))
        : fresh.slice(0, limit);
    const last = all.length === 0 ? 0 : Math.max(...all.map((e) => e.revision));
    return {
      events: picked,
      lastRevision: Math.max(last, picked.at(-1)?.revision ?? s.revision),
    };
  }

  /**
   * blocked·needs_human (M7-ui2, 읽기 전용).
   * pfNext와 같은 계산(ready/deadlock)을 쓰되 승격·상태 변경은 하지 않는다.
   * "읽기 전용" 계약: revision·노드 상태가 바뀌지 않는다 (테스트로 단언).
   */
  async getBlocked(input: { sessionId: string }): Promise<{
    blocked: BlockedEntry[];
    needsHuman: string[];
    revision: number;
  }> {
    const s = this.checkFreshRead(input.sessionId);
    const nodes = [...this.store.getNodes(input.sessionId).values()];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const needsHuman = nodes
      .filter((n) => n.status === "needs_human")
      .sort((a, b) => compareNodeIds(a.id, b.id))
      .map((n) => n.id);
    const stuck = nodes
      .filter(
        (n) =>
          n.status === "open" ||
          n.status === "probing" ||
          n.status === "needs_reverify",
      )
      .sort((a, b) => compareNodeIds(a.id, b.id));
    const ready = nodes.some(
      (n) =>
        (n.status === "open" ||
          n.status === "probing" ||
          n.status === "needs_reverify") &&
        effectiveDeps(n, byId).every((d) => {
          const dep = byId.get(d);
          return dep !== undefined && isResolved(dep, byId);
        }),
    );
    // 진행 가능한 노드가 있으면 교착 아님 (blocked 비움).
    const { blocked } = ready || stuck.length === 0 ? { blocked: [] } : computeDeadlock(stuck, byId);
    return { blocked, needsHuman, revision: s.revision };
  }

  async pfTree(
    sessionId: string,
  ): Promise<{ nodes: Node[]; session: Session }> {
    const s = this.sess(sessionId);
    return {
      session: s,
      nodes: [...this.store.getNodes(sessionId).values()].sort((a, b) =>
        compareNodeIds(a.id, b.id),
      ),
    };
  }

  async pfApprove(input: PfApproveInput): Promise<{ node: Node } & ChangeMeta> {
    const c = await this.change(
      input.sessionId,
      {
        method: "pfApprove",
        expectedRevision: input.expectedRevision,
        actor: input.actor,
      },
      () => {
        const s = this.sess(input.sessionId);
        const n = this.node(input.sessionId, input.nodeId);
        if (n.locked) throw err("conflict", `node ${n.id} is locked`);
        if (n.status !== "needs_human")
          throw err(
            "conflict",
            `node ${n.id} has no pending approval (${n.status})`,
          );
        if (input.approved) {
          const last = n.attempts[n.attempts.length - 1];
          if (!last || last.verdict !== undefined)
            throw err(
              "conflict",
              `node ${n.id} has no dry-run plan to approve. submit plan via ask_human first.`,
            );
          const next: Node = {
            ...n,
            status: "probing",
            // M8-1-0: 승인 시점 hash를 남긴다 — 재확정으로 hash가 바뀌면
            // finalize이 "재승인 필요"로 안내한다.
            approval: {
              at: new Date().toISOString(),
              note: input.note,
              hash: n.hash,
            },
          };
          this.store.saveNode(s.id, next);
          return { result: next, summary: `approve ${input.nodeId} yes` };
        }
        const next: Node = {
          ...n,
          status: "open",
          approval: undefined,
          advice: [
            ...n.advice,
            {
              at: new Date().toISOString(),
              text: input.note ?? "plan rejected",
            },
          ],
        };
        this.store.saveNode(s.id, next);
        return { result: next, summary: `approve ${input.nodeId} no` };
      },
    );
    return {
      node: c.result,
      revision: c.revision,
      changedNodeIds: c.changedNodeIds,
    };
  }

  async pfLock(input: PfLockInput): Promise<{ node: Node } & ChangeMeta> {
    const c = await this.change(
      input.sessionId,
      {
        method: "pfLock",
        expectedRevision: input.expectedRevision,
        actor: input.actor,
      },
      () => {
        const n = this.node(input.sessionId, input.nodeId);
        const next = { ...n, locked: true };
        this.store.saveNode(input.sessionId, next);
        return { result: next, summary: `lock ${input.nodeId}` };
      },
    );
    return {
      node: c.result,
      revision: c.revision,
      changedNodeIds: c.changedNodeIds,
    };
  }

  async pfReopen(input: PfReopenInput): Promise<{ node: Node } & ChangeMeta> {
    const c = await this.change(
      input.sessionId,
      {
        method: "pfReopen",
        expectedRevision: input.expectedRevision,
        actor: input.actor,
      },
      () => {
        const n = this.node(input.sessionId, input.nodeId);
        const next = {
          ...n,
          locked: false,
          status: "open" as const,
          // M8-1-0 보정: 재검증 대기 표시(reverifySince)는 reopen해도 유지한다.
          // 지우면 옛 attempt로 다시 확정할 수 있어 재검증 가드가 뚫린다.
        };
        this.store.saveNode(input.sessionId, next);
        return { result: next, summary: `reopen ${input.nodeId}` };
      },
    );
    return {
      node: c.result,
      revision: c.revision,
      changedNodeIds: c.changedNodeIds,
    };
  }
}

export function createInProcessClient(
  evaluate: EvaluateFn = defaultEvaluate,
): CoreClient {
  const svc = new CoreService(createMemoryStore(), evaluate);
  return svc;
}
