import type { Node, Session } from "./schema.js";
import { NodeIdSchema } from "./schema.js";
import { checkUnknownKeys, matchesType, readSchemaProps } from "./args-schema.js";
import { hasCycle } from "./deps.js";

export type ValidationError = {
  code: string;
  nodeId?: string;
  message: string;
};

export type ValidateOptions = {
  outputs?: Record<string, unknown>;
};

function isValidRefSyntax(ref: string): boolean {
  // 허용: ${params.xxx} | ${...} | $<id> | $<id>.<field> (M5.8.2-1)
  // M5.1-B3: 문자열 내 ${params.k} 템플릿도 허용
  if (/^\$\{params\.[A-Za-z0-9_.-]+\}$/.test(ref)) return true;
  if (/^\$\{\}$/.test(ref)) return false;
  const tk = templateParamsKeys(ref);
  if (tk !== null) return tk.length > 0;
  const m = /^\$(\d+(?:\.\d+)*)(.*)$/.exec(ref);
  if (!m) return false;
  const rest = m[2];
  if (rest === "") return true;
  if (rest.startsWith(".output.")) {
    const field = rest.slice(".output.".length);
    return field.length > 0 && /^[A-Za-z0-9_.-]+$/.test(field);
  }
  // M5.2-4 약식 + M5.8.2-1: $<id>.<field>. ".output" 단독도 필드로 취급
  // ("$1.1.output"은 output 필드. 숫자 꼬리는 노드 id로 귀속
  // ("$1.1.2"는 노드 1.1.2. 필드가 숫자면 ".output."을 쓸 것).
  if (/^\.[A-Za-z][A-Za-z0-9_.-]*$/.test(rest)) return true;
  return false;
}

function parseRef(ref: string): { paramsKey?: string; nodeId?: string; fieldPath?: string } | null {
  const pm = /^\$\{params\.([A-Za-z0-9_.-]+)\}$/.exec(ref);
  if (pm) return { paramsKey: pm[1] };
  const m = /^\$(\d+(?:\.\d+)*)(.*)$/.exec(ref);
  if (!m) return null;
  const nodeId = m[1];
  const rest = m[2];
  // M5.8.2-1: "$N"만 전체. ".output" 단독은 output 필드 (약식으로 처리).
  if (rest === "") return { nodeId };
  if (rest.startsWith(".output.")) return { nodeId, fieldPath: rest.slice(".output.".length) };
  if (/^\.[A-Za-z][A-Za-z0-9_.-]*$/.test(rest)) return { nodeId, fieldPath: rest.slice(1) };
  return null;
}

/**
 * M5.1-B3: 문자열 내 `${params.k}` 템플릿에서 참조된 params 키 목록.
 * 템플릿이 아니면 null. `${` 가 있으나 params 형식이 아니면 null이 아니라
 * 빈 배열 아닌 형태로 실패 처리해야 하므로, `${` 포함 + 유효 키 0개면 [] 반환.
 */
export function templateParamsKeys(ref: string): string[] | null {
  if (!ref.includes("${")) return null;
  if (/^\$\{params\.[A-Za-z0-9_.-]+\}$/.test(ref)) return null; // 전체 참조는 기존 경로
  const keys: string[] = [];
  const re = /\$\{params\.([A-Za-z0-9_.-]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ref))) keys.push(m[1]);
  const stripped = ref.replace(/\$\{params\.[A-Za-z0-9_.-]+\}/g, "");
  if (stripped.includes("${")) return []; // 깨진 ${...} 잔존 → 무효 템플릿
  if (stripped.includes("$")) return []; // $노드 혼합은 미지원 → 무효 취급
  if (keys.length === 0) return [];
  return keys;
}

