# flake 장부 (M9-tmp-fix)

같은 증상이 3건 더 쌓이면 별도 조사로 돌린다. "환경" 분류는 워커 사망·OS kill 등
프로세스 수준 증거가 있을 때만 적는다. 날짜는 KST.

| 날짜(KST) | HEAD | 단계 | 증상(원문 1줄) | 최고 커밋 메모리 | 단독 재실행 |
|---|---|---|---|---|---|
| 2026-11-04 | M9-1-exit 미적용 코드 (파일 수로 추정) | L3 3-test | `M3 runner > CLI positional UUID는 세션으로 해석`: `expected 3221226505 to be 1` (`test/m3-runner.test.ts`) | 미측정 | 이후 exitCode 전환(`a3690bb`)으로 해소 — flake 아님, 기지 버그 |
| 2026-11-04 | `568dc2d` 전후 (파일 수로 추정) | L3 3-test | `script-run.test.ts > 비정상 종료·비JSON·타임아웃은 throw`: `expected [Function] to throw error matching /타임아웃/ but got '스크립트 비정상 종료(3221225773): ...pf-script-...slow.mjs'` + `Error: Worker exited unexpectedly` (`packages/local/src/runner/script-run.test.ts`, tinypool 워커) | 미측정 | green — 환경(커밋 한도, `3221225773=0xC000012D` 근거) |
| 2026-11-05 | `5ab9712` | L3 3-test | `Error: Worker exited unexpectedly` (tinypool, `packages/local` 스위트) | 미측정 (사후 18GB) | 3회차 green — 환경 |
| 2026-11-05 | `5ab9712` | L3 3-test | 요약 없이 `Failed`로 중단 (m55-state 이후, 워커 사망 추정) | 미측정 | 3회차 green — 환경 |
| 2026-11-06 | `bd35882` | 단독 실행(01:39, L3 외) | `pf-cancel-e2e-WXNrrH` run이 `failed: run fs 밖 변경 감지 (10건+, '-' 삭제분)` + `pf-run-sKPFRE` 고아 (tmp 루트 부분 정리됨, `.procforge/runs/<id>/`만 잔류). 당시 `python.exe`·`node.exe` 잔존 없음, 고아는 잠금 없이 삭제 가능했음 | 미측정 | 단독 재실행 green — m75-cancel 5회· m75-run 5회 모두 통과, `tmp-delta` INCREASED_TOTAL 0. 당시 동시 실행과 경합 의심, 미확정 (재발 시 별도 조사) |
