# M14-2-spec — 취소 후 runner가 멈추는 지점 계측과 사양 (제품 코드 변경 없음)

## §0 단계 0 실측 (파일:행)

- 기준 HEAD `ce69904` = origin/master, C: 여유 23,667,482,624B (측정 `2026-11-18T22:04:53.0821133+09:00`), `git status --porcelain` 출력 없음, 쓰기 확인 `write-check-ok M14-2-diag` 통과.
- script-run 자식 종료 대기 (`packages/local/src/runner/script-run.ts`) 원문:
```
  const cancelWatch = input.isCancelled
    ? setInterval(() => {
        if (input.isCancelled?.()) terminate();
      }, 200)
    : undefined;
```
(`:218-222`)
```
  child.on("close", (code, signal) => {
    done(() => {
      if (input.isCancelled?.()) {
        reject(Object.assign(new Error("취소됨"), { code: "cancelled" }));
        return;
```
(`:257-262`)
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
```
{"seq":1,"at":"2026-11-18T13:06:12.769Z","level":"info","message":"실행 시작: slow (phase:started)"}
{"seq":2,"at":"2026-11-18T13:06:13.251Z","level":"info","message":"취소 요청 (자식 1개 종료 시도) (phase:cancelled)"}
{"seq":3,"at":"2026-11-18T13:06:13.421Z","level":"info","message":"취소됨 (phase:cancelled)"}
```
- 47YWVB 로그 전문 (4줄):
```
{"seq":1,"at":"2026-11-18T12:46:01.916Z","level":"info","message":"실행 시작: slow (phase:started)"}
{"seq":2,"at":"2026-11-18T12:46:03.032Z","level":"info","message":"취소 요청 (자식 1개 종료 시도) (phase:cancelled)"}
{"seq":3,"at":"2026-11-18T12:46:03.877Z","level":"info","message":"취소 요청 (자식 1개 종료 시도) (phase:cancelled)"}
{"seq":4,"at":"2026-11-18T12:46:28.124Z","level":"info","message":"취소 요청 (자식 1개 종료 시도) (phase:cancelled)"}
```
- 빠진 phase 1줄: 정상 run의 `취소됨 (phase:cancelled)` (markCancelled→finishRun) 3번째 줄이 47YWVB에는 없고 `취소 요청`만 3회 있다.
- 비고: loopback/remote 모드에서도 app은 로컬 ProcForgeApp이라 `listActiveRuns`가 있어 `active=있음/없음`이 찍힌다. `active=?`는 예외 시 미측정 표시이다.
- 47YWVB (`C:\Users\oh\AppData\Local\Temp\pf-cancel-e2e-47YWVB`, mtime `2026-11-18T21:46:01.5010938+09:00`)는 경로·mtime 1줄 보고 후 삭제했다.

## §1 H1·H3·H4 (근거·반증)

- H1: script-run이 `close`를 기다리는데 stdio 파이프를 쥔 프로세스가 남아 `close`가 오지 않는다. 근거: 종료 Promise는 `close`/`error`에서만 settle하고 (`script-run.ts:229-242`, `exit` 리스너 없음), 타임아웃 타이머도 terminate 후 `close`를 기다린다 (`:224-241`). 반증: 아직 없음 ([settle] dump 집계 대상).
- H4: `done`이 `terminating` 완료를 기다린다 (`script-run.ts:241`). 근거: `terminate`는 `killScriptTree→killProcessTree` (`script-run.ts:25-28`, `services/process-tree.ts:42-63`)이고 Windows `taskkill` 자식에는 타임아웃이 없어 (`:48-62`), 부하로 taskkill 실행이 끝나지 않으면 `done`의 `Promise.resolve(terminating).then(fn)`이 영원히 실행되지 않는다. L3 부하에서만 재현되는 점과 맞는다. 반증: 아직 없음.
- H3: catch 뒤 finishRun 앞의 다른 await가 멈춘다. 근거: await 사슬 §0 (run.ts:537→catch→:836→app.ts:4699→:4314→finishRun :4547). 반증: 자식은 죽었는데 Promise가 settle되지 않은 관측(47YWVB·ccaGwP)은 H1/H4 쪽을 가리킨다. H3 완전 기각은 아니다 (settle 시점 report 미측정).

## §2 가설별 수정안 1개 (M14-3 후보, 본 배치 제품 코드 변경 금지)

- H1+H4: terminate를 시작한 뒤 `CANCEL_SETTLE_GRACE_MS = 5000`(상수 1개, 신규 env 금지)이 지나도 settle되지 않으면 `cancelled`로 강제 reject한다. 판별 로그는 둘로 나눈다. `close`가 오지 않은 경우는 `취소 강제 종료: close 미도래 (phase:cancelled)`이다. terminate가 끝나지 않은 경우는 `취소 강제 종료: terminate 미완료 (phase:cancelled)`이다.
- H3: 이번에 하지 않는다 (수정 후에도 `취소됨` 없이 멈춘 run이 나오면 그때 H3를 확정한다. 범위가 넓고 정상 run을 끊을 위험이 있기 때문이다).

## §3 테스트 후보

- [settle] dump 발화 시 run 상태·report 유무·children·active·log phase 확인 (M14-1-fix2 committed 계측).
- L3 로그 집계는 `pf-reg-*`(tmp-registry 주입)를 제외하고 세고, 제외한 수는 1줄로 따로 보고한다.
- 정상 취소와 stuck 취소의 log phase 대조 (phase `취소됨` 유무).
- 단독 실행과 L3 부하 실행의 재현율 비교 (타이밍 의존 확인용).

## §4 범위 밖 (각 1줄)

- Basic auth 1.18.18 미검증은 별도 건으로 둔다.
- TEMP 안의 `opencode*`와 `node-compile-cache`는 기존대로 삭제하지 않는다.

## §5 판정 확정 (M14-0 판정 반영)

1. M14-3은 H1과 H4를 함께 막는 방어 수정으로 진행한다. terminate를 시작한 뒤 `CANCEL_SETTLE_GRACE_MS = 5000`(상수 1개, 신규 env 금지)이 지나도 settle되지 않으면 `cancelled`로 강제 reject하고, `close` 미도래와 terminate 미완료를 로그 2종으로 판별한다.
2. await 사슬 전체에 상한을 두는 것(H3 대응)은 이번에 하지 않는다. 수정 후에도 `취소됨` 없이 멈춘 run이 나오면 그때 H3를 확정한다.
3. 강제 reject 뒤의 자원 처리: 남은 파이프와 리스너는 끊지 않고 그대로 둔다(child 참조는 누출 허용). `cancelWatch` interval만 반드시 clear한다. 비취소 경로의 동작은 바이트 단위로 바꾸지 않는다.
