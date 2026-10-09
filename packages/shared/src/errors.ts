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
