import { pfError } from "@procforge/shared/errors.js";

// M6.1-1 (R8): core행 요청 전송 감사. RemoteCoreClient가 송신 전 한 곳에서 검사한다.
// - 구조 위반(차단): 어떤 메서드의 resultJson 실데이터도 원격 전송 금지
//   (메타 {sha256,size,preview}만 허용. pfReport 포함).
// - 상한+교정(차단 아님): resultSummary·rubricReasons 값은 4KB 상한 후
//   토큰·키·이메일 교정. 예외 없음.
// - 정의 유지+교정: params/args/argSpecs는 정의이므로 원문 유지하되
//   토큰·키·이메일 교정 적용 (절대경로·구조 위반 검사는 면제).
//   argSpecs fixed 값이 args와 같은 문자열이라 차단하면 일관성이 깨진다.
//   (M6.1-2: 스위트 필수 흐름. 경로 안의 사용자명 노출은 감수, 토큰은 교정)
// 위반이 있으면 전송하지 않고 bad_request (호출자 코드 수정 사항).

export type EgressCheck = {
  body: unknown;
  violations: string[];
  redactions: number;
};

const RESULT_JSON_META_KEYS = ["sha256", "size", "preview"];

export function isMetaShape(v: unknown): boolean {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  return (
    keys.length === 3 &&
    keys.every((k) => RESULT_JSON_META_KEYS.includes(k)) &&
    typeof o["sha256"] === "string" &&
    typeof o["size"] === "number" &&
    typeof o["preview"] === "string"
  );
}

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const ABS_RE = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/;

/** 산문 필드 (절대경로 검사 제외). 평가는 runner가 원문으로 한다. */
const PROSE_KEYS = new Set([
  "resultSummary",
  "message",
  "text",
  "question",
  "note",
  "reason",
  "summary",
  "goal",
  "instruction",
  "request",
]);

const TOKEN_RES: { re: RegExp; label: string }[] = [
  { re: /sk-[A-Za-z0-9]{20,}/g, label: "token" },
  { re: /xox[bpas]-[A-Za-z0-9-]+/g, label: "token" },
  { re: /gh[pousr]_[A-Za-z0-9_]+/g, label: "token" },
  { re: /AKIA[0-9A-Z]{16}/g, label: "token" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, label: "token" },
];
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const REDACTED = "***";
/** resultSummary·rubricReasons 상한 (M6.1-1, 예외 없음) */
const CAPPED_LEN = 4096;

function redact(s: string, counter: { n: number }): string {
  for (const t of TOKEN_RES) {
    if (t.re.test(s)) {
      s = s.replace(t.re, REDACTED);
      counter.n++;
    }
    t.re.lastIndex = 0;
  }
  if (EMAIL_RE.test(s)) {
    s = s.replace(EMAIL_RE, REDACTED);
    counter.n++;
  }
  EMAIL_RE.lastIndex = 0;
  return s;
}

export function inspectEgress(method: string, body: unknown): EgressCheck {
  const violations: string[] = [];
  const counter = { n: 0 };
  const clone: unknown = JSON.parse(JSON.stringify(body));

  // mode: normal(검사+교정) | prose(교정만) | def(정의: 교정만, 구조면제)
  //   | cap(상한+교정) | data(면제).
  // params/args/argSpecs는 정의이므로 교정만 (절대경로 정상 사용).
  // resultSummary·rubricReasons 값은 4KB 상한+교정, 예외 없음.
  type Mode = "normal" | "prose" | "def" | "cap" | "data";
  const walk = (v: unknown, key: string | null, mode: Mode): unknown => {
    if (typeof v === "string") {
      let s = v;
      if (mode !== "data") s = redact(s, counter);
      if (mode === "cap" && s.length > CAPPED_LEN) {
        s = s.slice(0, CAPPED_LEN);
        counter.n++;
      }
      if (mode === "normal" && !URL_RE.test(s) && ABS_RE.test(s)) {
        violations.push(`절대경로: ${key ?? "(root)"}="${s.slice(0, 80)}"`);
      }
      return s;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key, mode));
    if (v !== null && typeof v === "object") {
      const o = v as Record<string, unknown>;
      // 메타 형태는 파생 요약이라 검사 면제.
      if (isMetaShape(o)) return o;
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(o)) {
        if (k === "resultJson" && x !== undefined && !isMetaShape(x)) {
          // M6.1-1: 어떤 메서드의 실데이터도 원격 전송 금지 (pfReport 포함).
          violations.push(`resultJson 실데이터: ${method} (메타만 허용)`);
          out[k] = walk(x, k, "data");
          continue;
        }
        if (k === "resultSummary") {
          out[k] = walk(x, k, "cap");
          continue;
        }
        if (
          k === "rubricReasons" &&
          x !== null &&
          typeof x === "object" &&
          !Array.isArray(x)
        ) {
          const ro: Record<string, unknown> = {};
          for (const [rk, rv] of Object.entries(x as Record<string, unknown>)) {
            ro[rk] = walk(rv, rk, "cap");
          }
          out[k] = ro;
          continue;
        }
        const next: Mode =
          k === "params" || k === "args" || k === "argSpecs"
            ? "def"
            : PROSE_KEYS.has(k)
              ? "prose"
              : mode;
        out[k] = walk(x, k, next);
      }
      return out;
    }
    return v;
  };

  return {
    body: walk(clone, null, "normal"),
    violations,
    redactions: counter.n,
  };
}

/** 위반이면 전송 차단 (호출자 수정 사항). */
export function guardEgress(
  method: string,
  body: unknown,
): { body: unknown; redactions: number } {
  const r = inspectEgress(method, body);
  if (r.violations.length > 0) {
    throw pfError("bad_request", `egress 위반: ${r.violations.join("; ")}`);
  }
  return { body: r.body, redactions: r.redactions };
}
