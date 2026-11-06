# M10-0 OpenCode API 조사 (대상 1.18.18, 실측 없음)

- 근거: 공식 문서(`opencode.ai/docs`, 2026-11-05/06 갱신분) +
  SDK 타입 정의(`anomalyco/opencode` 태그 `v1.18.18`,
  `packages/sdk/js/src/gen/types.gen.ts` 원문).
- 주의: 문서는 최신(dev) 기준이라 1.18.18과 다를 수 있다.
  아래에서 "1.18.18 원문" 표기가 없는 항목은 최신 문서 기준이다.
- `opencode serve`는 띄우지 않았으므로 전부 "문서상 확인 / 실측 필요"로 구분한다.

## 1. GET /config/providers · /provider 형식 — 문서상 확인
- `GET /config/providers` → `{ providers: Provider[], default: { [key: string]: string } }`
  (출처: `/docs/server` Config 절, `/docs/sdk` `config.providers()`).
- `GET /provider` → `{ all: Provider[], default, connected: string[] }`,
  `GET /provider/auth`, `POST /provider/{id}/oauth/{authorize|callback}`
  (출처: `/docs/server` Provider 절).
- `Provider` (1.18.18 원문): `{ id, name, source: env|config|custom|api, env: string[],
  key?, options, models: { [key]: Model } }`.
  `Model` (1.18.18 원문): `{ id, providerID, api{id,url,npm}, name, capabilities,
  cost, limit, status, options, headers }`.
- 실측 필요: 1.18.18 `serve`의 실제 응답 키와 문서 일치 여부 (`/doc` OpenAPI 대조).

## 2. POST /session + prompt_async, model 형식 — 문서상 확인
- `POST /session` body `{ parentID?, title? }` → `Session` (출처: `/docs/server`).
- `POST /session/:id/message` body
  `{ messageID?, model?, agent?, noReply?, system?, tools?, parts }`
  (출처: `/docs/server` Messages 절).
  `POST /session/:id/prompt_async`는 동일 body, `204 No Content` (비동기).
- `model` 형식 (1.18.18 원문, `UserMessage.model`):
  `{ providerID: string, modelID: string }`.
  SDK 예시: `model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" }`
  (출처: `/docs/sdk` Sessions 예시).
- 실측 필요: `prompt_async` 204 후 완료 확인 경로 (event `session.idle` 대기인지).

## 3. tools 비활성 — 문서상 확인
- 메시지 단위 (1.18.18 원문, `UserMessage.tools?`): `{ [key: string]: boolean }`.
- 전역 설정: `tools: { "<name>": false }`, glob 지원 (`"my-mcp*": false`),
  MCP 도구는 `<서버명>_` 접두로 등록 (출처: `/docs/mcp-servers` Manage 절).
- 에이전트 단위: `agent.<name>.tools` (출처: `/docs/mcp-servers` Per agent 절,
  `/docs/tools`).
- 구 `permission`과의 관계: `permission: {edit, bash, webfetch, ...}` allow/ask/deny
  (출처: `/docs/permissions`). tools 비활성화와 permission deny의 우선순위는
  문서에 명시 없음 → 실측 필요.

## 4. system 필드 — 문서상 확인
- (1.18.18 원문) `UserMessage.system?: string`. prompt body에도 `system?` 포함
  (출처: `/docs/server` Messages 절).
- `noReply: true`는 AI 응답 없이 컨텍스트 주입 (플러그인용)
  (출처: `/docs/sdk` `session.prompt` 예시).
- 실측 필요: system + tools + noReply 조합 동작.

## 5. GET /event — 문서상 확인
- `GET /event`: SSE 스트림. 첫 이벤트는 `server.connected`, 이후 버스 이벤트
  (출처: `/docs/server` Events 절). `GET /global/event`은 별도 전역 스트림.
- `session.idle` (1.18.18 원문): `EventSessionIdle { type: "session.idle",
  properties: { sessionID } }`. 상태 3종은 `SessionStatus`
  (`idle | {retry, attempt, message, next} | busy`),
  `session.status` 이벤트 + `GET /session/status` 맵으로 조회.
- 권한 요청 (1.18.18 원문): `permission.updated { properties: Permission }`,
  `Permission = { id, type, pattern?, sessionID, messageID, callID?, title,
  metadata, time{created} }`. 응답 반영: `permission.replied
  { sessionID, permissionID, response: string }`.
