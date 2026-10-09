import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

// 의존성 없는 최소 zip 작성/읽기 (STORE 방식, 결정적). export용.

function crc32(buf: Buffer): number {
  let table: number[] | undefined = (crc32 as { t?: number[] }).t;
  if (!table) {
    table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    (crc32 as { t?: number[] }).t = table;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export type ZipEntry = { name: string; data: Buffer };

export function writeZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const fixedDate = Buffer.from([0x00, 0x00, 0x21, 0x00]); // 1980-01-01 (결정적)
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 8); // UTF-8
    local.writeUInt16LE(0, 10);
    fixedDate.copy(local, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, e.data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    fixedDate.copy(cen, 12);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(e.data.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    for (const [o, v] of [[30, 0], [32, 0], [34, 0], [36, 0]] as [number, number][]) cen.writeUInt16LE(v, o);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + e.data.length;
  }
  const centralStart = offset;
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, ...central, end]);
}

/** central directory만 읽어 항목 목록 반환 (테스트 검증용) */
export function listZip(buf: Buffer): { name: string; size: number }[] {
  const out: { name: string; size: number }[] = [];
  let i = buf.length - 22;
  while (i >= 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  if (i < 0) throw new Error("not a zip");
  const count = buf.readUInt16LE(i + 10);
  let p = buf.readUInt32LE(i + 16);
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory");
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const size = buf.readUInt32LE(p + 24);
    out.push({ name: buf.subarray(p + 46, p + 46 + nameLen).toString("utf8"), size });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** stored entry 본문 추출 (테스트 검증용) */
export function readZipEntry(buf: Buffer, name: string): Buffer {
  let p = 0;
  while (p + 30 <= buf.length) {
    if (buf.readUInt32LE(p) !== 0x04034b50) break;
    const nameLen = buf.readUInt16LE(p + 26);
    const extraLen = buf.readUInt16LE(p + 28);
    const size = buf.readUInt32LE(p + 22);
    const n = buf.subarray(p + 30, p + 30 + nameLen).toString("utf8");
    const dataAt = p + 30 + nameLen + extraLen;
    if (n === name) return buf.subarray(dataAt, dataAt + size);
    p = dataAt + size;
  }
  throw new Error(`entry not found: ${name}`);
}

export type ExportOptions = {
  procforgeDir: string;
  sessionId: string;
  outPath: string;
  redact?: boolean;
  includeOriginals?: boolean;
};

/** 세션 폴더를 zip으로 export. redact면 파일 내용은 {sha256,size} 기술자로 대체 */
export function exportSession(opts: ExportOptions): { outPath: string; files: number; redacted: boolean } {
  const src = join(opts.procforgeDir, "sessions", opts.sessionId);
  if (!existsSync(src)) throw Object.assign(new Error(`세션 없음: ${opts.sessionId}`), { code: "session_not_found" });
  const redact = opts.redact ?? false;
  const keepOriginal = !redact || opts.includeOriginals === true;
  const entries: ZipEntry[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      const rel = relative(src, p).replace(/\\/g, "/");
      const buf = readFileSync(p);
      if (keepOriginal) entries.push({ name: rel, data: buf });
      if (redact) {
        const meta = JSON.stringify({
          redacted: true,
          sha256: createHash("sha256").update(buf).digest("hex"),
          size: buf.length,
        });
        entries.push({ name: keepOriginal ? `${rel}.redacted.json` : rel, data: Buffer.from(meta, "utf8") });
      }
    }
  };
  walk(src);
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  mkdirSync(dirname(opts.outPath), { recursive: true });
  writeFileSync(opts.outPath, writeZip(entries));
  return { outPath: opts.outPath, files: entries.length, redacted: redact && !keepOriginal };
}