/** until 범위 판정 (M5.5-2): 노드 자신 또는 조상이 kind:"until"이면 true */
export function inUntilScope(n: Node, byId: Map<string, Node>): boolean {
  let cur: Node | undefined = n;
  let guard = 0;
  while (cur && guard++ < 1000) {
    if ((cur as unknown as { kind?: string }).kind === "until") return true;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return false;
}

/** map 범위 판정: 노드 자신 또는 조상이 kind:"map"이면 as 이름 반환 (M5.5-1) */
export function mapAsName(n: Node, byId: Map<string, Node>): string | null {
  let cur: Node | undefined = n;
  let guard = 0;
  while (cur && guard++ < 1000) {
    if ((cur as unknown as { kind?: string }).kind === "map") {
      const as = (cur as unknown as { map?: { as?: unknown } }).map?.as;
      return typeof as === "string" && as.length > 0 ? as : "item";
    }
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return null;
}

function getByDotPath(root: unknown, path: string): boolean {  const parts = path.split(".");
  let cur: unknown = root;
  for (const p of parts) {
    if (cur === null || cur === undefined) return false;
    if (Array.isArray(cur)) {
      const idx = Number(p);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return false;
      cur = cur[idx];
    } else if (typeof cur === "object") {
      if (!(p in (cur as Record<string, unknown>))) return false;
      cur = (cur as Record<string, unknown>)[p];
    } else return false;
  }
  return true;
}

function getByDotValue(root: unknown, path: string): { ok: boolean; value?: unknown } {
  let cur: unknown = root;
  for (const p of path.split(".")) {
    if (cur === null || cur === undefined) return { ok: false };
    if (Array.isArray(cur)) {
      const idx = Number(p);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return { ok: false };
      cur = cur[idx];
    } else if (typeof cur === "object") {
      if (!(p in (cur as Record<string, unknown>))) return { ok: false };
      cur = (cur as Record<string, unknown>)[p];
    } else return { ok: false };
  }
  return { ok: true, value: cur };
}

/**
 * ref 값 해석 (M5.8.2-2, core confirm 대조·finalize 검증 공용).
 * ${params.k}·$N·$N.<field> (M5.8.2-1 의미). 해석 불가면 ok:false.
 * ${item}/${state}/$self/템플릿 혼합은 runner 영역이라 다루지 않는다.
 */
export function resolveRefValue(
  ref: string,
  params: Record<string, string>,
  outputs: Record<string, unknown>,
): { ok: boolean; value?: unknown } {
  if (typeof ref !== "string") return { ok: false };
  const pm = /^\$\{params\.([A-Za-z0-9_.-]+)\}$/.exec(ref);
  if (pm) {
    return Object.prototype.hasOwnProperty.call(params, pm[1])
      ? { ok: true, value: (params as Record<string, unknown>)[pm[1]] }
      : { ok: false };
  }
  const parsed = parseRef(ref);
  if (!parsed || !parsed.nodeId) return { ok: false };
  if (!Object.prototype.hasOwnProperty.call(outputs, parsed.nodeId)) return { ok: false };
  const base = (outputs as Record<string, unknown>)[parsed.nodeId];
  if (!parsed.fieldPath) return { ok: true, value: base };
  return getByDotValue(base, parsed.fieldPath);
}

export function checkFixedAgainstInputSchema(
  args: Node["args"],
  inputSchema: Record<string, unknown>,
): string | null {
  // inputSchema는 JSON Schema object 형태를 가정 (M3.4.3-4 공용 검사 + type 배열)
  const { properties: props, required } = readSchemaProps(inputSchema);
  if (!args) {
    return required.length > 0 ? `missing required args: ${required.join(",")}` : null;
  }
  for (const r of required) {
    if (!(r in args)) return `missing required arg: ${r}`;
  }
  const { unknownKeys, suggestions } = checkUnknownKeys(Object.keys(args), inputSchema);
  if (unknownKeys.length > 0) {
    const hints = unknownKeys.map((k) =>
      suggestions[k]?.length ? `${k} (유사: ${suggestions[k].join(", ")})` : k,
    );
    return `argSpecs unknown: ${hints.join("; ")}`;
  }
  for (const [k, spec] of Object.entries(args)) {
    if (spec.kind !== "fixed") continue;
    const prop = props[k];
    if (!prop) continue;
    const t = prop["type"] as string | string[] | undefined;
    const v = (spec as { value: unknown }).value;
    if (t && !matchesType(v, t)) return `arg ${k}: expected ${Array.isArray(t) ? t.join("|") : t}`;
    if (prop["enum"] !== undefined) {
      const en = prop["enum"] as unknown[];
      if (!en.some((e) => JSON.stringify(e) === JSON.stringify(v))) return `arg ${k}: not in enum`;
    }
  }
  return null;
}

export function validateTree(session: Session, nodes: Node[], opts: ValidateOptions = {}): ValidationError[] {
  const errors: ValidationError[] = [];
  const byId = new Map<string, Node>();
  for (const n of nodes) {
    if (byId.has(n.id)) errors.push({ code: "duplicate_id", nodeId: n.id, message: `duplicate node id ${n.id}` });
    byId.set(n.id, n);
    if (!NodeIdSchema.safeParse(n.id).success)
      errors.push({ code: "bad_id", nodeId: n.id, message: `bad node id ${n.id}` });
  }
  if (!byId.has(session.rootId))
    errors.push({ code: "bad_root", message: `rootId ${session.rootId} not found` });

  // 노드 수 한도 (10-7)
  if (nodes.length > session.limits.maxNodes)
    errors.push({ code: "too_many_nodes", message: `nodes ${nodes.length} > maxNodes ${session.limits.maxNodes}` });

  // catalog index
  const catalog = new Map(session.toolCatalog.map((t) => [`${t.server}/${t.name}`, t]));

  for (const n of nodes) {
    // depth 한도 (10-6)
    if (n.depth > session.limits.maxDepth)
      errors.push({ code: "depth_exceeded", nodeId: n.id, message: `depth ${n.depth} > maxDepth ${session.limits.maxDepth}` });

    // parent/children 일관성 (10-10)
    if (n.parentId !== null) {
      const p = byId.get(n.parentId);
      if (!p) errors.push({ code: "parent_link", nodeId: n.id, message: `parent ${n.parentId} not found` });
      else if (!p.children.includes(n.id))
        errors.push({ code: "parent_link", nodeId: n.id, message: `parent ${n.parentId} missing child link` });
    }
    for (const ch of n.children) {
      const c = byId.get(ch);
      if (!c) errors.push({ code: "children_link", nodeId: n.id, message: `child ${ch} not found` });
      else if (c.parentId !== n.id)
        errors.push({ code: "children_link", nodeId: n.id, message: `child ${ch} parentId mismatch` });
    }
    // dependsOn 존재 + 혈통 검사 (M3.4-5: 자기 조상/자손 의존 금지)
    const ancestors = new Set<string>();
    {
      let cur: Node | undefined = n;
      while (cur?.parentId) {
        ancestors.add(cur.parentId);
        cur = byId.get(cur.parentId);
      }
    }
    const descendants = new Set<string>();
    {
      const queue = [...n.children];
      while (queue.length > 0) {
        const c = queue.shift()!;
        if (descendants.has(c)) continue;
        descendants.add(c);
        const cn = byId.get(c);
        if (cn) queue.push(...cn.children);
      }
    }
    for (const d of n.dependsOn) {
      if (!byId.has(d)) errors.push({ code: "bad_depend", nodeId: n.id, message: `dependsOn ${d} not found` });
      else if (ancestors.has(d) || descendants.has(d))
        errors.push({ code: "dep_on_lineage", nodeId: n.id, message: `dependsOn ${d} is ancestor/descendant (deadlock)` });
    }

    // map 검사 (M5.5-1)
    {
      const nkind = (n as unknown as { kind?: string }).kind;
      const nmap = (n as unknown as { map?: unknown }).map;      if (nkind === "map" || nmap !== undefined) {
        if (nkind !== "map" || typeof nmap !== "object" || nmap === null) {
          errors.push({ code: "bad_map", nodeId: n.id, message: "map kind/spec mismatch" });
        } else {
          const spec = nmap as { over?: unknown; maxItems?: unknown; policy?: unknown; template?: unknown };
          const tpl = spec.template as { tool?: unknown } | undefined;
          const tool = tpl?.tool as { server?: unknown; name?: unknown } | undefined;
          if (!tpl || typeof tool?.server !== "string" || typeof tool?.name !== "string") {
            errors.push({ code: "bad_map", nodeId: n.id, message: "map 템플릿 도구 없음" });
          }
          if (typeof spec.over !== "string" || spec.over.length === 0) {
            errors.push({ code: "bad_map", nodeId: n.id, message: "map over 비어 있음" });
          }
          if (spec.maxItems !== undefined && (!Number.isInteger(spec.maxItems) || (spec.maxItems as number) <= 0)) {
            errors.push({ code: "bad_map", nodeId: n.id, message: "map maxItems는 양의 정수" });
          }
          const policy = spec.policy as { kind?: unknown; ratio?: unknown } | undefined;
          if (policy !== undefined) {
            if (!["all", "any", "threshold"].includes(policy.kind as string)) {
              errors.push({ code: "bad_map", nodeId: n.id, message: "map policy kind 불명" });
            } else if (policy.kind === "threshold" &&
              (typeof policy.ratio !== "number" || policy.ratio < 0 || policy.ratio > 1)) {
              errors.push({ code: "bad_map", nodeId: n.id, message: "map threshold 정책은 ratio 0~1 필요" });
            }
          }
          if (Array.isArray(n.children) && n.children.length > 0) {
            errors.push({ code: "bad_map", nodeId: n.id, message: "map 노드는 자식을 가질 수 없음 (템플릿 인라인)" });
          }
        }
      }
    }

    // until 검사 (M5.5-2)
    {
      const nkind = (n as unknown as { kind?: string }).kind;
      const nuntil = (n as unknown as { until?: unknown }).until;
      if (nkind === "until" || nuntil !== undefined) {
        if (nkind !== "until" || typeof nuntil !== "object" || nuntil === null) {
          errors.push({ code: "bad_until", nodeId: n.id, message: "until kind/spec mismatch" });
        } else {
          const spec = nuntil as { until?: unknown; maxIterations?: unknown; carry?: unknown; template?: unknown };
          const tpl = spec.template as { tool?: unknown; args?: unknown } | undefined;
          if (typeof spec.maxIterations !== "number" || !Number.isInteger(spec.maxIterations) || spec.maxIterations <= 0) {
            errors.push({ code: "bad_until", nodeId: n.id, message: "until maxIterations는 양의 정수" });
          }
          if (spec.carry !== undefined &&
            (typeof spec.carry !== "string" || !/^\$self\.[A-Za-z0-9_.-]+$/.test(spec.carry))) {
            errors.push({ code: "bad_until", nodeId: n.id, message: 'until carry는 "$self.경로" 형태' });
          }
          if (!Array.isArray(n.children) || n.children.length !== 0) {
            errors.push({ code: "bad_until", nodeId: n.id, message: "until 노드는 자식을 가질 수 없음 (템플릿 인라인)" });
          }
          const tool = tpl?.tool as { server?: unknown; name?: unknown } | undefined;
          if (!tpl || typeof tool?.server !== "string" || typeof tool?.name !== "string") {
            errors.push({ code: "bad_until", nodeId: n.id, message: "until 템플릿 도구 없음" });
          }
        }
      }
    }

    // stateWrites 검사 (M5.5-3)
    {
      const sw = (n as unknown as { stateWrites?: unknown }).stateWrites;
      if (sw !== undefined) {
        if (!Array.isArray(sw)) {
          errors.push({ code: "bad_state", nodeId: n.id, message: "stateWrites는 배열" });
        } else {
          for (const e of sw) {
            const ee = e as { key?: unknown; from?: unknown };
            if (typeof ee?.key !== "string" || ee.key.length === 0 || typeof ee?.from !== "string" || ee.from.length === 0) {
              errors.push({ code: "bad_state", nodeId: n.id, message: "stateWrites는 {key, from}" });
            } else if (!(ee.from as string).startsWith("$")) {
              errors.push({ code: "bad_state", nodeId: n.id, message: `stateWrites.from은 $ 참조: ${ee.from}` });
            }
          }
        }
      }
    }

    // leaf 검사
    if (n.status === "leaf") {
      if (!n.tool) {
        errors.push({ code: "leaf_no_tool", nodeId: n.id, message: "leaf without tool" });
      } else {
        const key = `${n.tool.server}/${n.tool.name}`;
        const entry = catalog.get(key);
        // (10-1) tool 존재
        if (!entry) {
          errors.push({ code: "unknown_tool", nodeId: n.id, message: `tool ${key} not in catalog` });
        } else {
          // (10-8) schemaHash
          if (entry.schemaHash !== n.tool.schemaHash)
            errors.push({
              code: "schema_hash_mismatch",
              nodeId: n.id,
              message: `schemaHash ${n.tool.schemaHash} != catalog ${entry.schemaHash}`,
            });
          // (10-2) args 적합성
          const msg = checkFixedAgainstInputSchema(n.args, entry.inputSchema as Record<string, unknown>);
          if (msg) errors.push({ code: "bad_args", nodeId: n.id, message: msg });
        }
      }
      // (10-9) leaf 확정 조건: 마지막 attempt verdict=pass.
      // M5.6-e: 승인된 external dry-run 계획 leaf는 면제 (attempt verdict 없음,
      // core M2.6-4 확정과 정합. n.approval 존재 + sideEffect external).
      const last = n.attempts[n.attempts.length - 1];
      const approvedExternal =
        n.sideEffect === "external" && (n as { approval?: unknown }).approval !== undefined;
      if (!approvedExternal && (!last || last.verdict !== "pass"))
        errors.push({ code: "leaf_not_confirmed", nodeId: n.id, message: "leaf without passing attempt" });
    }

    // var 참조 검사 (10-3, 10-4)
    const checkVarArg = (argName: string, spec: { kind: string }): void => {
        if (spec.kind !== "var") return;
        const ref = (spec as unknown as { ref: string }).ref;
        // M5.5-1: map 범위에서는 ${as...} 참조 허용 (이름 일치 검사).
        // strip 후 남은 부분은 기존 템플릿 검사로 계속 검증한다.
        const asName = mapAsName(n, byId);
        let work = ref;
        if (asName !== null) {
          const others = [...ref.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z0-9_.-]+)?\}/g)]
            .map((m) => m[1])
            .filter((nm) => nm !== "params" && nm !== asName);
          if (others.length > 0) {
            errors.push({ code: "bad_ref", nodeId: n.id, message: `arg ${argName}: unknown item "${others[0]}" (as="${asName}")` });
            return;
          }
          const escAs = asName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          work = ref.replace(new RegExp(`\\$\\{${escAs}(?:\\.[A-Za-z0-9_.-]+)?\\}`, "g"), "");
          if (work === "") return;
        }
        // M5.5-3: ${state.k} 허용 (실행 시점 해결, 키 형식만 검사)
        if (work.includes("${state.")) {
          const bad = [...work.matchAll(/\$\{state\.([^}]*)\}/g)].some((m) => !/^[A-Za-z0-9_.-]+$/.test(m[1]));
          if (bad) {
            errors.push({ code: "bad_ref_field", nodeId: n.id, message: `arg ${argName}: bad state ref ${ref}` });
            return;
          }
          work = work.replace(/\$\{state\.[A-Za-z0-9_.-]+\}/g, "");
          if (work === "") return;
        }
        // M5.5-2: until 범위에서는 bare "$self" 허용 ("$self.경로"는 인자에서 금지).
        if (ref === "$self") {
          if (!inUntilScope(n, byId)) {
            errors.push({ code: "bad_ref_field", nodeId: n.id, message: `arg ${argName}: $self outside until` });
          }
          return;
        }
        if (ref.startsWith("$self")) {
          errors.push({ code: "bad_ref_field", nodeId: n.id, message: `arg ${argName}: 인자에서는 bare $self만 (채널은 carry 선언)` });
          return;
        }
        // M5.1-B3: 템플릿 var는 포함된 params 키 존재 여부만 검사
        const tkeys = templateParamsKeys(work);
        if (tkeys !== null) {
          if (tkeys.length === 0) {
            errors.push({ code: "bad_ref_field", nodeId: n.id, message: `arg ${argName}: bad template ref ${ref}` });
            return;
          }
          for (const k of tkeys) {
            if (!(k in session.params))
              errors.push({ code: "bad_ref", nodeId: n.id, message: `arg ${argName}: unknown params ${k}` });
          }
          return;
        }
        if (!isValidRefSyntax(work)) {
          errors.push({ code: "bad_ref_field", nodeId: n.id, message: `arg ${argName}: bad ref syntax ${ref}` });
          return;
        }
        const parsed = parseRef(work);
        if (!parsed) {
          errors.push({ code: "bad_ref_field", nodeId: n.id, message: `arg ${argName}: bad ref ${ref}` });
          return;
        }
        if (parsed.paramsKey) {
          if (!(parsed.paramsKey in session.params))
            errors.push({ code: "bad_ref", nodeId: n.id, message: `arg ${argName}: unknown params ${parsed.paramsKey}` });
          return;
        }
        if (parsed.nodeId && !byId.has(parsed.nodeId)) {
          errors.push({ code: "bad_ref", nodeId: n.id, message: `arg ${argName}: unknown node ${parsed.nodeId}` });
          return;
        }
        if (parsed.nodeId && parsed.fieldPath && opts.outputs) {
          const out = opts.outputs[parsed.nodeId];
          if (out !== undefined && !getByDotPath(out, parsed.fieldPath))
            errors.push({
              code: "bad_ref_field",
              nodeId: n.id,
              message: `arg ${argName}: field ${parsed.fieldPath} not in node ${parsed.nodeId} output`,
            });
        }
    };
    if (n.args) {
      for (const [argName, spec] of Object.entries(n.args)) checkVarArg(argName, spec);
    }
    // M5.5-1/2: 인라인 템플릿 인자도 동일 검사
    for (const tkey of ["map", "until"] as const) {
      const tpl = (n as unknown as Record<string, { template?: { args?: Record<string, { kind: string }> } }>)[tkey]?.template;
      if (tpl && typeof tpl.args === "object" && tpl.args !== null) {
        for (const [argName, spec] of Object.entries(tpl.args)) checkVarArg(argName, spec);
      }
    }
  }

  // 순환 의존 (10-5, M3.4.3-2 펼친 그래프 기준 공용 검사)
  if (hasCycle(nodes)) errors.push({ code: "cycle", message: "dependency cycle detected" });

  return errors;
}
