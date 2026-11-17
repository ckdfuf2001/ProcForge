# M14-0-spec — m75 잔재 근본 조사 (사양만, 구현 없음)

## §0 현황 (단계 0 실측, 파일:행)

- 기준: HEAD `d058c8f` = origin/master, C: 여유 26,948,149,248B (측정 `2026-11-18T05:25:54.9161304+09:00`), `git status --porcelain` 출력 없음, 쓰기 확인 `write-check-ok M14-0` 통과.
- 지금까지 관측한 잔재 3종: `StIFxC` (state.json이 `ready`에서 멈춤, `procedures/slow/`가 통째로 사라지고 runs/·sessions/만 남은 부분 삭제), `ROL7dH` (run 기록은 cancelled로 정상, 폴더만 남음), ui-wait-2 (`failed` 상태, cancel.json 없음, 120초 sleep 노드가 5.79초 만에 fail).
- 정리 함수 정의:
  - `cleanRegisteredTmp` (`packages/shared/src/tmp.ts:20-36`): `rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })` (`:29`). 실패하면 `failed`에 담고 stderr 1줄 후 삼킨다 (`:30-33`). 호출자는 반환값을 검사하지 않는다.
  - `settleRun` (`packages/local/test/tmp-hooks.ts:20-45`): `uiRunCancel` 실패는 삼키고 (`:25-29`), 자식 0 + state가 running/ready 아님을 예산 20초 (`:19`)까지 폴링한다 (`:32-36`). 초과해도 throw하지 않고 stderr 1줄 후 리턴한다 (`:37-42`).
  - `useTmpCleanup` (`:9-13`): afterAll을 가장 나중에 등록해 tmp 정리를 서버 close·자식 종료보다 늦게 돈다.
  - m75 2중망 (`packages/local/test/m75-cancel.test.ts:23-25` afterEach settle, `:30-43` afterAll에서 settle+잔존 자식 kill+`cleanRegisteredTmp` 최대 20회 재시도).
- L3 순서 전체 1회 (inprocess, 워커 `--maxWorkers=2 --minWorkers=1`, 스크립트 `F:\pf-tmp\m14-stage0-run.mjs`, 로그 `F:\pf-tmp\m14-stage0.log`): shared 14파일·91 passed, core 4파일·124 passed, core-server 1파일·6 passed, local 129파일·699 passed·3 skipped, STATUS 0, 소요 77929ms, 시작 `2026-11-17T20:57:23.242Z`. 신규 잔재 0건 → 재현 안 됨.
- 임시 계측: `cleanRegisteredTmp` catch에 rm 오류 코드(stderr)를 남기는 계측을 넣어 위 실행을 돌렸고, 로그에 `[tmp] 정리 실패`·`[settle] timeout` 0건이었다. 계측은 원복했고 `git diff`가 비어 있음을 확인했다.
- ui-wait-2 유사 사례: os.tmpdir() 잔재 전수 스캔 결과 fail detail은 전부 "취소됨" (M13 수정 전 기록)이라 조기 fail 원문은 없음.

## §1 원인 후보 (최대 3개, 근거 원문)

1. afterAll 재시도 루프가 공회전한다. `cleanRegisteredTmp`는 `registry.delete(dir)` (`tmp.ts:23`)를 rm 시도 (`:29`)보다 먼저 수행하므로, 1회 호출 뒤 registry가 빈다. m75 afterAll의 최대 20회 재시도 (`m75-cancel.test.ts:39-42`)는 2회째부터 빈 registry에 대해 `[]`을 받아 즉시 break한다. 즉 EBUSY로 1회 실패한 폴더는 재시도 없이 영구 잔재가 된다.
2. settle이 waiting 중인 drive를 종료로 보지 않는다. `settleRun`의 종료 조건은 자식 0 + state가 running/ready 아님 (`tmp-hooks.ts:32-36`)이라, 승인·생성값 대기(`waiting`, 락 유지) 중인 drive는 정리가 끝난 것으로 통과한다. 그 뒤 `rmSync`가 락을 쥔 drive의 쓰기(로그·state 갱신)와 겹치면 부분 삭제 또는 삭제 후 재생성 파일이 잔재로 남는다.
3. Windows 잠금에 막힌 rm이 조용히 삼켜진다. `cleanRegisteredTmp`는 maxRetries 5회 (`tmp.ts:29`)를 다 써도 실패를 `failed` 반환으로만 남기고 (`:30-33`), 호출자(`useTmpCleanup`, m75 afterEach/afterAll)는 반환값을 검사하지 않는다. 자식 프로세스·열린 로그 핸들이 살아 있으면(`settle` 예산 초과도 throw 없음, `:37-42`) 그 폴더는 통보 없이 남는다.

## §2 수정안 (후보별 1안)

1. 후보 1: 실패한 dir은 registry에 유지하고, `cleanRegisteredTmp`가 반환한 실패 목록을 afterAll이 N회 재시도한다 (성공한 것만 registry에서 제거).
2. 후보 2: settle 종료 조건에 `waiting`·`suspended`를 active로 포함하거나, driveRun 종료(하트비트 정지) 확인을 rm 전제로 둔다.
3. 후보 3: 정리 실패를 stderr 1줄이 아니라 누적 기록(파일)으로 남기고 tmp-delta 감시와 연결한다. 또는 정리 실패를 테스트 실패로 승격한다.

## §3 테스트 후보

- registry 유지 회귀: rm 1회 실패를 주입해도 같은 dir이 다음 `cleanRegisteredTmp` 호출에서 다시 정리 대상인지.
- afterAll 재시도 회귀: EBUSY 1회 주입 뒤 재시도로 폴더가 사라지는지.
- settle이 waiting run을 기다리는지 (waiting 상태에서 즉시 리턴하지 않는지).
- L3 전체 실행 후 잔재 0 (`tmp-delta` INCREASED_TOTAL 0) — 현행 감시를 유지한다.

## §4 범위 밖 (각 1줄)

- Basic auth 1.18.18 미검증은 별도 건으로 둔다.
- TEMP 안의 `opencode*`와 `node-compile-cache`는 기존대로 삭제하지 않는다.

## §5 판정 요청 (최대 3개)

1. 원인 후보 3개 중 M14-1 구현 대상으로 1개를 지정해 주세요 (권장: 후보 1 registry 유지).
2. settle의 waiting 포함 여부(후보 2)를 M14-1에 포함할지 판정해 주세요.
3. rm 실패를 테스트 실패로 승격할지, 현행 best-effort+감시를 유지할지 판정해 주세요.
