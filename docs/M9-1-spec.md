# M9-1 이름 변경 사양 (Proof, scope `@proof`)

> **구현 착수 조건: M8-1 `[x]`.** 이 조건이満たされる 전까지 구현 커밋 4개를 시작하지 않는다.
> 기준: `c227b78` (2026-10-27). 확정값: 제품명 Proof, 패키지 scope `@proof`
> (npm 공개 배포 안 함, 공개 시 재검토).

## 0. 이력

- M9-0 초보고: 기준 `d5fdad2`로 조사 → **반려**. 사유 5건:
  1) 기준이 2주 stale이라 M7 UI·M8-ui·M8-1·M8-1-0 누락,
  2) "TOOL_PREFIX 없음·`pf_` 하드코딩" 오판 (M8-1의 `toolPrefix` 미반영, `pair-discovery.ts`·`signals.jsonl`·`source` 미조사),
  3) `PROCFORGE_OPENCODE_*` 3종 누락,
  4) 접두어 2개 혼동 (MCP 키의 `procforge` 부분 vs `pf_` 부분),
  5) 문서 커밋에 테스트 파괴를 매기는 오류.
- M9-0 재보고: 기준 `c227b78`로 재조사 → **통과**. 전체 `procforge` 출현 193파일·1491줄.
- 보완 조사 3회 (코드 수정 없음): 참조/파괴 분리·쓰는 쪽 env·겹 3개 →
  5건 수정 (catalog 제외·헤더 유지·env 16/1 분리·경고 이음매·미설정 문구) →
  최종 4건 (ui-bg 제외·보안 5종 거절·비밀 마스킹·DEV_AUTH 별도 경고).

## 1. 바꾸지 않는 목록

| 항목 | 위치 | 근거 |
|---|---|---|
| 도구명 `pf_*` 21종 | `server.ts:58-80` `TOOL_NAMES` | wire. `APP_METHODS` 1:1·스냅샷·`calls.jsonl` `tool` 값까지 연결 |
| 프롬프트명 `procforge_decompose` | `server.ts:613` | wire (`mcp-contract.test.ts:472-477`) |
| `format: "procforge-procedure"` | `shared/procedure.ts:23` | 저장된 procedure.json wire |
| 서버명 `procforge-local` | `server.ts:149` | 영향 없음 확인(§5)이나 변경 이유 없음 → 유지 |
| MCP 키 기본값 | (opencode.json 예시) | 변경하지 않음. `toolPrefix` 미설정이 양쪽 수용(§4) |
| 저장소 폴더 `.procforge` | `store-dir.ts:22` | 기존 세션 호환. `.proof` 도입은 보류 |
| `events.jsonl` 필드 | `dto.ts:19-28` (seq/revision/actor/method/nodeIds/beforeHash/afterHash) | 마이그레이션 없이 구 파일 읽기 |
| `calls.jsonl` 필드 | `trace.ts:15-28` (tool/sessionId/nodeId/actor/connectionId/clientName) | `migrateCallLog`이 `tool` 키로 판별(`trace.ts:53`) |
| UI 키·meta | `pf.token:<origin>`·`pf.instance:<origin>`(`auth.ts:7-8`), `pf-instance`(`ui-server.ts:331`) | `procforge` 문자열 없음·`pf_` 계열 |
| 헤더 `x-procforge-token` | 송신 `api.ts:243,253,364`, 수신 `ui-server.ts:392` | 서버·SPA 동일 빌드, 토큰 매실행 재생성 → 유지 |

## 2. 환경변수

### 2.1 분류

- **사용자용 16종** (호환 적용): `DIR`·`PROJECT_ROOT`·`OPENCODE_URL`·`OPENCODE_MODE`·`OPENCODE_TOOL_PREFIX`·`SESSION_TTL_DAYS`·`READ_ONLY`·`STRICT_SANDBOX`·`MAX_ARTIFACT_BYTES`·`CATALOG_TIMEOUT_MS`·`CORE_URL`·`CORE_API_KEY`·`CORE_PORT`·`CORE_DATA_DIR`·`API_KEYS`·`DEV_AUTH`
  (접두어 `PROCFORGE_` 생략. 전부 런타임 읽기 존재: `main.ts`, `core-server/cli.ts`, `server.ts:60,70`, `app.ts:249,362,374,376`).
- **내부용 1종** (개명 제외): `PROCFORGE_CLIENT`. 사용처가 테스트/CI뿐
  (`vitest.config.ts:3`·`client-mode.ts:19,26`·`setup-remote.ts:14`·`ci.yml` matrix·`m8-decomposition.test.ts:12`).
