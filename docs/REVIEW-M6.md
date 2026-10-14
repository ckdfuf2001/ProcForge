# REVIEW-M6 — 원격 core 모드

- 범위: M6-0 @날짜 param, M6-1 wire 계약, M6-2 FileStore shared 이동 + core-server,
  M6-3 RemoteCoreClient, M6-4 egress guard, M6-5 CI remote + check-deps,
  M6-6 p95 측정·목표. M6.1 후속: 1 egress R8 일치, 2 전체 스위트 remote 이식,
  3 테스트 재시도 제거, 4 인증 강화, 5 저장소 공개 유지.
- 계약: CoreClient 19 메소드 1:1 `POST /v1/<method>` (+GET /healthz).
  요청·응답 shared zod 양쪽 검증, `x-procforge-version: 1` 불일치 conflict.
  internal 고정 메시지·스택 비노출.
- 서버: Node http, `tenants/<tid>/` FileStore, Bearer 키 해시
  (timingSafeEqual). default 테넌트(bare 키 포함)는 PROCFORGE_DEV_AUTH=1에서만.
  401 unauthorized, 타 테넌트→session_not_found.
- 클라이언트: `PROCFORGE_CORE_URL` 있으면 remote, 기본 inprocess.
  읽기는 재시도. 쓰기는 연결 단계 실패(EACCES·ECONNREFUSED: 서버가 못 봄)만
  재시도, 그 외는 정확히 1회 (expectedRevision 충돌 판단은 호출자가).
  실패→io_error degraded, `onSend` 송신 탭.
- egress (R8 일치): 어떤 메서드의 resultJson 실데이터도 원격 전송 금지
  (메타 {sha256,size,preview}만). 변환은 RemoteCoreClient가 수행
  (유일한 원격 경로. 평가 checkerEvaluate·auto shared 함수로 parity).
  core는 localEvaluation 신뢰 저장 (원문 병행 금지).
  resultSummary·rubricReasons 값은 4KB 상한+교정, 예외 없음.
  params/args/argSpecs는 정의라 원문 유지+교정만.
  예외 목록은 DECISIONS [M6.1-1].
- CI: `build-test` (ubuntu/windows × inprocess/loopback) + `remote-mode` 잡
  (core-server 테스트 + 전체 스위트 remote 실행 + 송신 egress 단언).
  check-deps 양방향 (local→core 직접 import 금지 + core-server→local 금지).
- p95 (로컬 loopback, n=10~20): getSession 30.4ms, pfTree 8.7ms,
  getNode 7.5ms, pfNext 27.9ms. 목표 p95 < 1000ms.
- 안정화: Windows loopback 순간 실패 원인 확정. burst connect EACCES
  (200병렬 중 116) + stale keep-alive (서버 5s < 클라 풀).
  대응: 서버 keepAlive 120s, finalize getNode 팬아웃 제거 (pfTree 전체),
  CLI 테스트 spawnCli (spawnSync는 워커 루프를 막음), remote 병렬 4.
  어서션 재시도(withNetRetry·fetchRetry)는 제거.
  listen EACCES는 SO_EXCLUSIVEADDRUSE + TIME_WAIT 충돌이 유력 →
  exclusive:false + listen 재시도 유지 (bind 멱등).
- 테스트: shared·local 318·core-server 6 green (L3 로컬 + remote 전체).
  CI run 38604361482 (9458704) success (6잡 전부, remote 전체 포함).
- 결정 기록: docs/DECISIONS.md [M6-0]~[M6-6]·[M6.1-1]~[M6.1-5].
