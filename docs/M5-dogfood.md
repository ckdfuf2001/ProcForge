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

## 3. 해석 (M5.2 수락 a~d 결과로 교체)

- 절차서 `monthly` (기간 없음, 9월 xlsx만으로 분해·strict finalize 감사 0):
  1.1 script 집계 (`sales-${params.month}.xlsx` 바인딩 입력) + `period ==
  ${params.month}`, 1.2 script 렌더 (`$1.1.rows` + 표지 템플릿) +
  `total == $1.1.total`. 고정 숫자·날짜 리터럴 없음.
- a 9월 분해: strict finalize warnings []. 9월 실측 앵커
  (A 120/1200000, B 80/800000, 합계 2000000).
- b 10월 xlsx 추가 후 run month=2026-10: pass 2. 산출 report.txt/pptx가
  테스트 독립 계산(A 100/1000000, B 50/500000, 합계 1500000)과 일치,
  표지 2026-10. 9월 절차서가 10월 파일을 읽은 첫 사례 (입력 바인딩).
- c month=2026-11 (파일 없음): 실행 전 bad_request (입력 바인딩 실패).
  노드 실행 0.
- d sales-2026-10.xlsx에 9월 데이터: 1.1 fail (`c-period`,
  period 2026-09 ≠ 2026-10) + 1.2 blocked. 복원 후 live pass 2.
- 11월 한계 실험 기록 (M5.1 절차서 monthly-2026-10):
  month=2026-11 실행이 pass 3, 표지 2026-11 + 표 10월 수치
  (run 52ff17ab). 고정 표값 + fixture-sealed의 실증. M5.2에서 해소.
- 관측 (절차서 밖 기록): MCP stdio는 UTF-8 규격. 파이썬 서버·스크립트 모두
  stdin/stdout UTF-8 고정 필요 (runner는 python 실행 시 PYTHONUTF8=1,
  PYTHONIOENCODING=utf-8 주입). run은 MCP command를 run fs 기준이 아닌
  절대경로로 지정해야 한다 (상대경로 미지원, 후속 후보).
- replay 모드는 카세트 없는 live 절차서에서 실행 불가
  (`record 없이 실행 불가`) — record 절차서 전용.
- 샘플 정합화 (M5.2-6): 9월 xlsx 단가를 포함 기준 11000으로 통일
  (금액 열 불변, 집계 불변). 단가×수량 == 금액이 양 달 모두 성립.

## 4. 관찰: 실사용 1건 (BC 가이드, M5.3-0)

- 호스트: OpenCode 에이전트 (Muse Spark). 모델: muse-spark.
  하위세션(Task)에 ProcForge MCP를 붙여 수행, 작업공간은 temp로 분리.
- 작업: SAP ERP 소개 pptx(21슬라이드) 양식 분석 → 가이더용 GUIDE.md.
  3/3 leaf 확정. 산출물은 `examples/bc-guide/`에 커밋.
- 막힌 지점:
  1. `pf_finalize` 2회 실패. 표시 오류는 `-32602 스키마 오류`였으나
     실제 원인은 1.2/1.3의 `missing required arg: command`였음.
     에러 봉투가 엄격 클라이언트에서 가려진 것 (MCP 에러 텍스트 계약으로 해소).
  2. 세션 저장소 위치 불명 → 파일시스템 탐색으로 발견
     (MCP 서버 projectRoot가 dogfood-m51).
- 가짜 leaf 원인: 1.2/1.3이 `opencode/bash`로 확정됐으나 argSpecs에
  필수 `command` 없이 `{lang, lines, path}`만 박음. confirm 당시에는
  required 검사가 없어 통과, finalize 검증에서 거부됨.
  실행 증거(artifact)도 없었음. 대응: M5.3-0-1 (confirm required 강제),
  M5.3-0-4 (증거 없는 leaf 경고).
- 해당 세션은 절차서로 finalize하지 않음 (leaf가 재실행 가능 호출이
  아니므로). GUIDE.md가 최종 산출물.
