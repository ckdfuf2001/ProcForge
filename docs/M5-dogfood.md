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

## 3. 해석

- params가 세션에 정상 주입되고 live 실행이 결정적으로 재현됐다
  (고정 인자 동일 → 동일 산출물, constraint 전부 통과).
- 정직한 한계: 이 절차서에는 month에 바인딩된 출력 인자가 없어서 결과가
  9월 내용 그대로다. 진짜 10월 산출물을 내려면 (a) 표지·출력 경로 등에
  month var를 걸거나 (b) 10월 데이터 파일을 입력으로 받는 절차서가 필요하다.
  후자는 sales-2026-10.xlsx가 준비되어 있으므로 M5.5 이후 반복 노드 등과 함께
  확장 가능하다.
- numeric_match 고정 expected 방식은 live/record/replay 모두에서 안정 판정됐다
  (도구 출력에 숫자가 포함된 경우에 한함 — M3.5 관찰 2의 화법 준수).
