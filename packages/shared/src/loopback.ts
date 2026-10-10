import { z } from "zod";
import type { CoreClient } from "./core-client.js";
import {
  ArgSpecSchema,
  ConstraintSchema,
  NodeIdSchema,
  NodeSchema,
  SessionIdSchema,
  SessionSchema,
  SideEffectSchema,
  ToolCatalogEntrySchema,
  ToolRefSchema,
} from "./schema.js";
import { ActorSchema, EventEntrySchema } from "./dto.js";
import { ProcedureDocSchema } from "./procedure.js";

// Loopback CoreClient (M4.2-4-4). 모든 입출력을 JSON 왕복시킨 뒤 DTO zod로 검증한다.
// M6 HTTP 전환 전 직렬화 가능성·형태 계약을 강제하는 테스트용 클라이언트다.
// 검증 실패는 Error (코드 없음). inner의 ProcForgeError는 그대로 전파한다.

const ChangeMetaSchema = z.object({
  revision: z.number().int().min(0),
  changedNodeIds: z.array(z.string()),
});

const RevActorSchema = z.object({
  expectedRevision: z.number().int().min(0).optional(),
  actor: ActorSchema.optional(),
});

const LimitsSchema = z.object({
  maxDepth: z.number().int().min(1),
  maxRetries: z.number().int().min(0),
  maxNodes: z.number().int().min(1),
});

const BlockedEntrySchema = z.object({
  nodeId: z.string(),
  waitingOn: z.array(z.string()),
  reason: z.enum(["dep_failed", "dep_empty_split", "dep_missing", "dep_pending"]),
});

const ChildSchema = z.object({
  goal: z.string().min(1),
  dependsOn: z.array(z.string()).optional(),
  sideEffect: SideEffectSchema.optional(),
});

