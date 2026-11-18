# M14-0-spec — m75 잔재 근본 조사 (사양만, 구현 없음)

## §0 현황 (단계 0 실측, 파일:행)

- 기준: HEAD `cab58bd` = origin/master, C: 여유 29,911,478,272B (측정 `2026-11-18T06:33:55.1592663+09:00`, M14-1-impl 단계 0 실측 — M14-0 단계 0의 C: 값은 철회되어 같은 단계 0 실측값 하나로 맞춘다), `git status --porcelain` 출력 없음, 쓰기 확인 `write-check-ok M14-1-impl` 통과.
- 관측한 누출 2종: `StIFxC` (state.json이 `ready`에서 멈춤, `procedures/slow/`가 통째로 사라지고 runs/·sessions/만 남은 부분 삭제), ui-wait-2 (`failed` 상태, cancel.json 없음, 120초 sleep 노드가 5.79초 만에 fail). `ROL7dH`은 누출이 아니라 M13 세션에서 `PROOF_KEEP_TMP=1`로 일부러 남긴 KEEP 잔재이므로 (`tmp.ts:24-27`이면 삭제를 건너뜀) 목록에서 뺀다.
- `UKKUDS` (M14-1 L3 누출, ready 고착 + procedures 부분 삭제, settle timeout 2회 + EPERM 재시도 약 20회 뒤 afterAll hook 30초 초과, cancel.json·report.json 없음은 rm 이후 관측이라 근거가 아니다).
- `ccaGwP` (M14-1-fix L3 누출, run `1ba98636`: 12:14:31 시작 후 12:14:32/33/57 취소 요청 3회에도 31초 이상 `ready` 유지, report.json·cancel.json 없음, `procedures/` 소실). 부분 삭제 폴더에서 report.json·cancel.json이 없다는 것은 근거가 아니다 (rm이 지웠을 수 있으므로 cancelJson 계측은 rm 이전 시점인 settle 안에서 찍는다).
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
2. (약함) settle이 waiting 중인 drive를 종료로 보지 않는다 — 다만 `settleRun`은 맨 처음 `uiRunCancel`을 부르므로 (`tmp-hooks.ts:25-29`), waiting 중인 run은 `markCancelled`로 `cancelled`가 되어 active 판정 (`:35`)에서 벗어난다. m75의 slow 절차서에는 승인 대기도 없고, StIFxC의 `ready` 고착은 settle 조건에서 active이므로 settle은 20초 대기 후 timeout을 stderr에 찍고 넘어간다. 따라서 단독 원인이라기보다 "settle timeout을 삼킨 뒤 rm 1회 실패"(후보 1과 3의 결합)로 본다.
3. Windows 잠금에 막힌 rm이 조용히 삼켜진다. `cleanRegisteredTmp`는 maxRetries 5회 (`tmp.ts:22`)를 다 써도 실패를 `failed` 반환으로만 남기고 (`:37-44`), 호출자(`useTmpCleanup`, m75 afterEach/afterAll)는 반환값을 검사하지 않는다. 자식 프로세스·열린 로그 핸들이 살아 있으면(`settle` 예산 초과도 throw 없음, `tmp-hooks.ts:37-42`) 그 폴더는 통보 없이 남는다. 구체화(M14-1·M14-1-fix2에서 구현): 실패 dir은 registry에 유지하고 (`tmp.ts:25-44`), 실패 시 stderr에 `code=`를 기록하며 (`:40`), settle cancel 실패는 `[settle] cancel 실패` (`tmp-hooks.ts:32`), timeout 시점 cancelJson 유무는 `cancelJson=있음|없음` (`tmp-hooks.ts:46-50`), 잔재 run 상태는 `[tmp] 잔재` (`m75-cancel.test.ts:57-65`)로 남긴다. 재시도는 8초 마감 `cleanRegisteredTmpUntil` (`tmp.ts:51-62`, m75 `:33,45`)로 묶고 마감 초과도 FAIL하지 않는다.

## §2 수정안 (후보별 1안)

1. 후보 1: 실패한 dir은 registry에 유지하고, `cleanRegisteredTmp`가 반환한 실패 목록을 afterAll이 N회 재시도한다 (성공한 것만 registry에서 제거).
2. 후보 2는 이번에 넣지 않는다. 대신 settle이 timeout되면 그 run의 상태가 정리 실패 기록에 남도록 후보 3의 기록과 묶는다.
3. 후보 3: 정리 실패를 stderr 1줄이 아니라 누적 기록(파일)으로 남기고 tmp-delta 감시와 연결한다.

## §3 테스트 후보

- registry 유지 회귀: rm 1회 실패를 주입해도 같은 dir이 다음 `cleanRegisteredTmp` 호출에서 다시 정리 대상인지.
- afterAll 재시도 회귀: EBUSY 1회 주입 뒤 재시도로 폴더가 사라지는지.
- settle이 waiting run을 기다리는지 (waiting 상태에서 즉시 리턴하지 않는지).
- L3 전체 실행 후 잔재 0 (`tmp-delta` INCREASED_TOTAL 0) — 현행 감시를 유지한다.

## §4 범위 밖 (각 1줄)

- Basic auth 1.18.18 미검증은 별도 건으로 둔다.
- TEMP 안의 `opencode*`와 `node-compile-cache`는 기존대로 삭제하지 않는다.

## §5 판정 확정 (M14-0 판정 반영)

1. M14-1은 후보 1로 구현한다. rm에 실패한 dir은 registry에 남기고, 성공했을 때만 registry에서 지운다. m75 afterAll의 재시도 루프가 실제로 동작하게 된다.
2. 후보 2(settle에 waiting 포함)는 이번에 넣지 않는다. 대신 settle이 timeout되면 그 run의 상태가 정리 실패 기록에 남도록 후보 3의 기록과 묶는다.
3. rm 실패를 테스트 실패로 바꾸지 않고, 지금처럼 best-effort로 두고 감시한다. 다만 마지막까지 실패하면 stderr 1줄에 오류 코드를 넣는다 (`[tmp] 정리 실패(남김): <dir> code=<EBUSY|EPERM|...>`). Windows CI에서 생길 불안정을 피하려는 것이다.
