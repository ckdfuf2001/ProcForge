# M7-0 — OpenCode SDK 실측 보고 (보고만, 코드 변경 없음)

- opencode 버전: 1.18.18 (`D:\opencode\opencode-exe\bin\opencode.exe`).
- 방식: `opencode serve --port 40999` 기동 후 HTTP 실측. 인증 없음
  (loopback serve는 전부 200, 401 없음. M7-1 서버도 127.0.0.1 전용이 전제).
- clientInfo: MCP initialize 이름·버전만 (`opencode 1.18.18`).
  OpenCode 세션 id는 들어 있지 않다 (server.ts `getClientVersion`, 판단 없이 전달).

## 1. TUI 서버·외부 조작 — 부분확인

- `opencode attach <url>` 명령 존재. `opencode serve --port <n>` + attach
  방식이 CLI에 있다. TUI 기본 내장 서버의 포트 고정 여부는 미확인
  (대화형 TUI를 띄워야 알 수 있음).
- `POST /tui/append-prompt` (`{"text": ...}`) → `true` 반환 (수락 확인).
  REST 경로에 `/api` prefix 없음 (`/api/tui/*`는 SPA 폴백).
  TUI 화면 반영은 대화형 TUI가 없어 미확인.
- 결론: A안의 신호 경로는 수락까지 확인, 화면 반영은 사용자 확인 필요.

## 2. session.prompt — 메커니즘 가능, 모델 응답 미확인

- `POST /api/session` → 세션 생성됨 (id 발급 확인).
- `POST /api/session/:id/prompt` body 형태:
  `{"prompt":{"text":"...","parts":[{"type":"text","text":"..."}]}}`
  (`parts`만·`text`만은 400, `{"prompt":...}` 래퍼 필수).
  응답 `{"data":{"admittedSeq":N,"delivery":"steer",...}}`.
- 같은 세션에 보내면 messages에 순서대로 쌓이고 admittedSeq가 증가한다
  (문맥 이어감의 메커니즘 확인).
- `noReply:true`를 prompt 안·바깥에 줘도 모델이 실행됐다
  (이 환경에서는 응답 억지 안 됨).
- 모델 응답 자체는 미확인: free-tier provider가 403
  (`FreeTierError: can only be used from within OpenCode`).
  TUI 화면 반영도 미확인.

## 3. 세션 짝짓기 — 가능

- `opencode export <sessionID>` (94MB, 7715 msgs) + DB 직접 조회로 확인:
  tool part `{"type":"tool","tool":"ProcForge_pf_start",...}` 의
  output JSON 안에 `"sessionId":"ebb23249-..."` (ProcForge 세션 id).
  UI는 messages/export를 훑어 `ProcForge_pf_start` output의 sessionId로
  짝지을 수 있다.
- 주의: HTTP `GET /api/session/:id/message`가 대용량 세션(7715 msgs)에서
  빈 페이지(`data:[]`)를 반환했다. 소규모 세션은 정상 반환.
  UI 구현 시 export 또는 페이징/검색 방식을 쓸 것.
- (c) `POST /api/session` 직접 생성도 가능 (실측). 처음부터 짝짓기 용이.

## 4. 모델 루프 중 conflict — 미확인

- 모델 실행이 위 403으로 불가해서 관측 못 함.
- ProcForge 측 expectedRevision 충돌 자체는 기존 테스트 커버
  (도중 변경은 conflict). 모델이 충돌 후 다시 읽고 계속하는지는
  모델이 도는 환경에서 재확인 필요.

## 5. event.subscribe — 부분확인

- `GET /event` → SSE 동작. 관측 type: `server.connected`,
  `file.watcher.updated`. 10초 수집 기준 그 외 없음.
- 도구 호출 시작·종료 이벤트는 모델 실행 불가로 미확인.

## 제안: A안 기본 (조건부) + C안 상시

- A안: TUI를 열어 둔 상태에서 UI가 조언을 `pf_advise`로 기록하고
  `tui.appendPrompt` + `submitPrompt`. append 수락까지 확인됨.
  화면 반영·제출 동작은 M5.8 TUI 세션에서 사용자가 확인.
- B안: TUI 없이 `session.prompt` + `event.subscribe` 표시.
  메커니즘은 확인됐으나 모델 403이 풀려야 종단 검증 가능.
- C안: 연결 불가 시 조언만 기록 + "OpenCode에서 '계속' 입력" 문구+복사 버튼.
  상시 폴백으로 둔다.
- 공통: 상태 변경은 `pf_advise`(App 메서드)로만, OpenCode에는
  "계속하라" 신호만 (R1~R4 유지).

## 재현 절차

1. `opencode serve --port 40999` (백그라운드, 실험 후 kill).
2. `GET /api/session` 목록, `POST /api/session` 생성.
3. `POST /api/session/:id/prompt` (위 body 형태).
4. `GET /api/session/:id/message` (소규모 세션), 대용량은 `opencode export`.
5. `GET /event` (curl `--max-time 10`).
6. `POST /tui/append-prompt` (`{"text": ...}` → `true`).

## M7-1 지시서 추가분 (SSE 도구 이벤트)

`GET /event` SSE에서 도구 실행 시 이벤트가 오는지 실측한다.
모델이 도구를 호출하는 동안 스트림을 열어둔다 (curl `--max-time`으로 구간 캡처).

- 찾는 것: `message.part.updated` (또는 tool 관련 type)에
  sessionID·tool 이름·상태(시작/종료)가 들어 있는지.
- 있으면: 짝짓기 2(b)(사용자가 UI에서 세션 선택)의 대안 경로가 된다.
  UI가 SSE를 보고 "지금 도는 세션 + 도구"를 자동으로 가리킬 수 있기 때문.
  이 경우 DECISIONS에 "SSE 도구 이벤트 = 짝짓기 대안 경로"로 기록한다.
  (관측된 type 목록과 필드 포함. R1~R4 불변: 상태 변경은 pf_advise로만)
- 없으면: 2(b) 유지 (사용자 선택 또는 session.create 직접 생성).