const Methods = {
  pfStart: {
    in: z.object({
      request: z.string(),
      params: z.record(z.string()).optional(),
      toolCatalog: z.array(ToolCatalogEntrySchema),
      limits: LimitsSchema.optional(),
      opencodeVersion: z.string().optional(),
    }).passthrough(),
    out: z.object({ session: SessionSchema, node: NodeSchema, instruction: z.string() }).passthrough(),
  },
  pfNext: {
    in: z.object({ sessionId: SessionIdSchema }).merge(RevActorSchema).passthrough(),
    out: z.union([
      z.object({
        done: z.literal(false), node: NodeSchema, blocked: z.array(BlockedEntrySchema).optional(),
        instruction: z.string(), enteredProbing: z.boolean(),
      }).passthrough(),
      z.object({ done: z.literal(true) }).passthrough(),
    ]).and(ChangeMetaSchema),
  },
  pfReport: {
    in: z.object({
      sessionId: SessionIdSchema,
      nodeId: NodeIdSchema,
      tool: ToolRefSchema,
      args: z.record(z.unknown()),
      resultSummary: z.string(),
      resultJson: z.unknown().optional(),
      artifacts: z.array(z.string()).optional(),
      artifactContents: z.record(z.string()).optional(),
      selfVerdict: z.enum(["pass", "fail"]),
      selfReason: z.string(),
      rubricReasons: z.record(z.string()).optional(),
      attemptId: z.string().optional(),
    }).merge(RevActorSchema).passthrough(),
    out: z.object({
      verdict: z.enum(["pass", "fail", "unverifiable"]),
      failedConstraints: z.array(z.string()),
      unverified: z.array(z.string()).optional(),
      instruction: z.string(),
    }).passthrough().and(ChangeMetaSchema),
  },
  pfResolve: {
    in: z.object({
      sessionId: SessionIdSchema,
      nodeId: NodeIdSchema,
      decision: z.enum(["leaf", "split", "retry", "ask_human"]),
      children: z.array(ChildSchema).optional(),
      argSpecs: z.record(ArgSpecSchema).optional(),
      sideEffect: SideEffectSchema.optional(),
      tool: ToolRefSchema.optional(),
      plan: z.object({ tool: ToolRefSchema, args: z.record(z.unknown()) }).optional(),
      note: z.string().optional(),
      goldenIgnore: z.array(z.string()).optional(),
      artifacts: z.array(z.string()).optional(),
    }).merge(RevActorSchema).passthrough(),
    out: z.object({
      node: NodeSchema, created: z.array(NodeSchema).optional(), instruction: z.string(),
    }).passthrough().and(ChangeMetaSchema),
  },
  pfAdvise: {
    in: z.object({
      sessionId: SessionIdSchema,
      nodeId: NodeIdSchema,
      text: z.string(),
      proposedConstraints: z.array(z.unknown()).optional(),
      fixtureContents: z.record(z.string()).optional(),
    }).merge(RevActorSchema).passthrough(),
    out: z.object({
      constraints: z.array(ConstraintSchema),
      rejected: z.array(z.object({ proposal: z.unknown(), reason: z.string() })),
      node: NodeSchema,
      note: z.string().optional(),
    }).passthrough().and(ChangeMetaSchema),
  },
  pfTree: {
    in: z.tuple([SessionIdSchema]),
    out: z.object({ nodes: z.array(NodeSchema), session: SessionSchema }).passthrough(),
  },
  pfLock: {
    in: z.object({ sessionId: SessionIdSchema, nodeId: NodeIdSchema }).merge(RevActorSchema).passthrough(),
    out: z.object({ node: NodeSchema }).passthrough().and(ChangeMetaSchema),
  },
  pfReopen: {
    in: z.object({ sessionId: SessionIdSchema, nodeId: NodeIdSchema, reason: z.string() }).merge(RevActorSchema).passthrough(),
    out: z.object({ node: NodeSchema }).passthrough().and(ChangeMetaSchema),
  },
  amendAttemptArtifacts: {
    in: z.object({
      sessionId: SessionIdSchema, nodeId: NodeIdSchema, attemptId: z.string(), artifacts: z.array(z.string()),
    }).merge(RevActorSchema).passthrough(),
    out: z.object({ node: NodeSchema }).passthrough().and(ChangeMetaSchema),
  },
  pfUpdateCatalog: {
    in: z.object({ sessionId: SessionIdSchema, entries: z.array(z.unknown()) }).merge(RevActorSchema).passthrough(),
    out: ChangeMetaSchema.passthrough(),
  },
  pfEditArgs: {
    in: z.object({
      sessionId: SessionIdSchema,
      nodeId: NodeIdSchema,
      patch: z.object({ set: z.record(ArgSpecSchema).optional(), remove: z.array(z.string()).optional() }),
    }).merge(RevActorSchema).passthrough(),
    out: z.object({ node: NodeSchema, instruction: z.string() }).passthrough().and(ChangeMetaSchema),
  },
  pfEditNode: {
    in: z.object({
      sessionId: SessionIdSchema,
      nodeId: NodeIdSchema,
      goal: z.string().optional(),
      addConstraints: z.array(ConstraintSchema).optional(),
      removeConstraintIds: z.array(z.string()).optional(),
    }).merge(RevActorSchema).passthrough(),
    out: z.object({ node: NodeSchema, instruction: z.string() }).passthrough().and(ChangeMetaSchema),
  },
  getEvents: {
    in: z.union([z.tuple([SessionIdSchema]), z.tuple([SessionIdSchema, z.number().int().min(0)])]),
    out: z.array(EventEntrySchema),
  },
  getSession: {
    in: z.tuple([SessionIdSchema]),
    out: SessionSchema,
  },
  getNode: {
    in: z.tuple([SessionIdSchema, NodeIdSchema]),
    out: NodeSchema,
  },
  pfBuildProcedure: {
    in: z.tuple([SessionIdSchema, z.string()]),
    out: z.object({ doc: ProcedureDocSchema, warnings: z.array(z.string()) }).passthrough(),
  },
  pfApprove: {
    in: z.object({
      sessionId: SessionIdSchema, nodeId: NodeIdSchema, approved: z.boolean(), note: z.string().optional(),
    }).merge(RevActorSchema).passthrough(),
    out: z.object({ node: NodeSchema }).passthrough().and(ChangeMetaSchema),
  },
} as const;

