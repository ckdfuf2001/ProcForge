// argSpecs ↔ tool inputSchema 검사 공용 (core·validator 공유, M3.4.3-4).

/** 유사 키 제안용 편집 거리 (상한 3, 허용 2) */
export function similarKey(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 3) return false;
  let prev = Array.from({ length: lb + 1 }, (_, i) => i);
  for (let i = 1; i <= la; i++) {
    const cur = [i];
    for (let j = 1; j <= lb; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[lb] <= 2;
}

/** JSON Schema type (string | string[]) 매칭. null 허용 포함 */
export function matchesType(value: unknown, t: string | string[]): boolean {
  const types = Array.isArray(t) ? t : [t];
  return types.some((one) => {
    switch (one) {
      case "string":
        return typeof value === "string";
      case "number":
        return typeof value === "number";
      case "integer":
        return typeof value === "number" && Number.isInteger(value);
      case "boolean":
        return typeof value === "boolean";
      case "array":
        return Array.isArray(value);
      case "object":
        return value !== null && typeof value === "object" && !Array.isArray(value);
      case "null":
        return value === null;
      default:
        return false;
    }
  });
}

export type SchemaProps = {
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  additionalProperties?: boolean;
};

export function readSchemaProps(inputSchema: unknown): SchemaProps {
  const s = (inputSchema ?? {}) as Record<string, unknown>;
  return {
    properties: (s["properties"] as Record<string, Record<string, unknown>> | undefined) ?? {},
    required: (s["required"] as string[] | undefined) ?? [],
    additionalProperties: s["additionalProperties"] as boolean | undefined,
  };
}

/** additionalProperties:false + 등록 외 키 → unknownKeys + 유사 키 제안 */
export function checkUnknownKeys(
  argNames: string[],
  inputSchema: unknown,
): { unknownKeys: string[]; suggestions: Record<string, string[]> } {
  const { properties, additionalProperties } = readSchemaProps(inputSchema);
  if (additionalProperties !== false) return { unknownKeys: [], suggestions: {} };
  const allowed = Object.keys(properties);
  const unknownKeys = argNames.filter((k) => !allowed.includes(k));
  const suggestions: Record<string, string[]> = {};
  for (const k of unknownKeys) {
    const sim = allowed.filter((a) => similarKey(a, k));
    if (sim.length > 0) suggestions[k] = sim;
  }
  return { unknownKeys, suggestions };
}
