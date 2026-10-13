# REVIEW-M6 — 원격 core 모드

- 범위: M6-0 @날짜 param, M6-1 wire 계약, M6-2 FileStore shared 이동 + core-server,
  M6-3 RemoteCoreClient, M6-4 egress guard, M6-5 CI remote + check-deps,
  M6-6 p95 측정·목표.
- 계약: CoreClient 17 메소드 1:1 `POST /v1/<method>` (+GET /healthz).
  요청·응답 shared zod 양측 검증, `x-procforge-version: 1` 불일치 conflict.
  internal 고정 메시지·스택 비노출.
- 서버: Node http, `tenants/<tid>/` FileStore, Bearer `tid:key` (bare는 default).
  401 unauthorized, 타 테넌트→session_not_found.
- 클라이언트: `PROCFORGE_CORE_URL` 있으면 remote, 기본 inprocess.
  읽기만 3회 재시도, 쓰기 재시도 금지, 실패→io_error degraded, `onSend` 송신 탭.
- egress: 송신 한 곳 검사. 구조 위반 차단 bad_request
  (pfReport 밖 resultJson 실데이터, 확정·제약 경로의 절대경로).
  params/args/resultJson/resultSummary는 실행·평가·바인딩 입력이라 원문 유지.
  민감값 교정 후 전송 (토큰 전역, 이메일은 위 입력 제외).
- CI: `build-test` (ubuntu/windows × inprocess/loopback) + `remote-mode` 잡
  (core-server 테스트 + remote 전용 3종). check-deps 양방향
  (local→core 직접 import 금지 + core-server→local 금지).
- p95 (로컬 loopback, n=10~20): getSession 30.4ms, pfTree 8.7ms,
  getNode 7.5ms, pfNext 27.9ms. 목표 p95 < 1000ms.
- 안정화: Windows loopback 순간 실패(listen/connect EACCES·fetch failed) 대응.
  파일당 서버 1개 공유, startServer EACCES 10회 재시도,
  테스트 fetch·client 호출 재시도 (product 재시도 정책 불변).
  perf는 성공 시도 시간만 기록.
- 테스트: shared 73·local 315·core-server 5 green (L3 로컬).
  CI run 38459923601 (f266942) success.
- 남은 것: 전체 스위트 remote 이식은 M6.1
  (import API·golden 쓰기 API·테스트 이식 필요).
- 결정 기록: docs/DECISIONS.md [M6-0]~[M6-6].