/** JSON 직렬화 불가 값(Map/Set/함수·클래스 인스턴스) 거부 */
function assertJsonable(v: unknown, path = "$"): void {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return;
  if (typeof v !== "object") throw new Error(`loopback: non-JSON value at ${path}`);
  if (Array.isArray(v)) {
    v.forEach((x, i) => assertJsonable(x, `${path}[${i}]`));
    return;
  }
  const proto: unknown = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) throw new Error(`loopback: non-plain object at ${path}`);
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) assertJsonable(x, `${path}.${k}`);
}

function wire<T>(v: T, what: string): T {
  assertJsonable(v, what);
  return JSON.parse(JSON.stringify(v)) as T;
}

function check(schema: z.ZodTypeAny, v: unknown, what: string): unknown {
  const parsed = schema.safeParse(v);
  if (!parsed.success) {
    throw new Error(`loopback ${what} invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

export function createLoopbackClient(inner: CoreClient): CoreClient {
  const wrapObj = async <I, R>(
    method: keyof typeof Methods,
    input: I,
    call: (x: I) => Promise<R>,
  ): Promise<R> => {
    const spec = Methods[method];
    const valid = check(spec.in as z.ZodTypeAny, wire(input, `${method} input`), `${method} input`) as I;
    const out = await call(valid);
    return check(spec.out as z.ZodTypeAny, wire(out, `${method} output`), `${method} output`) as R;
  };
  const wrapArgs = async <A extends unknown[], R>(
    method: keyof typeof Methods,
    args: A,
    call: (a: A) => Promise<R>,
  ): Promise<R> => {
    const spec = Methods[method];
    const valid = check(spec.in as z.ZodTypeAny, wire(args, `${method} input`), `${method} input`) as A;
    const out = await call(valid);
    return check(spec.out as z.ZodTypeAny, wire(out, `${method} output`), `${method} output`) as R;
  };
  return {
    pfStart: (i) => wrapObj("pfStart", i, (x) => inner.pfStart(x)),
    pfNext: (i) => wrapObj("pfNext", i, (x) => inner.pfNext(x)),
    pfReport: (i) => wrapObj("pfReport", i, (x) => inner.pfReport(x)),
    pfResolve: (i) => wrapObj("pfResolve", i, (x) => inner.pfResolve(x)),
    pfAdvise: (i) => wrapObj("pfAdvise", i, (x) => inner.pfAdvise(x)),
    pfTree: (sid) => wrapArgs("pfTree", [sid], ([x]) => inner.pfTree(x)),
    pfLock: (i) => wrapObj("pfLock", i, (x) => inner.pfLock(x)),
    pfReopen: (i) => wrapObj("pfReopen", i, (x) => inner.pfReopen(x)),
    amendAttemptArtifacts: (i) => wrapObj("amendAttemptArtifacts", i, (x) => inner.amendAttemptArtifacts(x)),
    pfUpdateCatalog: (i) => wrapObj("pfUpdateCatalog", i, (x) => inner.pfUpdateCatalog(x)),
    pfEditArgs: (i) => wrapObj("pfEditArgs", i, (x) => inner.pfEditArgs(x)),
    pfEditNode: (i) => wrapObj("pfEditNode", i, (x) => inner.pfEditNode(x)),
    getEvents: (sid, since) => wrapArgs("getEvents", since === undefined ? [sid] : [sid, since], ([a, b]: [string, number?]) => inner.getEvents(a, b)),
    getSession: (sid) => wrapArgs("getSession", [sid], ([x]) => inner.getSession(x)),
    getNode: (sid, nid) => wrapArgs("getNode", [sid, nid], ([a, b]) => inner.getNode(a, b)),
    pfBuildProcedure: (sid, name) => wrapArgs("pfBuildProcedure", [sid, name], ([a, b]) => inner.pfBuildProcedure(a, b)),
    pfApprove: (i) => wrapObj("pfApprove", i, (x) => inner.pfApprove(x)),
  };
}