- 도구 호출 (1.18.18 원문): `message.part.updated { properties: { part, delta? } }`,
  `ToolPart { type: "tool", callID, tool, state }`,
  `ToolState = pending | running | completed | error`
  (각 상태별 input/output/error/time 필드 포함).
- 실측 필요: SSE 재연결 시 놓친 이벤트 보충 방법 (문서에 없음),
  `permission.updated` 수신→응답 왕복 지연.

## 6. 권한 응답 API — 문서상 확인 (값은 실측 필요)
- `POST /session/:id/permissions/:permissionID` body `{ response, remember? }`
  → `boolean` (출처: `/docs/server` Sessions 절, SDK
  `postSessionByIdPermissionsByPermissionId`).
- TUI 선택지는 `once | always | reject` (출처: `/docs/permissions` What Ask Does).
  API `response`의 허용 문자열은 타입상 `string` (1.18.18 원문) — TUI 선택지와
  같은 값인지는 문서에 명시 없음 → 실측 필요. `remember?` 의미도 실측 필요.

## 7. GET/POST /mcp — 문서상 확인
- `GET /mcp` → `{ [name]: McpStatus }`,
  `McpStatus = connected | disabled | failed{error} | needs_auth |
  needs_client_registration{error}` (1.18.18 원문).
- `POST /mcp` body `{ name, config }` → 상태 객체 (출처: `/docs/server`).
  `config` 형태 (1.18.18 원문): `McpLocalConfig { type: "local",
  command: string[], environment?, enabled?, timeout?, cwd?, ... }` |
  `McpRemoteConfig { type: "remote", url, headers?, oauth?|false, enabled?, timeout? }`.
- `enabled: false`로 시작 시 비활성 (출처: `/docs/mcp-servers` Enable 절).
- 실측 필요: 동적 추가 후 동일 세션에 도구 즉시 반영되는지, `cwd` 상대경로 기준.

## 8. OPENCODE_SERVER_PASSWORD Basic auth — 문서상 확인
- `OPENCODE_SERVER_PASSWORD` 설정 시 HTTP Basic auth 적용 (serve·web 공통).
  사용자명 기본 `opencode`, `OPENCODE_SERVER_USERNAME`으로 변경
  (출처: `/docs/server` Authentication 절).
- 실측 필요: ProcForge `pf.token` 방식과의 동시 운용 시 헤더 충돌 여부.

## 실측 체크리스트 (사용자 PC에서, serve 띄우기)
1. `opencode serve --port 4096` + `/doc` OpenAPI를 1.18.18과 대조 (§1).
2. 세션 생성→`prompt_async` 204→`session.idle`까지의 이벤트 순서 기록 (§2·§5).
3. `tools: {"bash": false}` 메시지 전송 후 bash 호출 시도 여부 (§3).
4. `permission` ask 유발 후 `permission.updated` 수신→`POST .../permissions/...`
   응답값별(once/always/reject 추정) 동작 기록 (§6).
5. `POST /mcp` 동적 추가 후 도구 목록 반영 시점 (§7).
6. Basic auth + 기존 토큰 헤더 병행 (§8).
7. 동시 세션 2개·4개 메모리 측정 (serve 프로세스 RSS, 각 세션 prompt 전후.
   ProcForge M7 dogfood 방식 참고: 동일 프롬프트·동일 모델로 반복).

## 실측 스크립트 사용법 (scripts/m10-probe.mjs)

serve가 떠 있는 사용자 PC에서 1회 실행한다 (에이전트는 serve를 띄우지 않음).

```powershell
node scripts/m10-probe.mjs --model <provider/model>
node scripts/m10-probe.mjs --model <provider/model> --url http://127.0.0.1:4096 --password <pw>
node scripts/m10-probe.mjs --model <provider/model> --concurrency 4
```

- 체크리스트 1~6 수집 → `m10-probe-<날짜>.json` + 항목별 확인/불일치/실패 요약 출력.
- 7번(동시 세션 RSS)은 `--concurrency 2|4` 별도 실행. serve 프로세스 RSS는
  스크립트가 안내하는 PowerShell 명령으로 직접 기록한다.
- 안전: 임시 세션만 만들고 끝나면 삭제, 파일 쓰기 도구는 끄고 보낸다.
  장문 대화 금지·비용 상한 안내를 먼저 출력한다.
