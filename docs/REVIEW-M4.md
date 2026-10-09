# 자체 리뷰 — M4 절차서 산출 + M3.5 tooling (trace/export)

날짜: 2026-10-09. 대상 diff: M3.4.1 이후 (trace/export/procedure/runner-procedure/finalize/numeric-ref/advise).

- [x] 경로: 상대/절대/Windows/공백/JSON 이스케이프 각각 테스트 있음
  - `paths.test.ts`: 상대·절대·탈출·fs밖 out·inout·폴백 on/off
  - `recordings.test.ts`: posix·windows·JSON 이스케이프·드라이브 대소문자·공백(홍 길동)·옛 패턴 마이그레이션
  - export zip: 자체 리더 + Python zipfile + Expand-Archive 3중 검증
- [x] 에러: 모든 throw에 code 있음(internal로 새지 않음)
  - MCP 표면(`server.ts` err/thow)은 전부 code 보유. `errResult`가 미지정 예외를
    code=internal + 일반 메시지로 변환하고 스택은 stderr에만 기록 → 원본 값·스택 누출 없음.
  - runner 내부는 노드 fail 상세로 수렴(리포트 detail). `loadProcedureDoc` 파싱 실패는
    이번에 bad_request로 감쌈.
  - 남음: runner 내부 throw 다수는 code 없음 → fail detail로만 사용됨을 전제로 허용.
- [x] instruction에 나오는 pf_ 도구명이 tools/list에 존재
  - `instruction-host.test.ts` 정적 스캔 (core) + 동적 following-host E2E 유지.
  - 신규 description(pf_finalize/pf_test procedure/pf_advise 제안)은 등록 도구명만 언급.
- [x] 상태 전이: 무한 루프 불가
  - seed 고정 50 그래프 불변식 (needs_human 종결·blocked 비반복) 유지.
  - pfNext 교착 분기는 승격 폴백 포함.
- [x] 정책 문구가 local/server.ts에 없음 (CI grep 통과)
  - `npx` 수준 확인: server.ts에 부가세/llm_rubric/numeric_match 등 없음.
  - 주의: `pf_advise` description의 "proposedConstraints"는 인터페이스명(정책 아님).
  - advice 키워드(부가세 등)는 core/advice.ts에만 존재, local 번들에 없음 (check-deps + grep).

추가 메모:
- `golden.output` 요약 문자열 비교는 drift 검출용으로 유지. resultJson 전체 비교는
- golden.output 요약 비교는 drift 검출용으로 유지.
- procedure import 세션의 node hash는 내용 기반 결정값 (lastPassHash와 무관하게 첫 실행은 전체 선택).
