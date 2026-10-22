// M8-ui4: 브라우저 토큰 보관소.
// - 저장 위치는 sessionStorage (탭 단위). 쿠키는 쓰지 않는다 —
//   127.0.0.1 쿠키는 포트를 구분하지 않아 다른 로컬 서버와 섞인다.
// - sessionStorage 자체가 출처(스킴·호스트·포트) 단위라 키에 origin 을 넣어 명시한다.
// - #t= 로 들어온 토큰도 저장한 뒤 주소에서 지운다 (XSS·히스토리 유출면 축소).
const ORIGIN = location.origin;
const TOKEN_KEY = `pf.token:${ORIGIN}`;
const INSTANCE_KEY = `pf.instance:${ORIGIN}`;

export type AuthNotice = "none" | "unauthorized" | "restarted";

function read(key: string): string {
  try {
    return sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // 저장 불가(사생활 모드 등)면 메모리 상태만으로 동작한다.
  }
}

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
  return read(TOKEN_KEY) || memoryToken;
}

export function saveToken(value: string): void {
  memoryToken = value;
  write(TOKEN_KEY, value);
}

export function clearToken(): void {
  memoryToken = "";
  write(TOKEN_KEY, null);
}

/** SPA 정적 응답이 심어 준 서버 인스턴스 id (재시작 감지). */
function servedInstance(): string {
  const m = document.querySelector<HTMLMetaElement>('meta[name="pf-instance"]');
  return m?.content ?? "";
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
 * 앱 시작 시 1회. #t= 를 저장·제거하고, 서버 인스턴스가 바뀌었으면 재시작으로 본다.
 * 반환값이 null 이면 바로 화면을 그릴 수 있다.
 */
export function initAuth(): { notice: AuthNotice } | null {
  const hashToken = /#t=([^&]+)/.exec(location.hash);
  let fresh = false;
  if (hashToken) {
    try {
      const t = decodeURIComponent(hashToken[1]);
      if (t) {
        saveToken(t);
        fresh = true;
      }
    } catch {
      // 형식이 깨진 fragment 는 버린다.
    }
    history.replaceState(null, "", location.pathname + location.search);
  }
  const current = servedInstance();
  const previous = read(INSTANCE_KEY);
  if (current) write(INSTANCE_KEY, current);
  const token = getToken();
  // 새 URL로 토큰을 받은 경우에는 재시작 판정을 하지 않는다 (방금 받은 토큰이 정답).
  if (!fresh && token && current && previous && previous !== current) {
    clearToken();
    return { notice: "restarted" };
  }
  if (!token) return { notice: "none" };
  return null;
}
