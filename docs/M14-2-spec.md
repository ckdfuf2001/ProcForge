# M14-2-spec — 취소 후 runner가 멈추는 지점 계측과 사양 (제품 코드 변경 없음)

## §0 단계 0 실측 (파일:행)

- 기준 HEAD `ce69904` = origin/master, C: 여유 23,667,482,624B (측정 `2026-11-18T22:04:53.0821133+09:00`), `git status --porcelain` 출력 없음, 쓰기 확인 `write-check-ok M14-2-diag` 통과.
- script-run 자식 종료 대기 (`packages/local/src/runner/script-run.ts`) 원문:
  - `:218-222`:
  - `const cancelWatch = input.isCancelled`
  - `? setInterval(() => {`
  - `if (input.isCancelled?.()) terminate();`
  - `}, 200)`
  - `: undefined;`
  - `:257-262`:
  - `child.on("close", (code, signal) => {`
  - `done(() => {`
  - `if (input.isCancelled?.()) {`
  - `reject(Object.assign(new Error("취소됨"), { code: "cancelled" }));`
  - `return;`
  - 종료 Promise는 `done()`에서만 settle하고 (`:229-242`), `done` 호출자는 child `error` (`:248`)와 `close` (`:257`)뿐이다. `exit` 리스너는 없다. `done`은 종료 처리(`terminating`) 완료까지 기다린다 (`:241`).
- await 사슬 (시간 제한 없는 await는 ★):
  - ★ `run.ts:1250` `const o = await runScript({...})` — Promise는 close/error에서만 settle한다.
  - ★ `run.ts:537` (메인 루프) / `:1721` (map 항목) / `:2008` (until 항목) `await execNode` — 상한 없음.
  - catch (`run.ts:575-587`)는 await 없이 NodeResult로 변환한다.
  - runSession 종료: report.json 기록 (`run.ts:684`) 후 `return report` (`:836`).
  - ★ `app.ts:4699` (runStep) `const report = await runSession({...})` — 상한 없음.
  - ★ `app.ts:4314` (driveRun) `const step = await this.runStep(runId, {unattended:true})` — 상한 없음.
  - `app.ts:3520` launchDrive `void this.driveRun(...)` — await 없음 (fire-and-forget, `.catch` 로그만).
  - `app.ts:4547` finishRun — sync (await 없음, appendRunLog+releaseRun).
- 정상 취소 run 로그 전문 (`F:\pf-tmp` 임시 테스트, 실행 후 삭제):
  - `{"seq":1,...,"message":"실행 시작: slow (phase:started)"}`
  - `{"seq":2,...,"message":"취소 요청 (자식 1개 종료 시도) (phase:cancelled)"}`
  - `{"seq":3,...,"message":"취소됨 (phase:cancelled)"}`
- 47YWVB 로그 전문 (4줄):
  - `{"seq":1,"at":"2026-11-18T12:46:01.916Z",...,"message":"실행 시작: slow (phase:started)"}`
  - `{"seq":2,"at":"2026-11-18T12:46:03.032Z",...,"message":"취소 요청 (자식 1개 종료 시도) (phase:cancelled)"}`
  - `{"seq":3,"at":"2026-11-18T12:46:03.877Z",...,"message":"취소 요청 (자식 1개 종료 시도) (phase:cancelled)"}`
  - `{"seq":4,"at":"2026-11-18T12:46:28.124Z",...,"message":"취소 요청 (자식 1개 종료 시도) (phase:cancelled)"}`
- 빠진 phase 1줄: 정상 run의 `취소됨 (phase:cancelled)` (markCancelled→finishRun) 3번째 줄이 47YWVB에는 없고 `취소 요청`만 3회 있다.
- 47YWVB (`C:\Users\oh\AppData\Local\Temp\pf-cancel-e2e-47YWVB`, mtime `2026-11-18T21:46:01.5010938+09:00`)는 경로·mtime 1줄 보고 후 삭제했다.

## §1 H1~H3 (근거·반증)

- H1: script-run이 `close`를 기다리는데 stdio 파이프를 쥔 프로세스가 남아 `close`가 오지 않는다. 근거: 종료 Promise는 `close`/`error`에서만 settle하고 (`script-run.ts:229-242`, `exit` 리스너 없음), 타임아웃 타이머도 terminate 후 `close`를 기다린다 (`:224-241`). 반증: 아직 없음 ([settle] dump 집계 대상).
- H2: kill 후 reject 경로가 아예 없다. 근거: kill은 cancel 감시 (`:218-221`)와 uiRunCancel의 killProcessTree (`run-control.ts:126-130`)에서 수행되지만, reject는 `close` 핸들러 (`script-run.ts:259-262`)에서만 발생한다. 반증: 정상 취소 run은 close→reject→cancelled로 끝나므로 경로 자체는 존재한다 (M14-2 단계 0 실측). H1과 합쳐서 본다.
- H3: catch 뒤 finishRun 앞의 다른 await가 멈춘다. 근거: await 사슬 §0 (run.ts:537→catch→:836→app.ts:4699→:4314→finishRun :4547). 반증: catch는 await 없이 NodeResult로 변환하고 runSession은 report.json을 기록하는데, 47YWVB에 report.json이 없다는 것은 rm 이후 관측이라 근거가 아니다. settle 시점 report 유무는 [settle] dump가 찍는다.

## §2 가설별 수정안 1개 (M14-3 후보, 본 배치 제품 코드 변경 금지)

- H1: `close` 미도래 시 강제 settle (예: terminate 후 유예 타임아웃으로 reject하고 파이프 보유자를 로그에 남김).
- H2: H1과 같은 곳에서 다루므로 H1안과 묶는다 (reject 보장 지점을 `close`에서 terminate 완료 시점으로 넓힘).
- H3: finishRun까지 await 사슬에 상한을 두거나 단계별 heartbeat를 기록해 멈춘 단계를 특정한다.

## §3 테스트 후보

- [settle] dump 발화 시 run 상태·report 유무·children·active·log phase 확인 (M14-1-fix2 committed 계측).
- L3 로그 집계는 `pf-reg-*`(tmp-registry 주입)를 제외하고 세고, 제외한 수는 1줄로 따로 보고한다.
- 정상 취소와 stuck 취소의 log phase 대조 (phase `취소됨` 유무).
- 단독 실행과 L3 부하 실행의 재현율 비교 (타이밍 의존 확인용).

## §4 범위 밖 (각 1줄)

- Basic auth 1.18.18 미검증은 별도 건으로 둔다.
- TEMP 안의 `opencode*`와 `node-compile-cache`는 기존대로 삭제하지 않는다.

## §5 판정 요청 (최대 3개)

1. H1~H3 중 M14-3 구현 대상으로 1개를 지정해 주세요 (관측상 H1이 가장 유력).
2. close 미도래 시 강제 settle(제품 코드)을 M14-3에 포함할지 판정해 주세요.
3. await 사슬 상한(heartbeat/타임아웃) 계측을 M14-3에 포함할지 판정해 주세요.
