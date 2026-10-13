import { pfError } from "@procforge/shared/errors.js";

// M6-4: core행 요청 전송 감사. RemoteCoreClient가 송신 전 한 곳에서 검사한다.
// - 구조 위반(차단): pfReport 바깥의 resultJson 실데이터,
//   확정·제약 경로(argSpecs·spec.path·artifacts)의 절대경로.
// - 교정(redact, 차단 아님): 토큰 패턴 전역, 이메일은 산문만
//   (실행·평가 입력 params/args/resultJson/resultSummary는 원문 유지).
// 위반이 있으면 전송하지 않고 bad_request (호출자 코드 수정 사항).

export type EgressCheck = { body: unknown; violations: string[]; redactions: number };

const RESULT_JSON_META_KEYS = ["sha256", "size", "preview"];

function isMetaShape(v: unknown): boolean {
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
  "resultSummary", "message", "text", "question", "note", "reason",
  "summary", "goal", "instruction", "request",
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

export function inspectEgress(method: string, body: unknown): EgressCheck {
  const violations: string[] = [];
  let redactions = 0;
  const clone: unknown = JSON.parse(JSON.stringify(body));
  const inReport = method === "pfReport";

  // mode: normal(검사+교정) | prose(교정만) | data(면제).
  // params/args/resultJson은 실행·평가·바인딩 입력이라 원문 유지
  // (--param 절대경로는 정상 사용. M3 상대경로 규칙은 runner가 담당).
  type Mode = "normal" | "prose" | "data";
  const walk = (v: unknown, key: string | null, mode: Mode): unknown => {
    if (typeof v === "string") {
      let s = v;
      if (mode === "normal" || mode === "prose") {
        for (const t of TOKEN_RES) {
          if (t.re.test(s)) {
            s = s.replace(t.re, REDACTED);
            redactions++;
          }
          t.re.lastIndex = 0;
        }
        if (EMAIL_RE.test(s)) {
          s = s.replace(EMAIL_RE, REDACTED);
          redactions++;
        }
        EMAIL_RE.lastIndex = 0;
      }
      if (mode === "data") return v;
      if ((mode === "normal") && !URL_RE.test(s) && ABS_RE.test(s)) {
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
          // pfReport 입력의 평가용 resultJson은 허용 (transient, 저장 안 됨).
          if (!inReport) violations.push(`resultJson 실데이터: ${method} (메타만 허용)`);
          out[k] = walk(x, k, "data");
          continue;
        }
        const next: Mode =
          k === "params" || k === "args" || k === "resultJson" ? "data"
          : PROSE_KEYS.has(k) ? "prose"
          : mode;
        out[k] = walk(x, k, next);
      }
      return out;
    }
    return v;
  };

  return { body: walk(clone, null, "normal"), violations, redactions };
}

/** 위반이면 전송 차단 (호출자 수정 사항). */
export function guardEgress(method: string, body: unknown): { body: unknown; redactions: number } {
  const r = inspectEgress(method, body);
  if (r.violations.length > 0) {
    throw pfError("bad_request", `egress 위반: ${r.violations.join("; ")}`);
  }
  return { body: r.body, redactions: r.redactions };
}
