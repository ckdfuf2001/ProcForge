# M10-0 OpenCode API 조사 (대상 1.18.18, 실측 완료 2026-11-06)

- 근거: 공식 문서(`opencode.ai/docs`, 2026-11-05/06 갱신분) +
  SDK 타입 정의(`anomalyco/opencode` 태그 `v1.18.18`,
  `packages/sdk/js/src/gen/types.gen.ts` 원문) + 실측
  (`opencode serve` 1.18.18, 모델 `opencode-go/crouton-alpha-free`, 총 비용 0 USD).
- 주의: 문서는 최신(dev) 기준이라 1.18.18과 다를 수 있다.
  아래에서 "1.18.18 원문" 표기가 없는 항목은 최신 문서 기준이다.
- 실측 방법은 `scripts/m10-probe.mjs` (사용법은 문서 끝 참조).
  Basic auth만 1.18.32에서 확인 (1.18.18 동일 여부 미확인, 디스크 부족으로 재설치 생략).

## 1. GET /config/providers · /provider 형식 — 문서 + 실측
- `GET /config/providers` → `{ providers: Provider[], default: { [key: string]: string } }`
  (출처: `/docs/server` Config 절, `/docs/sdk` `config.providers()`).
- `GET /provider` → `{ all: Provider[], default, connected: string[] }`,
  `GET /provider/auth`, `POST /provider/{id}/oauth/{authorize|callback}`
  (출처: `/docs/server` Provider 절).
- `Provider` (1.18.18 원문): `{ id, name, source: env|config|custom|api, env: string[],
  key?, options, models: { [key]: Model } }`.
  `Model` (1.18.18 원문): `{ id, providerID, api{id,url,npm}, name, capabilities,
  cost, limit, status, options, headers }`.
- 실측: `GET /config/providers` 응답 키 일치. 관측 provider:
  `opencode-go(32) · opencode(23) · openrouter(364) · nvdia(82) · llama-local(1)`.

## 2. POST /session + prompt_async, model 형식 — 문서 + 실측
- `POST /session` body `{ parentID?, title? }` → `Session` (출처: `/docs/server`).
- `POST /session/:id/message` body
  `{ messageID?, model?, agent?, noReply?, system?, tools?, parts }`
  (출처: `/docs/server` Messages 절).
  `POST /session/:id/prompt_async`는 동일 body, `204 No Content` (비동기).
- `model` 형식 (1.18.18 원문, `UserMessage.model`):
  `{ providerID: string, modelID: string }`.
  SDK 예시: `model: { providerID: "anthropic", modelID: "claude-sonnet-5-5" }`
  (출처: `/docs/sdk` Sessions 예시).
- 실측: `prompt_async` → 204 확인, 완료는 `session.idle` 대기로 확인.

## 3. tools 비활성 — 문서 + 실측
- 메시지 단위 (1.18.18 원문, `UserMessage.tools?`): `{ [key: string]: boolean }`.
- 전역 설정: `tools: { "<name>": false }`, glob 지원 (`"my-mcp*": false`),
  MCP 도구는 `<서버명>_` 접두로 등록 (출처: `/docs/mcp-servers` Manage 절).
- 에이전트 단위: `agent.<name>.tools` (출처: `/docs/mcp-servers` Per agent 절,
  `/docs/tools`).
- 실측: 메시지 `tools: {edit:false, write:false, apply_patch:false, bash:false}`로
  도구 호출 part 0건 확인. 구 `permission` deny와의 우선순위는 미확인(잔여):
  ask 설정 시 `permission.asked`가 먼저 오고 deny/허용은 §6과 같다.

## 4. system 필드 — 문서상 확인
- (1.18.18 원문) `UserMessage.system?: string`. prompt body에도 `system?` 포함
  (출처: `/docs/server` Messages 절).
- `noReply: true`는 AI 응답 없이 컨텍스트 주입 (플러그인용)
  (출처: `/docs/sdk` `session.prompt` 예시).
