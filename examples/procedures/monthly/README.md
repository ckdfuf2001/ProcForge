# monthly — 9월 분해 → 10월 run 재현 (5줄)

1. `examples/dogfood/sales-2026-09.xlsx`만 있는 빈 폴더를 작업공간으로 준비한다.
2. 상위 모델(OpenCode + procforge MCP)로 "월간보고서" 분해→확정한다 (strict 감사 0이어야 함).
3. `examples/dogfood/sales-2026-10.xlsx`를 작업공간에 추가한다.
4. `procforge run monthly --param month=2026-10` → 산출 pptx의 표지·S2 제목·표가 10월 값이어야 한다.
5. `month=2026-11`(파일 없음)은 실행 전 bad_request, 9월 데이터 덮어쓰기는 period fail이어야 한다.
