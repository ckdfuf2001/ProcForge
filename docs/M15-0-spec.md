# M15-0-spec — 타임아웃 경로 grace 적용 (사양만, 구현 없음)

## §0 단계 0 실측 (파일:행)

- 기준 HEAD `e5a38ac` = origin/master, C: 여유 23,177,474,048B (측정 `2026-11-20T14:03:00.2662079+09:00`), `git status --porcelain` 출력 없음, 쓰기 확인 `write-check-ok M15-0` 통과.
- 타임아웃 경로 원문 (`packages/local/src/runner/script-run.ts`):
  - 타이머 (`:270-274`): `let timedOut = false;` 뒤 `setTimeout(() => { timedOut = true; terminate(); }, timeout)` — grace를 시작하지 않는다.
  - close 핸들러 (`:332-349`): `closeSeen = true;` 후 `done(...)` 안에서 `isCancelled`면 cancelled, 아니면 `timedOut`이면 reject한다.
  - 타임아웃 reject: detail `스크립트 타임아웃(<timeout>ms): <scriptAbs>`, `{ code: "timeout" }` (`:341-348`).
- TEMP 접두사별 개수 상위 4개 (snap counts 원문, 5개 중 4개만 존재): `{"pf-bench": 1, "pf-dbg": 10, "pf-m13": 5, "pf-remote": 4}` (`F:\pf-tmp\m15-0-obs.json`, `2026-11-20T05:04:53.460Z`).

## §1 타임아웃 경로에 grace를 적용하는 안

- 타임아웃 타이머가 `terminate()`를 부를 때도 같은 grace를 시작한다. `CANCEL_SETTLE_GRACE_MS = 5000`을 재사용한다 (상수 1개 유지, 신규 env 금지).
- grace 만료 시 close 미도래면 강제 reject하고 판별 줄을 남긴다:
  - `타임아웃 강제 종료: close 미도래 (phase:failed)`.
  - terminate 미완료면: `타임아웃 강제 종료: terminate 미완료 (phase:failed)`.
- reject 형태는 기존 타임아웃과 동일하게 `스크립트 타임아웃(...ms)` detail + `code: "timeout"`을 유지한다 (run 레벨 fail 판정은 그대로).

## §2 불변 조건

- 비타임아웃 경로(정상·취소·에러)는 바이트 단위로 동일하다. grace 시작 조건에 타임아웃 분기를 추가할 뿐, 기존 분기의 판정·문구·코드는 바꾸지 않는다.
- 상수는 `CANCEL_SETTLE_GRACE_MS` 하나만 쓰고, 신규 env와 신규 MCP 도구는 만들지 않는다.

## §3 테스트 후보

- runScript 직접 호출(가짜 spawn, `timeoutMs` 작게, close 없음): grace 후 강제 reject + 판별 줄 1줄 (m14-cancel-settle ①② 패턴).
- run.ts 연결 공백을 메우는 방법 1안: `onCancelForced` → `recordCancelForced` 바인딩을 내보낸 팩토리 함수로 분리하고 직접 호출해 run 로그 1줄과 children 해제를 단언한다 (⑤⑥ 패턴을 타임아웃용 `onTimeoutForced`에도 적용).
- L3 로그 집계는 `pf-reg-*`와 m14 테스트 주입분을 제외하고 세고, 제외한 수는 1줄로 따로 보고한다.

## §4 범위 밖 (각 1줄)

- Basic auth 1.18.18 미검증은 별도 건으로 둔다.
- H3(await 사슬 상한)는 본 건에서 다루지 않는다.
- TEMP 안의 `opencode*`와 `node-compile-cache`는 기존대로 삭제하지 않는다.

## §5 판정 요청 (최대 3개)

1. 타임아웃 경로에 grace를 적용하는 §1 안을 채택하는지, 상수는 `CANCEL_SETTLE_GRACE_MS` 재사용으로 할지 판정해 주세요.
2. 판별 줄 문구(`타임아웃 강제 종료: <사유> (phase:failed)`)와 reject 형태 유지(timeout detail + code)를 확정해 주세요.
3. run.ts 연결 공백 해소(추출+직접 호출 테스트)를 M15-1에 포함할지 판정해 주세요.
