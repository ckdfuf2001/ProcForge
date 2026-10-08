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

export const ErrorCodes = {
  NOT_FOUND: "not_found",
  BAD_REQUEST: "bad_request",
  CONFLICT: "conflict",
  DEGRADED: "degraded",
  INTERNAL: "internal",
} as const;