- 실측 필요: system + tools + noReply 조합 동작.

## 5. GET /event — 문서 + 실측
- `GET /event`: SSE 스트림. 첫 이벤트는 `server.connected`, 이후 버스 이벤트
  (출처: `/docs/server` Events 절). `GET /global/event`은 별도 전역 스트림.
- 실측: SSE data는 `{id, type, properties}` 봉투다 (문서에 형식 명세 없음).
  예: `{"id":"evt_...","type":"session.status","properties":{...}}`.
- `session.idle` 확인. 프롬프트→idle 전체 순서 실측:
  `session.created > session.updated > message.updated > message.part.updated >
  session.status > session.diff > message.part.delta > session.idle`
  (간헐적으로 `session.error`·`catalog.*`·`server.heartbeat` 혼입).
- 권한 요청: **실측 이벤트명은 `permission.asked`** (1.18.18 원문
  `types.gen.ts`의 `permission.updated`와 다름 — 문서 불일치).
  페이로드 실측: `{id, sessionID, permission, patterns[], metadata{command},
  always[], tool{messageID, callID}}`.
  `permission.replied` 이벤트는 관측되지 않음 (응답 효과는 tool 완료로 확인).
- 도구 호출 (1.18.18 원문): `message.part.updated { properties: { part, delta? } }`,
  `ToolPart { type: "tool", callID, tool, state }`,
  `ToolState = pending | running | completed | error`.
- 잔여: SSE 재연결 보충 방법 (문서에 없음).

## 6. 권한 응답 API — 문서 + 실측
- `POST /session/:id/permissions/:permissionID` body `{ response, remember? }`
  → `boolean` (출처: `/docs/server` Sessions 절, SDK
  `postSessionByIdPermissionsByPermissionId`).
- TUI 선택지는 `once | always | reject` (출처: `/docs/permissions` What Ask Does).
- 실측 (ask 설정, free 모델): `once`→api 200+tool completed,
  `reject`→api 200+tool 미수행, `always`→api 200+tool completed.
  응답 문자열은 TUI 선택지와 같은 값으로 동작 확인. `remember`는 미사용(잔여).
- 실측 조건: `permission: {bash: {"*": "ask"}}` (문자열 `"ask"`도 동일).
  ask 없이 도구를 부르면 승인 흐름 없이 실행된다.

## 7. GET/POST /mcp — 문서 + 실측
- `GET /mcp` → `{ [name]: McpStatus }`,
  `McpStatus = connected | disabled | failed{error} | needs_auth |
  needs_client_registration{error}` (1.18.18 원문).
- `POST /mcp` body `{ name, config }` → 상태 객체 (출처: `/docs/server`).
  `config` 형태 (1.18.18 원문): `McpLocalConfig { type: "local",
  command: string[], environment?, enabled?, timeout?, cwd?, ... }` |
  `McpRemoteConfig { type: "remote", url, headers?, oauth?|false, enabled?, timeout? }`.
- `enabled: false`로 시작 시 비활성 (출처: `/docs/mcp-servers` Enable 절).
- 실측: `POST /mcp` → 200, `GET /mcp` 즉시 반영(~0s) 확인.
  잔여: 동일 세션 도구 즉시 반영 여부, `cwd` 상대경로 기준.

## 8. OPENCODE_SERVER_PASSWORD Basic auth — 문서 + 실측(1.18.32)
- `OPENCODE_SERVER_PASSWORD` 설정 시 HTTP Basic auth 적용 (serve·web 공통).
  사용자명 기본 `opencode`, `OPENCODE_SERVER_USERNAME`으로 변경
  (출처: `/docs/server` Authentication 절).
- 실측 (1.18.32, 1.18.18 동일 여부 미확인): 무인증 → 401, 오답 → 401,
  정답(`opencode:<pw>`) → 200+세션 생성. health도 auth 필요.