- **보안 5종** (사용자용 부분집합, 값 불일치 시 기동 거절): `READ_ONLY`·`STRICT_SANDBOX`·`DEV_AUTH`·`API_KEYS`·`CORE_API_KEY`.

### 2.2 읽기 규칙

1. `PROOF_*`를 먼저 읽고, 없으면 `PROCFORGE_*` 대체 + stderr 경고 1회.
2. 둘 다 있고 값이 다르면: 경로 등 일반 변수는 `PROOF_*` 사용 + 충돌 경고(쓴 값의 절대경로 명시).
   보안 5종은 **오류로 종료** (조용히 보호가 꺼지는 것을 방지).
3. 경고는 stdout 금지·stderr 1회 (MCP stdio 프로토콜 보호. `logger`는 이미 stderr 전용: `shared/logger.ts:1-4`).
4. 비밀 변수(`CORE_API_KEY`·`API_KEYS`) 경고에는 변수 이름만, 경로 변수만 절대경로를 적는다.
5. `PROCFORGE_DEV_AUTH`가 옛 이름으로 켜지면 이름 변경 경고와 별도로 **"인증 우회 켜짐" 경고**를 낸다 (1회 경고에 묻힘 방지).
6. 경고 1회 보장은 모듈 스코프 seen 집합 + **테스트용 리셋 함수 또는 warn 함수 주입** (테스트 순서 의존 제거).

### 2.3 신규·추가 테스트 (1번 커밋)

- `PROOF_*`만 설정 → 신 값, 경고 없음.
- `PROCFORGE_*`만 설정 → 옛 값 + stderr 경고 정확히 1회.
- 둘 다 다르게 설정 → `PROOF_*` + 충돌 경고 (일반 변수).
- 보안 5종 불일치 → 기동 오류 종료 1건.
- 경고 문자열에 키 값 미포함 1건.
- stdio 모드 기동 1건: stdout 순수 JSON-RPC(경고행 0) + stderr 경고 1회.
- 기존 테스트 파괴 기대값 **0**. 참조만 하는 테스트
  (`store-dir.test.ts`, `remote-client.test.ts`, `client-mode.ts`, `m71-link.test.ts:809-817`,
  `m8-pair-discovery.test.ts:125-316`, `m3-runner.test.ts:810-821`)는 전부 green 유지가 정상.

## 3. 자식 프로세스 규칙

- **규칙**: 테스트 하네스는 물려받은 env에서 `PROOF_*`와 `PROCFORGE_*`를 모두 지운 뒤, 확정값을 두 이름으로 넣는다
  (`spawnCli`가 `process.env`를 펼친 뒤 옛 이름만 덧붙이면 셸의 `PROOF_DIR`이 이겨 실제 저장소에 기록되는 사고 방지).
- **테스트 1건**: 셸에 `PROOF_DIR=<다른 폴더>`가 있어도 그 폴더에 아무것도 생기지 않음.
- 적용 대상 (ProcForge가 ProcForge를 띄우는 곳):
  - `client-mode.ts:157-178` `spawnCli` — 적용.
  - `scripts/ui-bg.mjs:72` (`node dist/cli.js ui`) — **제외**. env 통째 상속이라 부모와 같은 우선순위로 고름.
  - `catalog.ts:179,209` (외부 MCP 서버) — 제외. 전체 상속 유지.
  - `script-run.ts:202` (python/node, allowlist `ENV_ALLOW`) — 제외. 주석 1줄만 추가 (나중에 env 추가 시 두 이름 함께).
  - OpenCode가 띄우는 MCP stdio (`main.ts`) — 코드 주입 지점 없음. opencode.json 문서 예시는 두 이름을 같은 값으로 병기.
- **주의 (반대 위험)**: `spawnCli` 수정 전에는 셸 오염이 테스트를 깨뜨리는 것이 아니라 실제 저장소를 오염시킨다. 하네스 수정이 1번 커밋의 일부다.

## 4. 접두어 2개

**(a) MCP 키·`toolPrefix` (`procforge` 부분).**
도구 이름은 `McpServer`명이 아니라 **opencode.json MCP 등록 키**로 정해진다
(`M8-1-dogfood.md:36-47` "도구 이름은 이 키 접두어를 따른다", `app.ts:264-266`).

