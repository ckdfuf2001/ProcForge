# M5 실측 (live 실행, dogfood)

상태: 1차 실측 완료 (단일 모델, driver 방식 — M3.5 §0과 동일 조건).
호스트 연결 방식: 실제 OpenCode가 아니라 일회용 driver 스크립트로 pf_* 호출·ppt 도구
실행을 수동 진행 (수행 후 삭제). 모델 2종 비교·토큰 통계는 범위 밖.

## 1. 절차서 (monthly-2026-09)

- 세션: 9월 실적 집계 → totals.json 작성 → 합계 확인(numeric_match) → 표 세전 갱신 → 표지 확정.
- 노드 4 leaf + done. 확정 후 `pf_finalize` → `monthly-2026-09`.
- numeric_match: 1.2 `total_ex_vat == 1818182 ±1` (human 제약, 세전 합계).
  - 근거: A 120×10000/1.1 = 1,090,909.09, B 80×10000/1.1 = 727,272.73.
    표에는 반올림값 기재 (1,090,909 + 727,273 = 1,818,182).

## 2. month=2026-10 live 실행

- 명령: `procforge run monthly-2026-09 --param month=2026-10`
- 결과: pass=4 fail=0 (run `11f18c5d-...`, replay 아님·live 실측).
- 결과 pptx (`runs/<runId>/fs/a.pptx`): 표지 "월간보고서 2026-09 (최종)",
  2번 슬라이드 표 매출(세전) A 120/1,090,909, B 80/727,273.
- numeric_match (1.2): pass (failedConstraints 없음).

## 3. 해석 (M5.1-C에서 실제 결과로 교체)

- M5 당시 한계의 메커니즘 확정: live run은 확정 fixture에서 입력을 시딩한다
  (fixture-sealed). 워크스페이스 작업 파일이 바뀌어도 실행 입력은 그대로이므로,
  9월 절차서의 10월 실행은 9월 산출물을 재생성할 수밖에 없었다.
- M5.1-C1 `monthly-2026-10` (3 leaf, strict finalize 감사 0):
  1.1 `pptx/read_json` agg.json + numeric `c-total` (합계 1500000),
  1.2 `pptx/pptx_set_table` 10월 표 고정값,
  1.3 `pptx/pptx_set_title` text var `월간보고서 ${params.month} (최종)` (B3).
  agg.json은 sales-2026-10.xlsx에서 호스트가 실측 집계한 값
  (A 100/1000000, B 50/500000, 합계 1500000).
- C2 month=2026-10 live 실행: pass=3 fail=0. run 산출 a.pptx 표지
  `월간보고서 2026-10 (최종)` + 표 10월 수치 확인. 워크스페이스 9월 파일 무오염.
- C3 1.1 fixture 합계 9999999 조작: 1.1 fail (`c-total`) + 1.2/1.3 blocked,
  하류 미실행. 복원 후 live pass=3.
- C4 CI E2E `m51-monthly.test.ts` (fake-ppt + `read_json`): 9월 확정 →
  10월 실행 `filled:2026-10:` + `보고서 2026-10` (전체 var·템플릿 치환),
  조작 시 numeric fail + blocked, 복원 후 통과.
- 관측 (절차서 밖 기록): MCP stdio는 UTF-8 규격. 파이썬 서버가 로캘(cp949)
  stdio로 한글 JSON을 읽으면 서로게이트 mojibake가 생기므로
  `stdin/stdout.reconfigure(encoding="utf-8")` 필수. run은 MCP command를
  run fs 기준이 아닌 절대경로로 지정해야 한다 (상대경로 미지원, 후속 후보).
- replay 모드는 카세트 없는 live 절차서에서 실행 불가
  (`record 없이 실행 불가`) — record 절차서 전용.