- 잔여: ProcForge `pf.token` 방식과의 동시 운용 시 헤더 충돌 여부.

## 실측 결과 (2026-11-06, serve 1.18.18, 모델 opencode-go/crouton-alpha-free, 총 비용 0 USD)

| # | 항목 | 결과 |
|---|---|---|
| 1 | `/doc` 키 대조 | 확인 (6키 전부 존재) |
| 2 | 세션→`prompt_async` 204→`idle` | 확인 (위 순서) |
| 3 | `tools` 비활성 | 확인 (도구 호출 part 0건) |
| 4 | 권한 왕복 once/reject/always | 확인 (once·always→완료, reject→미수행, api 200) |
| 5 | POST /mcp 반영 | 확인 (200, ~0s 반영) |
| 6 | Basic auth | 1.18.32에서 확인 (401/401/200). 1.18.18 미확인 |
| 7 | 동시 세션 2개 | 확인 (time-to-idle 2710·2920ms, serve RSS 354→593MB) |

- 동시 4개는 참고 기록만 (time-to-idle 2326·5023·3893·6758ms, RSS 641MB —
  당시 소유권 미검증 실행분). free 메모리 9.0→8.2GB.
- 보류 ①(응답값): once/always/reject는 모두 api 200 + 기대 동작 (해결).
  remember는 Proof 미사용, 동작 미확정(관측 1회) — asked 1회차 1건·2회차 0건, tool part 1회차 5건·2회차 0건 (실측 2026-11-12 1.18.32).
- 보류 ②(우선순위): 해소. 메시지 `tools:false`는 권한 흐름 없이 비활성,
  `permission:ask`는 실행 게이트+`asked` 이벤트.
  실측 2026-11-12 1.18.32: `tools: {"*": false}` + 세션 ask 동시 설정 시
  tool part 0건·asked 0건 (도구 완전 비활성, ask 미발동).

## 실측 중 발견 (문서와 다름·없음)
- SSE data는 `{id, type, properties}` 봉투 (문서에 형식 명세 없음).
- 권한 요청 이벤트명은 `permission.asked` (타입 정의의 `permission.updated` 아님).
  `permission.replied` 이벤트는 관측되지 않음.
- 설정 우선순위: `OPENCODE_CONFIG_DIR` > 프로젝트 > 전역. portable 환경 변수가
  있으면 프로젝트·전역 설정이 묻힌다 (GET /config로 effective 확인 필수).
- `PATCH /config`는 200을 돌려주지만 GET에 반영되지 않는다 (1.18.18).
- 일부 provider는 도구 128개 상한을 강제한다 (OpenAI 계열 400,
  beam-free upstream 400). 무료 모델 일일 한도 초과 시 429 + 재시도 후
  `session.error` (비용 0 유지).
- `permission:ask` + headless 조합에서 `permission.asked` 없이 tool이
  `running`에서 멈추는 경우를 1회 관측 (원인 미특정 — 재현 시 별도 기록).

## 실측 스크립트 사용법 (scripts/m10-probe.mjs)

serve가 떠 있는 사용자 PC에서 1회 실행한다 (에이전트는 serve를 띄우지 않음).

```powershell
node scripts/m10-probe.mjs --model <provider/model>
node scripts/m10-probe.mjs --model <provider/model> --url http://127.0.0.1:4096 --password <pw>
node scripts/m10-probe.mjs --model <provider/model> --concurrency 4
```

- 체크리스트 1~6 수집 → `m10-probe-<날짜>-<시각>.json` + 항목별 확인/불일치/실패 요약 출력.
- 7번(동시 세션 RSS)은 `--concurrency 2|4` 별도 실행. serve 프로세스 RSS는
  스크립트가 안내하는 PowerShell 명령으로 직접 기록한다.
- 안전: 임시 세션만 만들고 끝나면 삭제, 파일 쓰기 도구는 끄고 보낸다.
  장문 대화 금지·비용 상한 안내를 먼저 출력한다.
