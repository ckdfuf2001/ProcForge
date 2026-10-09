import type { Node, Session } from "@procforge/shared/schema.js";
import { NodeIdSchema } from "@procforge/shared/schema.js";

export type ValidationError = {
  code: string;
  nodeId?: string;
  message: string;
};

export type ValidateOptions = {
  outputs?: Record<string, unknown>;
};

function isValidRefSyntax(ref: string): boolean {
  // 허용: ${params.xxx} | ${...} | $<id> | $<id>.output | $<id>.output.<dotpath>
  if (/^\$\{params\.[A-Za-z0-9_.-]+\}$/.test(ref)) return true;
  if (/^\$\{\}$/.test(ref)) return false;
  const m = /^\$(\d+(?:\.\d+)*)(.*)$/.exec(ref);
  if (!m) return false;
  const rest = m[2];
  if (rest === "") return true;
  if (rest === ".output") return true;
  if (rest.startsWith(".output.")) {
    const field = rest.slice(".output.".length);
    return field.length > 0 && /^[A-Za-z0-9_.-]+$/.test(field);
  }
  return false;
}

function parseRef(ref: string): { paramsKey?: string; nodeId?: string; fieldPath?: string } | null {
  const pm = /^\$\{params\.([A-Za-z0-9_.-]+)\}$/.exec(ref);
  if (pm) return { paramsKey: pm[1] };
  const m = /^\$(\d+(?:\.\d+)*)(.*)$/.exec(ref);
  if (!m) return null;
  const nodeId = m[1];
  const rest = m[2];
  if (rest === "" || rest === ".output") return { nodeId };
  if (rest.startsWith(".output.")) return { nodeId, fieldPath: rest.slice(".output.".length) };
  return null;
}

function getByDotPath(root: unknown, path: string): boolean {
  const parts = path.split(".");
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

function checkFixedAgainstInputSchema(
  args: Node["args"],
  inputSchema: Record<string, unknown>,
): string | null {
  // inputSchema는 JSON Schema object 형태를 가정: { type?, properties?, required? }
  const props = (inputSchema["properties"] as Record<string, Record<string, unknown>> | undefined) ?? {};
  const required = (inputSchema["required"] as string[] | undefined) ?? [];
  if (!args) {
    return required.length > 0 ? `missing required args: ${required.join(",")}` : null;
  }
  for (const r of required) {
    if (!(r in args)) return `missing required arg: ${r}`;
  }
  for (const [k, spec] of Object.entries(args)) {
    if (spec.kind !== "fixed") continue;
    const prop = props[k];
    if (!prop) continue; // additionalProperties 허용 가정
    const t = prop["type"] as string | undefined;
    const v = (spec as { value: unknown }).value;
    if (t) {
      const ok =
        (t === "string" && typeof v === "string") ||
        (t === "number" && typeof v === "number") ||
        (t === "integer" && typeof v === "number" && Number.isInteger(v)) ||
        (t === "boolean" && typeof v === "boolean") ||
        (t === "array" && Array.isArray(v)) ||
        (t === "object" && v !== null && typeof v === "object" && !Array.isArray(v));
      if (!ok) return `arg ${k}: expected ${t}`;
    }
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
      // (10-9) leaf 확정 조건: 마지막 attempt verdict=pass
      const last = n.attempts[n.attempts.length - 1];
      if (!last || last.verdict !== "pass")
        errors.push({ code: "leaf_not_confirmed", nodeId: n.id, message: "leaf without passing attempt" });
    }

    // var 참조 검사 (10-3, 10-4)
    if (n.args) {
      for (const [argName, spec] of Object.entries(n.args)) {
        if (spec.kind !== "var") continue;
        const ref = (spec as { ref: string }).ref;
        if (!isValidRefSyntax(ref)) {
          errors.push({ code: "bad_ref_field", nodeId: n.id, message: `arg ${argName}: bad ref syntax ${ref}` });
          continue;
        }
        const parsed = parseRef(ref);
        if (!parsed) {
          errors.push({ code: "bad_ref_field", nodeId: n.id, message: `arg ${argName}: bad ref ${ref}` });
          continue;
        }
        if (parsed.paramsKey) {
          if (!(parsed.paramsKey in session.params))
            errors.push({ code: "bad_ref", nodeId: n.id, message: `arg ${argName}: unknown params ${parsed.paramsKey}` });
          continue;
        }
        if (parsed.nodeId && !byId.has(parsed.nodeId)) {
          errors.push({ code: "bad_ref", nodeId: n.id, message: `arg ${argName}: unknown node ${parsed.nodeId}` });
          continue;
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
      }
    }
  }

  // 순환 의존 (10-5)
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  let hasCycle = false;
  const dfs = (id: string) => {
    color.set(id, GRAY);
    const n = byId.get(id);
    if (n) {
      for (const d of n.dependsOn) {
        if (!byId.has(d)) continue;
        const c = color.get(d) ?? WHITE;
        if (c === GRAY) {
          hasCycle = true;
          return;
        }
        if (c === WHITE) dfs(d);
      }
    }
    color.set(id, BLACK);
  };
  for (const n of nodes) {
    if ((color.get(n.id) ?? WHITE) === WHITE) dfs(n.id);
  }
  if (hasCycle) errors.push({ code: "cycle", message: "dependency cycle detected" });

  return errors;
}
