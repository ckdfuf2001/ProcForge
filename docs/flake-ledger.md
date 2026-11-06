# flake 장부 (M9-tmp-fix)

같은 증상이 3건 더 쌓이면 별도 조사로 돌린다. "환경" 분류는 워커 사망·OS kill 등
프로세스 수준 증거가 있을 때만 적는다. 날짜는 KST.

| 날짜(KST) | HEAD | 단계 | 증상(원문 1줄) | 최고 커밋 메모리 | 단독 재실행 |
|---|---|---|---|---|---|
| 2026-11-04 | M9-1-exit 미적용 코드 (파일 수로 추정) | L3 3-test | `M3 runner > CLI positional UUID는 세션으로 해석`: `expected 3221226505 to be 1` (`test/m3-runner.test.ts`) | 미측정 | 이후 exitCode 전환(`a3690bb`)으로 해소 — flake 아님, 기지 버그 |
| 2026-11-04 | `568dc2d` 전후 (파일 수로 추정) | L3 3-test | `script-run.test.ts > 비정상 종료·비JSON·타임아웃은 throw`: `expected [Function] to throw error matching /타임아웃/ but got '스크립트 비정상 종료(3221225773): ...pf-script-...slow.mjs'` + `Error: Worker exited unexpectedly` (`packages/local/src/runner/script-run.test.ts`, tinypool 워커) | 미측정 | green — 환경(커밋 한도, `3221225773=0xC000012D` 근거) |
| 2026-11-05 | `5ab9712` | L3 3-test | `Error: Worker exited unexpectedly` (tinypool, `packages/local` 스위트) | 미측정 (사후 18GB) | 3회차 green — 환경 |
| 2026-11-05 | `5ab9712` | L3 3-test | 요약 없이 `Failed`로 중단 (m55-state 이후, 워커 사망 추정) | 미측정 | 3회차 green — 환경 |
| 2026-11-06 | `bd35882` | 단독 실행(01:39, L3 외) | `pf-cancel-e2e-WXNrrH` run이 `failed: run fs 밖 변경 감지 (10건+, '-' 삭제분)` + `pf-run-sKPFRE` 고아 (tmp 루트 부분 정리됨, `.procforge/runs/<id>/`만 잔류). 당시 `python.exe`·`node.exe` 잔존 없음, 고아는 잠금 없이 삭제 가능했음 | 미측정 | 단독 재실행 green — m75-cancel 5회· m75-run 5회 모두 통과, `tmp-delta` INCREASED_TOTAL 0. 당시 동시 실행과 경합 의심, 미확정 (재발 시 별도 조사). f4395f7 이후 L3 INCREASED_TOTAL 0 (M9-tmp-2 닫음) |
| 2026-11-06 | `e945e8e` (=f4395f7+4) | L3 3-test (inprocess, --maxWorkers=2) | `m75-cancel > 등록 → 취소 → 프로세스 종료`: `Hook timed out in 10000ms` (11645ms) + `[tmp] 정리 실패(남김): pf-cancel-e2e-fNn5gJ` (mtime 00:19:39Z). 동 파일 2번째 테스트는 1165ms 통과. f4395f7 L3 green 이후 settle-afterEach 적용 상태의 첫 L3 | 시작 시 free 9.4GB/총 23.6GB | 배치 규칙(재시도 금지)으로 단독 재실행 없음. 설계 결함으로 분류: settle 최대 10초+cancel이 afterEach 기본 hookTimeout 10초를 초과 (hook 예산 < settle 예산). fix2에서 SETTLE_BUDGET_MS=20000 + afterEach 30000으로 예산 역전 |
| 2026-11-06 | `33dfe13` (=`07e3ac7`+7, M10-why batch) | L3 3-test (inprocess) | `wire > 25 메서드 1:1 매핑`: `expected [...] to have a length of 25 but got 26` (`packages/shared/test/wire.test.ts:12`). M10-why-2의 `pfEditWhy` 추가로 wire 메서드가 26개가 됐는데 카운트 단언을 안 고침 | 시작 시 free 8.7GB/총 23.6GB, C: 2.46GB | 환경 아님·flake 아님 — 확정 결함(자작). 수정은 `25`→`26` 1줄이나 배치 규칙(재시도 금지)에 따라 손대지 않고 정지. L3 재실행·푸시 안 함 |
| 2026-11-07 | `f842d19` | L3 3-test (inprocess+loopback) | `m10-why-fix > 공백 why 거부`: `expected [Function] to throw error matching /1~500/ but got loopback pfEditWhy input invalid` (`packages/local/test/m10-why-fix.test.ts:61`, 501자 케이스, loopback zod 봉투) | C: 6.05GB | 환경 아님, flake 아님, 자작 결함(테스트 단언이 loopback 봉투 미고려). 수정은 `/500/` 매칭 1줄. L3 재실행, 푸시 안 함 |
