import { resolveRefValue } from "@procforge/shared/validator.js";
import { stableStringify } from "@procforge/shared/stable.js";
import { varRefNodeId } from "@procforge/shared/args-schema.js";

// M5.8.2 후속: ref 대조 계산 (R2: 상태 변경 없이 계산만, 판정은 core).
// 상류 출력 = golden attempt resultJson, 없으면 마지막 pass attempt.
// map/until 대상 참조는 제외 (런타임 출력은 누적 수집).

export type RefNodeInfo = {
  id: string;
  kind?: string;
  goldenAttemptId?: string;
  attempts: { id: string; verdict?: string }[];
};

export type RefVerdict =
  | { key: string; verdict: "match" }
  | { key: string; verdict: "mismatch"; probing: string; resolved: string }
  | { key: string; verdict: "unverifiable" };

function short(v: unknown): string {
  return stableStringify(v).slice(0, 200);
}

/** golden→최종pass 순서로 상류 출력 맵 구성 */
export function buildRefOutputs(opts: {
  specs: Record<string, unknown>;
  params: Record<string, string>;
  nodes: Map<string, RefNodeInfo>;
  loadJson: (attemptId: string) => unknown | undefined;
}): { outputs: Record<string, unknown>; exempt: string[] } {
  const outputs: Record<string, unknown> = {};
  const exempt: string[] = [];
  const seen = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (v !== null && typeof v === "object") {
      const r = v as Record<string, unknown>;
      if (r["kind"] === "var" && typeof r["ref"] === "string") {
        const id = varRefNodeId(r["ref"] as string);
        if (id && !seen.has(id)) {
          seen.add(id);
          const n = opts.nodes.get(id);
          if (n && (n.kind === "map" || n.kind === "until")) {
            exempt.push(id);
          } else if (n) {
            const golden = n.goldenAttemptId !== undefined
              ? opts.loadJson(n.goldenAttemptId)
              : undefined;
            if (golden !== undefined) {
              outputs[id] = golden;
            } else {
              const lastPass = [...n.attempts].reverse().find((a) => a.verdict === "pass");
              if (lastPass) {
                const v2 = opts.loadJson(lastPass.id);
                if (v2 !== undefined) outputs[id] = v2;
              }
            }
          }
        }
      }
      for (const x of Object.values(r)) walk(x);
    }
  };
  walk(opts.specs);
  return { outputs, exempt };
}

/** probing 인자 vs ref 해석값 대조 */
export function checkProbingArgs(opts: {
  specs: Record<string, unknown>;
  probingArgs: Record<string, unknown>;
  params: Record<string, string>;
  nodes: Map<string, RefNodeInfo>;
  loadJson: (attemptId: string) => unknown | undefined;
}): RefVerdict[] {
  const out: RefVerdict[] = [];
  const { outputs } = buildRefOutputs(opts);
  for (const [k, spec] of Object.entries(opts.specs)) {
    const s = spec as { kind?: unknown; ref?: unknown };
    if (s === null || typeof s !== "object" || s.kind !== "var" || typeof s.ref !== "string") continue;
    const isParams = /^\$\{params\.[A-Za-z0-9_.-]+\}$/.test(s.ref);
    // $노드 ref와 ${params.k}만 대조. state/item/self/혼합 템플릿은 runner 영역이라 제외.
    if (!isParams && varRefNodeId(s.ref) === undefined) continue;
    const r = resolveRefValue(s.ref, opts.params, outputs);
    if (!r.ok) {
      out.push({ key: k, verdict: "unverifiable" });
      continue;
    }
    const probing = opts.probingArgs[k];
    if (stableStringify(probing) === stableStringify(r.value)) {
      out.push({ key: k, verdict: "match" });
    } else {
      out.push({ key: k, verdict: "mismatch", probing: short(probing), resolved: short(r.value) });
    }
  }
  return out;
}
