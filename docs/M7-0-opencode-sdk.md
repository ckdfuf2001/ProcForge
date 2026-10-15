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

## 4. 모델 루프 중 conflict — 메커니즘 확인, 주체 구분 명시

- webui 서버(5552, big-pickle, 403 없음)에서 실측.
- 외부 advise로 rev 16→17 상승 중 모델 루프와 교차시킴.
- 낡은 rev 호출 → `conflict: revision mismatch: expected 16, actual 17`.
- 새로 읽고 재시도 → 정상 진행. 이 conflict→재시도는 실험 스크립트가 수행
  (주체 구분됨).
- 모델 자체 회복도 관측: bad_request 5회 (bash 실행 불가·ref 불일치) →
  힌트 읽고 수정 → confirm_leaf 통과, pf_next 완료.
- calls.jsonl은 actor·clientName을 세션 단위로 기록해서 외부 직접 호출과
  모델 MCP 호출을 구분 못 한다 (전부 actor=host·opencode 1.18.18).
  UI 직접 호출의 actor 표기가 별도로 필요 (DECISIONS [M7-1]).

## 5. event.subscribe — 부분확인

- `GET /event` → SSE 동작. 관측 type: `server.connected`,
  `file.watcher.updated`. 10초 수집 기준 그 외 없음.
- 정적 인벤토리(SDK types, 40개): `message.part.updated`
  (properties: part+delta. part 안에 sessionID·tool·상태),
  `session.idle` (sessionID), `session.status` (sessionID+status),
  `tui.prompt.append` (text).
  짝짓기 대안 경로로 타입상 충분 (part.sessionID + tool 이름).
  라이브 캡처(도구 실행 중 스트림)는 모델 실행 불가로 미확인.

## 제안: B 기본 + A 조건부 + C 상시 (M7-1 확정)

- B(기본): `POST /session/:id/message` — 처음부터 끝까지 동작 확인
  (분해→조언 반영→1.1 leaf→실행, big-pickle 403 없음).
  단 agent=build 지정 필수 (plan 모드는 텍스트만, 아래 참조).
- A(조건부): attach된 TUI가 있을 때만. append 수락까지 확인,
  화면 반영은 미확인.
- C(상시): "계속" 문구+복사 버튼.
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

## plan 모드 함정 (실측)

- plan 모드 세션(ses_ec0f...)은 텍스트 계획만 내고 pf_* 호출 0건.
  겉으로 성공처럼 보인다 (완료 선언까지 함, 실제 파일 변경 0).
- B 전송 시 agent=build 지정. 신호 후 60초 안에 pf_* 0건이면 degraded.

## 세션 이중화 사례 (207a8f93 → 5762fb44)

- 전환이 아니라 별개 분해 2건 병행: 207a8f93(TUI 분해, repo 저장소,
  rev 5, open 유지) vs 5762fb44(webui 대행 분해, workspace 저장소,
  1.1 leaf). TUI 세션과 webui 세션이 각자 pf_start한 것.
- 짝짓기는 최신 pf_start 기준으로 갱신, 이력 보존 (DECISIONS [M7-1]).

## TUI 기본 내장 서버 포트

- SDK server 기본값 4096 확인. TUI URL이 localhost:4096인 것과 일치.
- 단, TUI 프로세스 응답 없음 상태에서는 LISTEN만 되고 HTTP 무응답.
  이 경우 TUI 재시작 후 attach.

## M7-1.1 경로·body 4조합 확인 (1.18.18, `serve --port 40999`, 2026-10-16)

- `POST /session/:id/message` + `{parts}` → **200**
  (assistant msg 생성, mode/agent build).
- `POST /session/:id/message` + `{"prompt":{text,parts}}` → **400**.
- `POST /api/session/:id/prompt` + `{parts}` → **400**.
- `POST /api/session/:id/prompt` + `{"prompt":{text,parts}}` → **200**
  (`admittedSeq`, §2와 일치).
- 결론: B는 `/session/:id/message` + `{parts}`로 고정.
  `{"prompt":{...}}` 래퍼를 message 경로에 붙인 구현(d5d7003)은
  실서버에서 400이 나므로 M7-1.1에서 원복. 가짜 서버도 이 조합으로 재현.
