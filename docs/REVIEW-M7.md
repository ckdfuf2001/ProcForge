# REVIEW-M7 — UI (`procforge ui`)

- 범위: M7-0.1 OpenCode 연결(UI 없이 App·CLI), M7-0.2 신호 실서버 보정,
  1 `procforge ui` 서버+SPA+세션 목록, 2 트리+SSE, 3 노드 상세,
  4 텍스트 편집/의견+stale 미리보기, 5 실행 화면, 6 Playwright E2E.
- 계층(R3): UI는 어댑터다. App 메서드만 호출한다 (HTTP API = App 1:1,
  `POST /api/<method>` + JSON, shared zod 양방향 검증). core·FileStore 직접 접근
  금지, 판단 if문 금지. check-deps가 ui→core·local 내부 import를 막는다.
- 서버·보안: 127.0.0.1 바인딩, 실행마다 무작위 토큰(URL fragment → `x-procforge-token`
  헤더), Host/Origin 검사(DNS rebinding), 토큰 없음 401·Host 불일치 403.
  CSP는 요청마다 fresh nonce(`style-src 'nonce-…'`, unsafe-inline 금지) +
  `<meta name="csp-nonce">` → `EditorView.cspNonce`. dist 인라인 0, iframe/dangerouslySetInnerHTML 금지.
- 1 세션 목록: 저장소 경로·요약 상태·revision·최근 변경 시각, pairings 배선
  (B/A/C · 이력 보기 · connectionId 2개 경고). 저장소 2개 감지 경고. `--open`은 App openUrl.
- 2 트리+SSE: id 숫자 정렬·상태 색·attempts/retriesLeft·locked·external 아이콘·dependsOn·
  needs_human/blocked 목록. EventSource 금지 — fetch 스트리밍 + 토큰 헤더.
  폴러 1개 공유, Last-Event-ID(없으면 현재 revision부터), heartbeat, 세션당 8 상한 429.
  이벤트는 core `getEventsPage`에서만 읽는다(tail:false, 로컬 파일 tail 금지).
  stale은 상태가 아니라 `staleSince:{revision,causeNodeId}` 표시.
- 3 노드 상세: argSpecs(fixed/var/generated)·constraints(auto/human, 마지막 판정)·
  advice 이력·attempts 타임라인(verdict·selfReason·rubricReasons·소요)·golden·hash.
  산출물 텍스트 4KB 미리보기·전문은 로컬에서만(R8 — 원격 core 모드 원문 송신 0).
  노드 이력은 최신 200(tail:true).
- 4 편집/의견: CodeMirror 6(basicSetup 미사용). 검증은 **두 벌뿐** —
  문법(`jsonParseLinter`) + 서버 400 메시지 위치 매핑(UI 스키마 재구현 금지).
  stale 미리보기=`previewEdit`(applyEdit 순수 함수 공유, dry-run, 상태 변경 0) —
  원인 노드 자신은 제외하고 의존 노드만 나열. 저장=App.editArgs(actor `"ui"`,
  expectedRevision 필수, conflict 409·자동 재시도 금지·초안 보존).
  의견=`adviseAndSignal`(advise 1회 → B>A>C 신호, 생성 constraint 구분·degraded면 C 문구+복사).
- 5 실행 화면: 절차서 목록 → params 폼(required `*`, `@today:utc`·`@today:local`) →
  uiRun(즉시 runId, 동시 1개 409). 노드별 status는 core 값을 그대로 표시(UI 해석 금지).
  runner 자식은 프로세스 트리(Windows `taskkill /T`, POSIX 그룹 SIGTERM→SIGKILL,
  detached), driveRun try/finally·취소=트리 종료. 실행 로그 SSE(`id: seq`, `event: end`).
  승인: approvalHash 409·스크립트 sha256+diff·sandbox(realpath+5MB)·approved 필수.
  wildcard는 `--allow-wildcard`와 동일하게 키를 명시 선택해야 승인(core 승인 전 400).
  실패 노드 → "이 노드 열기"로 상세 이동.
- 6 E2E: MemoryStore core + 임시 저장소 + 가짜 OpenCode, 실제 chromium + 실제 UI dist +
  실제 local 서버. (a) 월간보고서 (b) 크롤링 (c) conflict (d) plan/버전 미확인.
  ubuntu 전용 CI, 스크린샷은 실패 시에만 artifact.
- E2E가 잡은 버그(수정): 세션 SSE가 `event: change`를 보내는데 클라 `subscribeSse`가
  `event:` 줄이 있으면 `onEvent`만 호출하고(onData 폴백 없음) payload를 버려
  실시간 갱신·외부 변경 배너가 죽어 있었다 → `event:`가 있어도 `onEvent`가 없으면
  onData로 폴백.
- 결정 기록: docs/DECISIONS.md [M7-1]·[M7-1.1-*]·[M7-ui1-*]~[M7-ui4-k]·
  [M7-5-1]~[M7-5-3]·[M7-5-a~i]·[M7-5 보정3-a~d]·[M7-5-3-a/b].
- 테스트: L3 로컬 green(3 client 모드). CI run 39271527969(b25c688) success —
  7잡(build-test 4·remote-mode 2·e2e 1) 전부. 5-4는 run 39264793696 success.
- 남음(사람 수행): dogfood — 실제 OpenCode(build 모드)에서 분해 → **UI로** 중간 노드
  의견 1건 → 그 부분만 재실행 → finalize → 무인 run exit 0. 기록 `docs/M7-dogfood.md`
  (connectionId·actor로 사람/모델/UI 구분 증명).
