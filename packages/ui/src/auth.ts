// M8-ui4: 브라우저 토큰 보관소 (1단계: 메모리).
// 2단계(b)에서 sessionStorage 로 옮긴다 — 저장 정책과 입력 화면을 분리 커밋한다.
export type AuthNotice = "none" | "unauthorized" | "restarted";

let memoryToken = "";
const lostListeners = new Set<() => void>();

/** 401 이 한 번이라도 오면 토큰을 버리고 입력 화면으로 돌아간다. */
export function notifyAuthLost(): void {
  clearToken();
  for (const fn of lostListeners) fn();
}

export function onAuthLost(fn: () => void): () => void {
  lostListeners.add(fn);
  return () => {
    lostListeners.delete(fn);
  };
}

export function getToken(): string {
  return memoryToken;
}

export function saveToken(value: string): void {
  memoryToken = value;
}

export function clearToken(): void {
  memoryToken = "";
}

/**
 * 입력값에서 토큰만 뽑는다. 허용:
 * - 토큰 자체
 * - 전체 URL (`http://127.0.0.1:PORT/#t=...`)
 * #t= 가 아닌 쿼리 토큰은 받지 않는다 (서버도 쿼리 토큰을 거부한다).
 */
export function parseTokenInput(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  const hash = /#t=([^&\s]+)/.exec(v);
  if (hash) {
    try {
      return decodeURIComponent(hash[1]);
    } catch {
      return null;
    }
  }
  if (/^https?:\/\//i.test(v)) return null;
  if (/\s/.test(v) || v.length < 8) return null;
  return v;
}

/**
 * 앱 시작 시 1회. #t= 가 있으면 토큰으로 받아들인다.
 * 반환값이 null 이면 바로 화면을 그릴 수 있다.
 */
export function initAuth(): { notice: AuthNotice } | null {
  const hashToken = /#t=([^&]+)/.exec(location.hash);
  if (hashToken) {
    try {
      const t = decodeURIComponent(hashToken[1]);
      if (t) saveToken(t);
    } catch {
      // 형식이 깨진 fragment 는 버린다.
    }
  }
  return getToken() ? null : { notice: "none" };
}
