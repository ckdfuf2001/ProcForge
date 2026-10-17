import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, extname, resolve, sep } from "node:path";
import { pfError } from "@procforge/shared/errors.js";

// M7-ui3: 산출물 원문 미리보기·전문 보기 (로컬 전용).
// R8: 원문은 요청 시 로컬에서만 읽는다 (원격 core 모드에서도 전송 0).
// 경로는 core가 정한 attempt.artifacts[idx]만 쓴다 (클라 문자열 금지).

export const PREVIEW_MAX_BYTES = 4096;
export const ARTIFACT_MAX_BYTES = 5 * 1024 * 1024;
export const NODE_HISTORY_MAX = 200;

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

/** 텍스트로 볼 수 있는 종류 (확장자 기준) */
export function isTextKind(path: string): boolean {
  return mimeOf(path) === "text/plain";
}

/**
 * realpath 기준 root 하위 검사. 심링크가 root 밖을 가리키면 거부한다
 * (문자열 prefix 검사로는 심링크 탈출을 막을 수 없다).
 * 파일이 없으면 404로 알린다 — 원격 core 모드에서는 로컬에 없을 수 있고,
 * 존재하지 않는 경로를 500으로 흘리면 버그를 숨긴다.
 */
export function assertInsideRoot(root: string, abs: string): string {
  const realRoot = existsSync(root) ? realpathSync(root) : resolve(root);
  let real: string;
  try {
    real = realpathSync(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw pfError("not_found", "산출물이 없습니다.");
    }
    throw pfError("bad_request", "산출물 경로를 확인할 수 없습니다.");
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw pfError("bad_request", "산출물이 허용 디렉터리 밖입니다.");
  }
  return real;
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

type DigestCacheEntry = { sha256: string; size: number; mtimeMs: number };
const digestCache = new Map<string, DigestCacheEntry>();

/** 테스트용 캐시 비우기 */
export function resetArtifactCache(): void {
  digestCache.clear();
}

/** sha256 + size 스트림 계산 ((path,size,mtime) 캐시로 재계산 생략) */
export function digestOf(abs: string): Promise<{ sha256: string; size: number }> {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch (e) {
    return Promise.reject(
      (e as NodeJS.ErrnoException).code === "ENOENT"
        ? pfError("not_found", "산출물이 없습니다.")
        : pfError("bad_request", "산출물 경로를 확인할 수 없습니다."),
    );
  }
  const hit = digestCache.get(abs);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
    return Promise.resolve({ sha256: hit.sha256, size: hit.size });
  }
  return new Promise((resolvePromise, reject) => {
    const h = createHash("sha256");
    let size = 0;
    const rs = createReadStream(abs);
    rs.on("data", (c: Buffer) => {
      h.update(c);
      size += c.length;
    });
    rs.on("error", (e: NodeJS.ErrnoException) => {
      reject(
        e.code === "ENOENT"
          ? pfError("not_found", "산출물이 없습니다.")
          : pfError("bad_request", "산출물을 읽을 수 없습니다."),
      );
    });
    rs.on("end", () => {
      const sha256 = h.digest("hex");
      digestCache.set(abs, { sha256, size, mtimeMs: st.mtimeMs });
      resolvePromise({ sha256, size });
    });
  });
}

/** attempt 산출물 1건 미리보기 (앞 4KB만 읽는다) */
export async function previewArtifact(
  sessionRoot: string,
  rel: string,
): Promise<ArtifactPreview | null> {
  const abs = resolve(sessionRoot, rel);
  let real: string;
  try {
    real = assertInsideRoot(sessionRoot, abs);
  } catch {
    return null;
  }
  if (!existsSync(real) || !statSync(real).isFile()) return null;
  const mime = mimeOf(real);
  const { sha256, size } = await digestOf(real);
  if (!isTextKind(real)) {
    return { rel, sha256, size, mime, text: null, truncated: false };
  }
  // 미리보기는 앞 4KB만 읽는다 (큰 산출물 전체를 읽지 않는다).
  const rs = createReadStream(real, { start: 0, end: Math.max(0, PREVIEW_MAX_BYTES - 1) });
  const chunks: Buffer[] = [];
  try {
    for await (const c of rs) chunks.push(c as Buffer);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  return {
    rel,
    sha256,
    size,
    mime,
    text: Buffer.concat(chunks).toString("utf8"),
    truncated: size > PREVIEW_MAX_BYTES,
  };
}

/** attempt 산출물 전문 (5MB 상한, 텍스트로만 내려준다) */
export function readArtifact(
  sessionRoot: string,
  rel: string,
): { bytes: Buffer; mime: string; downloadName: string } {
  const abs = resolve(sessionRoot, rel);
  const real = assertInsideRoot(sessionRoot, abs);
  if (!existsSync(real) || !statSync(real).isFile()) {
    throw pfError("not_found", "산출물이 없습니다.");
  }
  const size = statSync(real).size;
  if (size > ARTIFACT_MAX_BYTES) {
    throw pfError("bad_request", `산출물 상한 초과 (${size}B > ${ARTIFACT_MAX_BYTES}B).`);
  }
  return {
    bytes: readFileSync(real),
    mime: mimeOf(real),
    downloadName: basename(real),
  };
}