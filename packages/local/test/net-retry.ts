// 테스트 전용: loopback 순간 실패(fetch failed 등 → io_error) 재시도.
// product 재시도 정책(읽기만 3회·쓰기 금지)은 그대로. 테스트 어서션용.
export function withNetRetry<T extends object>(client: T, tries = 3): T {
  return new Proxy(client, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r);
      if (typeof v !== "function") return v;
      return (...a: unknown[]) =>
        (async () => {
          let last: unknown;
          for (let i = 0; i < tries; i++) {
            try {
              return await (v as (...x: unknown[]) => Promise<unknown>).apply(
                t,
                a,
              );
            } catch (e) {
              last = e;
              if ((e as { code?: string })?.code !== "io_error") throw e;
              await new Promise((rr) => setTimeout(rr, 200));
            }
          }
          throw last;
        })();
    },
  }) as T;
}
