/**
 * M6-0: @날짜 param 내장 표현. run 시작 시 1회 해석한다 (live만).
 * - `@today:utc`: UTC 오늘 (YYYY-MM-DD).
 * - `@today:local`: 시스템 로컬 오늘.
 * - `@yesterday:utc`: UTC 어제.
 * 해석값은 run 기록(params)에 저장된다. 스케줄러는 내장하지 않으므로
 * 매일 실행 시 운영자가 --param date=@today:utc 형태로 넘긴다.
 */

export const DATE_PARAM_FORMS = ["@today:utc", "@today:local", "@yesterday:utc"] as const;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatDayUTC(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function formatDayLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** @표현 해석. 반환 {params(해석값 치환), resolved(원본→해석값 매핑)} */
export function resolveDateParams(
  params: Record<string, string>,
  now: Date = new Date(),
): { params: Record<string, string>; resolved: Record<string, string> } {
  const out: Record<string, string> = { ...params };
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    let r: string | undefined;
    if (v === "@today:utc") r = formatDayUTC(now);
    else if (v === "@today:local") r = formatDayLocal(now);
    else if (v === "@yesterday:utc") {
      r = formatDayUTC(new Date(now.getTime() - 24 * 60 * 60 * 1000));
    }
    if (r !== undefined) {
      out[k] = r;
      resolved[k] = r;
    }
  }
  return { params: out, resolved };
}
