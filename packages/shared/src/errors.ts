import { z } from "zod";

// MCP 도구 에러 봉투: { error: { code, message, hint } }
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    hint: z.string().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

export function toError(
  code: string,
  message: string,
  hint?: string,
): ErrorEnvelope {
  return { error: { code, message, hint } };
}

/** 코드 목록 (M4.2-0, 가이드 2절 계약·봉투 공용) */
export const ERROR_CODE_LIST = [
  "bad_request",
  "bad_args",
  "conflict",
  "not_found",
  "session_not_found",
  "unimplemented",
  "internal",
  /** fs 실패 (M5.8.1-3: 입력 수정으로 해결 안 됨, 재시도 또는 디스크/권한 확인) */
  "io_error",
  /** ref 필드가 상류 출력에 없음 (M5.8.2 후속: 바인딩 수정으로 해결) */
  "bad_ref_field",
  /** API 키 없음·불일치 (M6-2: core-server Bearer 인증) */
  "unauthorized",
] as const;
export type ErrorCode = (typeof ERROR_CODE_LIST)[number];

export class ProcForgeError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "ProcForgeError";
    this.code = code;
    if (hint !== undefined) this.hint = hint;
  }
}

export function pfError(code: ErrorCode, message: string, hint?: string): ProcForgeError {
  return new ProcForgeError(code, message, hint);
}

/** 에러에서 코드 추출. 등록 외·부재는 internal */
export function errorCodeOf(e: unknown): ErrorCode {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" && (ERROR_CODE_LIST as readonly string[]).includes(c)
    ? (c as ErrorCode)
    : "internal";
}

export type ParsedErrorText = {
  code: string;
  message: string;
  hint?: string;
};

/**
 * 에러 텍스트 파서 (M5.3-0-3). 형식 고정:
 * 첫 줄 "<code>: <message>", 선택 둘째 줄 "hint: <hint>".
 * 형식이 아니면 null (외부/SDK 에러는 파싱하지 않음).
 */
export function parseErrorText(text: string): ParsedErrorText | null {
  const lines = text.trim().split("\n");
  const m = /^([A-Za-z0-9_]+): ([\s\S]*)$/.exec(lines[0] ?? "");
  if (!m) return null;
  // M5.3-6: 등록 코드만 파싱 (미등록·외부는 null)
  if (!(ERROR_CODE_LIST as readonly string[]).includes(m[1])) return null;
  const out: ParsedErrorText = { code: m[1], message: m[2].trim() };
  if (lines.length === 1) return out;
  if (lines.length > 2) return null;
  const hm = /^hint:\s?(.*)$/.exec(lines[1].trim());
  if (!hm || hm[1].length === 0) return null;
  out.hint = hm[1];
  return out;
}
