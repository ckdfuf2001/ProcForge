// M10-model-fix: 가짜 OpenCode /config/providers 응답 (실서버 형식).
// 실서버: { default: {providerID: modelID}, providers: [{ id, models }] } (배열).
// src에서는 import 금지 (테스트 장치 전용).
export function fakeProvidersBody(
  defaults: Record<string, string> = { t: "m" },
): {
  default: Record<string, string>;
  providers: { id: string; models: Record<string, Record<string, never>> }[];
} {
  const byProvider = new Map<string, Set<string>>();
  for (const [pid, mid] of Object.entries(defaults)) {
    let s = byProvider.get(pid);
    if (!s) {
      s = new Set<string>();
      byProvider.set(pid, s);
    }
    s.add(mid);
  }
  return {
    default: { ...defaults },
    providers: [...byProvider.entries()].map(([id, models]) => ({
      id,
      models: Object.fromEntries([...models].map((m) => [m, {} as Record<string, never>])),
    })),
  };
}
