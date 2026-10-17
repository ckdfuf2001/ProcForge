import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { pfError } from "@procforge/shared/errors.js";

// M7-ui3: 산출물 원문 미리보기·전문 보기 (로컬 전용).
// R8: 원문은 요청 시 로컬에서만 읽는다 (원격 core 모드에서도 전송 0).
// sandbox 밖·상한 밖은 거부.

export const PREVIEW_MAX_BYTES = 4096;
export const ARTIFACT_MAX_BYTES = 5 * 1024 * 1024;

const MIME: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/plain",
  ".json": "text/plain",
  ".csv": "text/plain",
  ".log": "text/plain",
  ".html": "text/plain", // R8: HTML도 텍스트로만 (브라우저 렌더 금지)
  ".htm": "text/plain",
  ".xml": "text/plain",
  ".yml": "text/plain",
  ".yaml": "text/plain",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
};

export function mimeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** 텍스트로 볼 수 있는 종류 (확장자 기준, 이진 판정 재사용) */
export function isTextKind(path: string): boolean {
  return mimeOf(path) === "text/plain";
}

/** sandbox 밖 경로 거부 */
export function assertInsideSandbox(sandboxRoot: string, rel: string): string {
  const root = resolve(sandboxRoot);
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw pfError("bad_request", `sandbox 밖 경로: ${rel}`);
  }
  return abs;
}

export type ArtifactPreview = {
  rel: string;
  sha256: string;
  size: number;
  mime: string;
  /** 텍스트면 앞 4KB, 이진이면 null */
  text: string | null;
  truncated: boolean;
};

/** attempt 산출물 1건 미리보기 (없으면 null) */
export function previewArtifact(
  sandboxRoot: string,
  rel: string,
): ArtifactPreview | null {
  const abs = assertInsideSandbox(sandboxRoot, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  const size = statSync(abs).size;
  const buf = readFileSync(abs);
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const mime = mimeOf(abs);
  if (!isTextKind(abs)) {
    return { rel, sha256, size, mime, text: null, truncated: false };
  }
  const slice = buf.subarray(0, PREVIEW_MAX_BYTES);
  return {
    rel,
    sha256,
    size,
    mime,
    text: slice.toString("utf8"),
    truncated: size > PREVIEW_MAX_BYTES,
  };
}

/** attempt 산출물 전문 (5MB 상한, 텍스트로만 내려준다) */
export function readArtifact(
  sandboxRoot: string,
  rel: string,
): { bytes: Buffer; mime: string } {
  const abs = assertInsideSandbox(sandboxRoot, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw pfError("not_found", `산출물 없음: ${rel}`);
  }
  const size = statSync(abs).size;
  if (size > ARTIFACT_MAX_BYTES) {
    throw pfError("bad_request", `산출물 상한 초과 (${size}B > ${ARTIFACT_MAX_BYTES}B): ${rel}`);
  }
  return { bytes: readFileSync(abs), mime: mimeOf(abs) };
}