| `toolPrefix` | 기존 대화(`procforge_pf_start`) | 새 키 대화(`proof_pf_start`) |
|---|---|---|
| 설정 (`"proof"`) | 못 찾음(`none`, `pair-discovery.ts:54-56` 정확일치) | 찾음 |
| 미설정 (기본값, 권장) | 받음 (`_pf_start` 끝일치, `:56`) | 받음 |

권장안: 기본값 미설정 유지 + 문서 예시만 `proof`. 코드상 성립 (`:54-56` 분기).
신호 문구도 미설정 시 제품명 없이 `"이름이 `_pf_next`로 끝나는 도구"` 형태
(`app.ts:291-297` 현행 "ProcForge의 pf_next 도구"에서 변경. 기존 키 `procforge` 사용자에게 "Proof의 …"는 혼란 유발).

**(b) `pf_` 부분 — 변경 없음 확정** (§1).

## 5. 서버명·기타 불변의 근거

- `procforge-local` 실제 참조는 시작 로그 1곳뿐 (`server.ts:648`).
  짝 찾기·신호 판정은 parts의 `tool` 필드만 사용
  (`opencode-link.ts:119-120`, `pair-discovery.ts:44-56`) → 코드 영향 없음.

## 6. 추가 겹 3개

- **스케줄러**: `scheduling.md:101` `-TaskName "procforge-daily"`. 옛 bin 유지 → 등록된 작업 계속 동작.
  문구는 "새 이름으로 다시 등록하려면 먼저 옛 작업을 지운다". 인수 경로(`:77,83,97,109,123`의 `procforge.cmd`·`dist/cli.js`)는 bin 개명 시 함께 갱신.
- **`pnpm-lock.yaml`**: `@procforge/` 5건. 2번 커밋에 포함 (분리 금지, 중간 상태 install 불가 방지).
- **`where proof`**: Windows 확인 결과 exit 1, 충돌 없음(본 기기 PATH 기준). 문서에 "설치 후 `where proof` 중복 확인" 1줄.

## 7. 문서 변경 범위

- **고치지 않음**: 이력·실측 증거 (`M5.8-opencode-e2e.md`·`M7-dogfood.md`·`M8-1-dogfood.md` 실측값·세션 id·캡처, DECISIONS 기존 행, DEV-GUIDE 8·9절 기존 행).
- **바꿈**: `README.md`(제품명·`@proof`·`core-server` 누락), `SKILL.md`·`command.md` 템플릿
  (`monthly/SKILL.md:16-17` `procforge test/run`), `scheduling.md` env 표기,
  `M2-manual.md:12,28,44`, 이후 작성 절차서. `M8-1-dogfood.md:36-47` MCP 키 예시는 절차이므로 `proof`로 갱신 허용.

## 8. 커밋 4개와 예상 파괴

순서: env → bin/패키지 → 화면 문구 → 문서. **MCP 표면(도구·서버·프롬프트·format)은 별도 결정 항목으로 두지 않는다.**

1. `M9-1-1 env 호환` (§2+§3): 예상 파괴 0 (§2.3). 하네스 `bothNames()` + 셸 오염 테스트 포함.
2. `M9-1-2 bin·패키지`: scope `@proof/*` + bin 신명 추가·구명 유지 +
   `check-deps.mjs:40-96`(`@procforge/*` 문자열)·`ci.yml:96-133`(`@procforge/` filter 4곳) 동시 수정 + lockfile 재생성.
   예상 파괴: `check-deps` CI (허용목록 누락 시), workspace 해석 실패 시 전 스위트.
3. `M9-1-3 화면 문구`: `signalText`·`PROMPT_TEXT`·instruction·`server.ts:618`·`procedureWriter.ts:356`·UI `<h1>/<title>`
   (`App.tsx:154,173`·`TokenGate.tsx:28`·`ui-server.ts:89-90`).
   예상 파괴(커밋 메시지에 "파일:테스트명 — 바뀐 내용" 기록):
   `m71-link.test.ts:837`(copyText 문구), E2E 5곳
   (`m76-ui-e2e.spec.ts:33,55`·`m8-1-reverify.spec.ts:23`·`m8-1-signal.spec.ts:16`·`m8-ui4-token.spec.ts:25`).
   모델 가시 문구 변경이므로 DECISIONS 기록 + 다음 실측에서 재확인 (M8-1 실측값은 구 문구 기준).
4. `M9-1-4 문서` (§7): 예상 파괴 없음 (문서만으로 테스트가 깨질 수 없음).
