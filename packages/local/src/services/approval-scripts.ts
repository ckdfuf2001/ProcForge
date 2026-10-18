import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  statSync,
  realpathSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { pfError } from "@procforge/shared/errors.js";
import { join, resolve, sep } from "node:path";

// M7-5-e/g: 승인한 스크립트 **스냅샷** + 안전한 읽기.
// - 스냅샷은 procedures/<name>/approved/<sha256>.snap 에 본문 그대로 남기고,
//   노드별 경로는 approved/index.json 에 둔다.
//   (승인 이력의 args 는 zod 정규화로 여분 키가 사라진다 — 거기 넣으면 못 찾는다)
// - 읽기는 realpath 로 sandbox 안에 있는지 확인하고 5MB 상한을 건다.
//   rel 은 모델이 pf_confirm_leaf 에서 적은 값이라 "../" 가 들어갈 수 있다.

/** M7-ui3-3 과 같은 상한 */
export const SCRIPT_READ_MAX_BYTES = 5 * 1024 * 1024;

export function approvedDir(procedureDir: string): string {
  return join(procedureDir, "approved");
}

/** 승인 스냅샷 저장 + 노드별 인덱스 갱신 */
export function saveApprovedSnapshot(
  procedureDir: string,
  nodeId: string,
  content: string,
): { snapshotRel: string; sha256: string } {
  const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
  const dir = approvedDir(procedureDir);
  mkdirSync(dir, { recursive: true });
  // 반환값은 approved/ 안의 **파일명만** (호출부가 디렉터리와 합친다)
  const snapshotRel = `${sha256}.snap`;
  writeFileSync(join(dir, snapshotRel), content, "utf8");
  const idxPath = join(dir, "index.json");
  let idx: Record<string, string> = {};
  if (existsSync(idxPath)) {
    try {
      idx = JSON.parse(readFileSync(idxPath, "utf8")) as Record<string, string>;
    } catch {
      idx = {};
    }
  }
  idx[nodeId] = snapshotRel;
  writeFileSync(idxPath, JSON.stringify(idx, null, 2), "utf8");
  return { snapshotRel, sha256 };
}

/** 이 노드의 승인 스냅샷 (없으면 undefined) */
export function readApprovedSnapshot(
  procedureDir: string,
  nodeId: string,
): string | undefined {
  const idxPath = join(approvedDir(procedureDir), "index.json");
  if (!existsSync(idxPath)) return undefined;
  let idx: Record<string, string>;
  try {
    idx = JSON.parse(readFileSync(idxPath, "utf8")) as Record<string, string>;
  } catch {
    return undefined;
  }
  const name = idx[nodeId];
  if (!name) return undefined;
  const p = join(approvedDir(procedureDir), name);
  if (!existsSync(p)) return undefined;
  return readFileSync(p, "utf8");
}

/**
 * 세션 산출물/스크립트를 안전하게 읽는다.
 * - realpath 기준 root 하위 (심링크 탈출 차단)
 * - 5MB 상한
 * 실패는 pfError(not_found / bad_request).
 */
export function readSandboxed(
  root: string,
  rel: string,
  maxBytes = SCRIPT_READ_MAX_BYTES,
): string {
  if (rel.includes("\0")) throw pfError("bad_request", "경로에 NUL 이 있다.");
  const abs = resolve(root, rel);
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    throw pfError("not_found", "루트가 없다.");
  }
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    throw pfError("not_found", "파일이 없다.");
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw pfError("bad_request", "허용 디렉터리 밖이다.");
  }
  let size: number;
  try {
    size = statSync(real).size;
  } catch {
    throw pfError("not_found", "파일이 없다.");
  }
  if (size > maxBytes) {
    throw pfError("bad_request", `상한 초과 (${size}B > ${maxBytes}B).`);
  }
  return readFileSync(real, "utf8");
}
