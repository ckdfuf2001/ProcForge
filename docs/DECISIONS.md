# DECISIONS

단일 기준 문서(`ProcForge 개발 가이드`)에서 모호한 점을 임의 결정하지 않고 기록한다.
형식: `[M<번호>] <제목> — <가정/결정> / 이유 / 영향`

## M0

- [M0-1] Constraint `spec` 스키마 구체화 — 가이드 §4는 `spec: Record<string, unknown>`으로만 정의. kind별 결정적 검사를 위해 아래 spec 형태를 가정한다. 이유: checker 단위 테스트 가능해야 함. 영향: `shared/schema.ts`에서 discriminated union으로 구체화.
  - `file_exists`: `{ path: string }` — artifacts 목록 또는 로컬 FS 경로 존재 여부. checker에는 `exists(path: string) => boolean` 파일 존재 확인 함수를 주입받아 FS 의존 분리.
  - `json_path_exists`: `{ path: string, jsonPointer?: string, jsonPath?: string }` — `path`는 검사 대상 JSON 값(Attempt 결과/아티팩트 내용 파싱 결과). `jsonPointer` (RFC6901, 예 `/a/0/b`) 우선, 없으면 `jsonPath` 단순 dot 경로(`a.0.b`) 지원. 둘 다 없으면 실패.
  - `equals`: `{ path?: string, expected: unknown, actual?: unknown }` — `path` 지정 시 검사 컨텍스트에서 추출한 값과 `expected`를 deep-equal. `path` 미지정 시 `actual` vs `expected` 비교.
  - `regex`: `{ path?: string, value?: string, pattern: string, flags?: string }` — 추출값/지정값이 정규식과 매치되는지.
  - `count`: `{ path: string, min?: number, max?: number, exact?: number }` — 추출된 배열/객체키/문자열 길이에 대한 범위 검사.
  - `numeric_match`: `{ path?: string, value?: number, expected?: number, tolerance?: number, min?: number, max?: number }` — `expected±tolerance` 또는 `[min,max]` 범위 검사. 부가세 제외 같은 수치 조건 대응.
  - `schema`: `{ jsonSchema: object }` — 검사 대상 JSON이 주어진 JSON Schema를 만족하는지. 구현은 최소 서브셋(타입/required/properties/enum) 자체 구현, 외부 ajv 의존 없음(의존 최소화 가정).
  - `llm_rubric`: `{ rubric: string }` — 결정적 검사 불가. checker는 항상 `{ pass: false, reason: "manual" }` + `needsHuman: true` 반환. pf_report/verdict에서는 `skip`扱い가 아닌 `fail-closed`가 아니라 `unverifiable`로 기록. M0 가정: verdict 계산에서 제외(통과도 실패도 아님)하고 `unverified: [ids]`로 보고.
- [M0-2] checker 입력 컨텍스트 — `Attempt`만으로 constraint를 평가할 수 없어 `CheckContext = { resultSummary?: string, resultJson?: unknown, artifacts: Map<path, content|string>, fileExists: (p)=>boolean }`를 도입. 이유: §7 "checker는 순수 함수" + 로컬 경로 검사를 테스트 가능하게 분리.
- [M0-3] Node `hash` 계산 — `goal+args+constraints+의존노드 hash`는 `SHA-256(JSON.stringify({goal,args,constraints,dependsOn}))` 앞 16 hex로 가정. args의 키 순서 정규화(키 정렬) 후 해시.
- [M0-4] Node id 형식 — `"2.1"` 형식을 정규식 `^\d+(\.\d+)*$`로 검증. root는 `"1"`.
- [M0-5] validator의 "잘못된 트리 10종" 정의 — 아래 10종을 M0 완료 조건으로 고정:
  1. leaf의 tool이 catalog에 없음 2. args가 inputSchema에 부적합 3. var 참조가 존재하지 않는 노드 4. 참조 필드 경로 오류 5. 순환 의존 6. depth 초과 7. 노드 수 초과 8. schemaHash 불일치 9. leaf 확정 조건 미달(verdict!=pass인데 leaf) 10. id/parent/children 불일치.
- [M0-6] local→core 직접 import 금지 범위 — `packages/local/src/**`에서 `from "@procforge/core"` 검사를 CI(`scripts/check-deps.mjs`)에서 실패 처리. 예외: 합성 루트 `core-inprocess.ts` 1파일만 허용 (M1.5 개정 — 당초 "예외 없음"에서 변경. 이유: in-process 합성점이 코드 어딘가에는 필요하고, 1파일로 한정 + M6에서 HTTP 구현으로 교체가 가장 깔끔한 마이그레이션 경로). local 패키지 의존성에는 `@procforge/core: workspace:*`가 존재하나 소스 import는 예외 파일만 허용.

## M1.5

- [M1.5-1] pass여도 leaf 자동 확정 금지 — pfReport pass 시 status=probing 유지, tool/args 확정 없음. 확정은 pf_resolve(leaf, tool, argSpecs)에서만. argSpecs는 마지막 attempt args 키 전체 포함 필수, 누락 시 bad_request. leaf tool은 마지막 attempt tool과 일치 필수.
- [M1.5-2] selfVerdict/selfReason 필수 — constraints가 비었으면 selfVerdict 사용(호스트 정직성 가정). 첫 pass + constraints 비어 있으면 결과 형태 기반 auto constraint(file_exists/artifacts, json_path_exists/최상위 키, 최대 10개) 부착. 이유: 회귀 기반 확보(M3 replay의 검사 대상).
- [M1.5-3] llm_rubric 사유 필수 — 남은 rubric id별 rubricReasons 없으면 needs_human(재시도 차감 없음). Attempt에 rubricReasons 기록 필드 추가(스키마 확장, optional).
- [M1.5-4] 노드 id 정렬 — 세그먼트 숫자 비교 compareNodeIds ("1.2" < "1.10"). pfNext/pfTree 정렬에 사용.
- [M1.5-5] dependsOn 충족 — leaf 또는 (split + 모든 자손 leaf). isResolved 헬퍼.
- [M1.5-6] 재시도 경계 — 총 시도 = maxRetries+1. consumeRetry 단일 함수로 pfReport-fail/pfResolve-retry 통일 (retries > maxRetries → needs_human).
- [M1.5-7] M1-3(부가세 regex) 한계 명시 — 현재 "부가세 제외" 조언 변환은 요약 문구(regex) 검사일 뿐 수치 검증이 아님. M4에서 numeric_match(세전/세후 금액 대조) 기반으로 대체 예정.
- [M1.5-8] 개수 조언 경로 — "N개/장/슬라이드" 조언은 count { path: "items", exact: N } 생성. "items" 키 가정은 M2 휴리스틱이며 호스트가 결과 JSON 형태를 맞추거나 실패 후 조정한다.
- [M1.5-9] Store 포트는 shared(`shared/store.ts`)로 이동 — core·local 모두 shared에만 의존. FileStore는 local 소유로 Store 구현.
- [M1.5-10] PfReportOutput.verdict의 "unverifiable"은 현재 미사용 예약값. rubric 잔존 신호는 unverified[] 목록으로 전달하고 verdict는 pass/fail로 통일.

## M2

- [M2-1] opencode.json mcp 형식 — `{ mcp: { <name>: { type: "local"|"remote", command: string[]|string, cwd?, environment?, enabled?, url? } } }`로 가정. 설정 파일 탐색 순서: 전역(`~/.config/opencode/opencode.json`) → 프로젝트(`opencode.json`, `.opencode/opencode.json`), 프로젝트가 덮어씀. remote 타입은 수집 건너뜀(warnings 기록).
- [M2-2] OpenCode 내장 툴 고정 목록 — read/write/edit/bash/glob/grep, server명 "opencode". 실제 OpenCode 내장 목록과 다르면 M7 이전에 동기화.
- [M2-3] artifacts — 호스트는 프로젝트 상대경로만 제출. local이 읽어 fixtures/<nodeId>/<attemptId>/에 복사하고 Attempt.artifacts에는 fixture 상대경로 기록(세션 디렉터리 기준 자족). 루트 밖·심링크 탈출·부재 파일은 bad_request. 내용은 utf8 텍스트로 checker에 전달(바이너리는 바이트 복사만 보장).
- [M2-4] sandbox — pf_start의 seedFiles(선택)를 sandbox/<sid>/에 상대경로 유지 복사. seedFiles 지정이 가이드에 없으므로 local MCP 도구 입력으로 추가한 확장 (core 계약 변경 없음).
- [M2-5] FileStore 동기 I/O — Store 인터페이스를 sync로 구현(fs sync + 원자적 rename). 싱글 스레드이므로 세션 mutex는 자명. M6 멀티프로세스 시 파일락 필요.
- [M2-6] pf_start toolCatalog 선택화 — 호출자 제공 시 덮어쓰기, 생략 시 collectCatalog 자동 수집. 수집 warnings는 응답에 포함.
- [M2-7] golden 기록 시점 — pf_resolve(leaf)에서 마지막 attempt의 artifacts + resultSummary로 golden 확정.

## M2.5

- [M2.5-1] 에러 봉투 — 업무/검증 에러는 CallToolResult `{ isError: true, content:[text], structuredContent:{error:{code,message,hint}} }`. SDK는 isError 결과의 outputSchema 검증을 건너뛰므로 봉투가 그대로 전달된다. 내부는 code=internal로 치환하고 스택은 stderr에만 기록.
- [M2.5-2] registerTool — SDK 1.32.1 내장(업그레이드 불필요). 전 도구에 title·outputSchema·structuredContent(+동일 JSON text). 계약 테스트는 InMemoryTransport 실연결 + OUTPUT_SCHEMAS 검증. tools/list 스냅샷은 이름·순서·annotations 엄격 일치 + 입출력 스키마 존재 확인(전체 덤프 대신 구조 검사로 brittleness 회피).
- [M2.5-3] pf_resolve 분리 — pf_split/pf_confirm_leaf/pf_retry/pf_ask_human. core CoreClient(pfResolve decision)는 유지, local 서버층에서 매핑. pf_retry reason·pf_ask_human question은 core 계약에 없어 stderr 로그로 기록. pf_finalize/pf_test는 미등록(구현 마일스톤까지). description 금지어: 부가세, llm_rubric, numeric_match, json_path_exists, file_exists, auto constraint, 휴리스틱 (CI grep, server.ts 한정).
- [M2.5-4] annotations — 읽기 3종만 readOnly/idempotent. 전 도구 openWorldHint=false(실행은 호스트 몫).
- [M2.5-5] 응답 크기 — pf_next는 요약(NodeSummary)+retriesLeft(총 maxRetries+1−attempts). pf_tree 기본 요약 목록(goal 80자)+상태별 개수+limit(기본 50)/cursor/hasMore. full 상세요. 200노드 기본 응답 한도 32KB(실측 ~12KB).
- [M2.5-6] 세션 핸들 — core rid 대신 crypto.randomUUID. TTL은 서버층 FileStore meta(lastUsedAt)로 집행, 기본 30일, PROCFORGE_SESSION_TTL_DAYS로 설정. 만료/부재는 session_not_found + pf_start 힌트.
- [M2.5-7] prompt procforge_decompose — args는 문자열만(request?, params? JSON 문자열). MCP prompt 인자는 클라이언트가 문자열로 다루므로 record 대신 string. pf_start 응답에 동일 전문 포함(클라 미노출 대비).
- [M2.5-8] 운영 — PROCFORGE_READ_ONLY=1이면 읽기 3종만 등록(prompt는 유지). 카탈로그 캐시 .procforge/cache/catalog.json(10분, 설정 fingerprint 무효), 서버별 타임아웃 5초. 세션 파일 1MB 초과 시 stderr 경고. local/src의 console.log 금지.

## M2.6

- [M2.6-1] instruction 도구명 — core 응답 instruction의 도구 언급은 tools/list에 존재해야 하며 pf_resolve 언급 금지. 계약 테스트: service.ts 정적 스캔 + instruction-following host E2E(첫 언급 도구만 호출해 완료).
- [M2.6-2] ID 검증 — sessionId UUID v4, nodeId 기존 패턴, attemptId UUID. shared zod + 서버 입력스키마 + FileStore 진입부 이중 검증. Session.id/Attempt.id 스키마 강화.
- [M2.6-3] isEscapeRel — 세그먼트 정규화 판정("..data.json" 허용, ".." 상위·절대경로 거부).
- [M2.6-4] pf_approve — ask_human(plan)으로 dry-run attempt 저장(verdict 없음) → 승인 시 probing+approval → confirm_leaf 가능, 거부 시 open+조언 기록. 미승인 external leaf 불가. PfResolveInput에 plan/note 추가, Node.approval 추가.
- [M2.6-5] artifacts sandbox 제한 — PROCFORGE_STRICT_SANDBOX 기본 on. strict면 제출 경로 기준이 sandbox/<sid>/.
- [M2.6-6] artifact 상한 5MB 초과 bad_request. NUL 바이트 기준 바이너리 판별, 내용은 {sha256,size,mime} 메타 JSON으로 대체. fixtures-manifest(stored→원본 상대경로)를 ingest 시 기록.
- [M2.6-7] 세션 lockfile — sessions/<sid>/.lock(pid+시각), fresh 락 충돌 시 conflict, staleMs 경과 시 정리. 쓰기 도구 + runner가 사용. 동일 프로세스 내 동시성은 JS 단일 스레드로 자명.
- [M2.6-8] attempt id — bare randomUUID (접두사 폐지, AttemptIdSchema 통과용).

## M3

- [M3-1] runner 구조 — local/src/runner (types/connections/workdir/recordings/resolve/run). LLM 없음. 연결 풀은 실행 1회 유지, MCP lazy 연결이므로 replay는 서버 프로세스를 띄우지 않음.
- [M3-2] 내장 툴 — read/write/edit/bash 최소 구현, bash 기본 비활성. glob/grep 등 그 외는 미지원 에러.
- [M3-3] run fs — runs/<runId>/fs/에 manifest 기준 source 상대경로로 fixtures 전개. 원본 쓰기 금지, 쓰기는 run fs로 한정. 경로 재작성은 run fs에 존재하는 상대경로 문자열만.
- [M3-4] generated — replay/cassette는 마지막 attempt 실제값, live는 미지원 에러.
- [M3-5] 모드 — record(호출+녹화)/replay(녹화만, 기본)/passthrough(호출, 녹화 안 함). 키=server+tool+정규화 args 해시(runs 경로 상대화).
- [M3-6] external — 전 모드 실제 호출 금지. 녹화 적중 시 사용, 없으면 결정적 mock + unverified 표시.
- [M3-7] 판정 — checker 재사용. rubric 잔존(mock 포함) 시 unverified(실패 아님). golden 비교는 replay만(summary 문자열 비교), 불일치 시 fail+diff. --update-golden이면 비교 대신 golden.output 갱신(fixtures는 pf_report 소유이므로 output만).
- [M3-8] 범위 — 전체/서브트리(범위 밖 의존 출력은 golden에서 공급, JSON 파싱 실패 시 원문)/--changed(최신 리포트 nodeHashes 비교 + 하류). 비-leaf는 skipped.
- [M3-9] 산출물 — runs/<runId>/report.json + by-session latest 포인터. JUnit XML 옵션. --update-golden 없이는 golden/cassette 불변.
- [M3-10] compareNodeIds를 runner에 복제 (local 자족, core import 금지 준수).

## M3.1

- [M3.1-1] 모드 역할 — replay: 인자 해석·참조·녹화 적중·constraints만 (golden 비교 없음).
  passthrough: golden 정규화 비교로 drift 검출. record: 녹화만. --update-golden은
  record/passthrough 전용, replay와 병용 시 bad_request(CLI exit 2).
- [M3.1-2] 정규화 비교 shared/normalize — runFs 절대경로→{RUNFS}, ISO 시각→{TIME},
  UUID→{UUID} 치환 후 비교. JSON이면 구조 비교(무시 경로 제거), 첫 불일치 JSON 경로 +
  200자 excerpt. 텍스트면 첫 불일치 문자 위치 + 앞뒤 200자. golden.ignore는
  confirm_leaf(ignore 인자)→goldenIgnore→golden.ignore로 기록.
- [M3.1-3] 경로 역할 — ArgSpec.path 명시 우선. 추정 규칙: output/outfile/dest(/_path/_dir
  접미·out_/output 접두 포함) → out. path/file/input/src/template/dir 계열(포함 매치) →
  in. inputSchema properties format(uri/file/path/file-path/directory) → in. 그 외
  재작성 안 함. in은 runFs 우선·projectRoot 읽기 폴백(둘 다 없으면 에러).
  out은 존재 무관하게 runFs 매핑, fs 밖 절대경로 거부. 경계 검사는 isEscapeRel만
  (prefix startsWith 금지). MCP 서버 spawn cwd=runFs. 녹화 키는 fsDir→RUNFS,
  projectRoot→PROJECT 접두로 정규화(머신 간 결정성).
- [M3.1-4] 실패 전파 — 범위 밖 의존 출력만 golden 선주입. 범위 내 의존이
  fail/blocked이거나 출력이 없으면 blocked(detail=원인 id), 실행 안 함.
  비-leaf는 skipped. JUnit·요약에 blocked 별도 집계.
- [M3.1-5] golden.attemptId — confirm_leaf 시점 pass attempt id 기록. generated는
  해당 attempt args에서만 취득. attemptId 부재(구 세션)는 마지막 pass attempt로
  마이그레이션(폴백).
- [M3.1-6] JUnit — unverified/skipped/blocked → skipped element. failures는 fail만.
- [M3.1-7] compareNodeIds shared 이동 (M3-10 복제 철회). core/src/ids.ts는 재수출로 유지.

## M3.5

- [M3.5-1] 실사용 테스트는 사용자 환경에서 수행 (실제 OpenCode·모델 필요).
  PPT MCP는 knorq-ai/pptx-mcp-server 권장 (PyPI·37종·검증 내장). 샘플·시나리오·측정표는
  examples/dogfood + docs/M3.5-dogfood.md에 준비. 코드 수정은 instruction·description 한정.

## M3.6 (산출물 캡처 + 마스킹)

- [M3.6-1] export 모드 — with-content(`--redact --include-originals`)는 원본 +
  기술자(`<원본명>.redacted.json`) 병행이 정상 (원본마다 기술자 쌍 존재, 무결성
  검증용). redact-only zip은 기술자만 포함하므로 request/goal/args/
  resultSummary/golden/녹화본/fixture 내부 문자열이 원천 차단된다 (회귀 테스트로
  고유 문자열 부재 확인). 텍스트 파일에도 기술자가 생기는 것은 버그가 아님.
- [M3.6-5] dep_without_dataflow — confirm_leaf 시 dependsOn 중 var($노드...,
  조상 포함)/generated(inputs, 노드 id) 어디에서도 참조되지 않으면 warnings에만
  기록 (에러 아님). 참조 파서는 shared/args-schema 공용.
- [M3.6-4] golden params 치환 — 확정 시 golden.output 안의 params 값은
  JSON 문자열 완전 일치만 `${params.key}` 자리표시자로 저장 (부분 문자열
  치환 금지. 비JSON은 길이 4 이상 값만 치환). passthrough 비교·--update-golden
  갱신 시 현재 params로 복원/재치환. 모르는 키 자리표시자는 그대로 두어
  drift로 검출.
- [M3.6-6] generated E2E — fake-ppt fill_template에 content(선택) 인자 추가
  (파일·응답에 반영). 1.3 content=generated(inputs 1.2)로 record→replay→
  passthrough 통과.
- [M3.6-2] 입력 자동 캡처 — pf_report/pf_confirm_leaf 시 local이 in/inout
  역할 인자 파일을 fixtures에 자동 ingest (호스트 제출 불필요, best-effort:
  존재하는 baseDir 안 파일만, 실패 금지). 역할은 명시 path → 내장 고정 →
  paths.ts 추정. 확정 시에는 명시 역할 + 미수집분만 같은 attempt에 append
  (startIndex, 해시는 attempt 미포함이라 무관).
- [M3.6-3] 출력 자동 캡처 — out 역할 인자 + 응답 JSON 문자열 중 baseDir에
  실제 존재하는 파일을 artifacts로 ingest (최대 10개, URL 제외). 첫 pass의
  auto file_exists가 그대로 부착된다. 바이너리(pptx 등)는 sha256 비교 없이
  존재+크기>0만 검사 (fixtureFileExists, 확장자 기준).
- [M3.6-7] 내장 툴 버전 대응 — 세션에 opencodeVersion 기록
  (`opencode --version` best-effort, 실패 시 "unknown"). 버전별 스키마 표는
  BUILTIN_BY_MAJOR (major 기준, 현행 "1" 가정·read offset/limit 포함).
  표에 없는 major·unknown은 현행 스키마 + additionalProperties 허용 +
  경고 (엄격화는 실측 스키마 확인 후). 버전은 카탈로그 fingerprint에 포함.
  runner read는 offset(0-based 시작 줄)/limit(줄 수) 지원.

## M4.1 (finalize/capture 보정)

- [M4.1-1] 명령 파일은 `<projectRoot>/.opencode/command/<name>.md`에 출력
  (projectRoot 생략 시 procforgeDir 부모). 기존 파일 + force 없음 → 쓰기 전
  거부.   procedures/<name>/ 안에는 `command.md` 사본만.
- [M4.1-2] PROCEDURE.md 단계·목차는 compareNodeIds 정렬 (문자열 정렬의
  1.10 < 1.2 전도 방지).
- [M4.1-3] params 경고 확대 — fixed 문자열의 부분 포함(길이 3 이상 값만) +
  golden.output 포함 (자리표시자 복원 후 검사).
- [M4.1-4] finalize 전 validateTree 실행. 오류 있으면 bad_request + 목록
  (resolved 검사 이후).
- [M4.1-5] 재-finalize는 `procedures/<name>.tmp-<uuid>`에 생성 후 원자 교체.
  Windows rename 덮어쓰기 불가 →   기존 폴더를 `.old`로 이동 후 교체·삭제,
  실패 시 롤백 시도.
- [M4.1-6] 절차 이름 규칙 `^[a-z0-9][a-z0-9-]{0,63}$` (skill 호환). 위반은
  bad_request. 기존 대문자·언더스코어 이름은 거부된다.
- [M4.1-7] 입출력 판정은 sandbox 스냅샷 기준 — pf_next가 노드를 내줄 때
  sandbox 파일 {path,size,mtimeMs}을 nodes/<id>/pre-snapshot.json에 기록.
  보고 시 새로 생기거나 바뀐 파일 → out, 그 외 자동분 + 호스트 제출분 → in.
  out은 attempt 증거로 ingest하되 확정 시 golden에서 제외 (run fs 미복사).
  명시 path(확정 시)는 스냅샷보다 우선. 스냅샷 없으면 기존 로직 폴백 +
  pf_report warnings. 스냅샷은 sandbox만 (strict=false는 폴백).
- [M4.1-8] SKILL.md/command.md는 "검증(replay)만 가능, 새 데이터 실행은
  미지원(M5)"으로 표기 (params 변경분은 drift 검출).

## M4.2 (계층 정리 + M4.1.1 보정)

- [M4.2-0] 0단계 공용 기반 — shared/errors(ProcForgeError·코드 목록,
  core/service·server err() 교체), shared/dto(Actor·EventEntry·변경
  입출력 envelope), validator shared 이동, 세션 revision(신규 0·구 세션은
  파서 기본값, 0.5-2부터 읽기 중 쓰기 없음), events.jsonl R7 append/read 헬퍼.
  방출 지점 연결·revision 증가/충돌 검사는 1~2단계에서 (core는 파일을
  모르므로 local/App 측에서). trace buildTrace는 R7행 무시로 선방어.
- [M4.2-0.5-1] revision·이벤트 core 이관 — TxStore 오버레이로 변경 메서드를
  감싸고 commit 순서 appendEvents → 저장. 쓰기 없으면 bump 생략(pfNext
  읽기 경로). pfStart는 생성이라 이벤트 없이 revision 0. runner 직접
  저장(updateGolden)·확정 보정·procedure import는 이번 단계에서 우회 유지
  (1~2단계에서 core 경로로). 메서드 본문은 await 없이 동기 유지.
- [M4.2-0.5-2] getSession 읽기 중 쓰기 제거 — 구 세션 revision은 파서
  기본값으로 메모리에서만 0, 파일은 다음 저장 때 반영. 읽기 후 바이트 불변.
- [M4.2-0.5-3] calls.jsonl 분리 — events.jsonl은 상태 이벤트 전용, 호출
  기록은 calls.jsonl. 구 혼합 파일은 접근 시 1회 분리 마이그레이션(멱등).
- [M4.2-0.5-4] 옛 ErrorCodes 제거. 던지는 code 정적 테스트는 throw문 근처
  400자에서 수집 (반환용 validator 코드는 대상 아님).

## M4.2-1 (server.ts 로직 이전)

- App 1:1 (ProcForgeApp, local/src/app). 어댑터는 스키마 검증·호출·응답 포맷·에러
  변환만. requireFresh·락은 App으로, logged() 호출 기록은 계측이라 서버 유지.
- stage-2 overlap: confirm/finalize 이전에 필요해서 core.amendAttemptArtifacts·
  pfBuildProcedure를 1단계에서 먼저 만듦 (2단계는 나머지만).
- R1 예외 유지: procedure import·runner updateGolden 직접 저장 (core 경로 결정은
  추후). PROMPT_TEXT·DEFAULT_SESSION_TTL_MS는 app 소유, server 재수출.

## M4.2-2 (신규 CoreClient 메서드)

- pfEditArgs/pfEditNode — 확정 인자·목표/조건 직접 수정. leaf+goal 변경은
  open으로, 수정 인자는 suggestedArgs에 저장 (다음 보고 시 소진). pfNext는
  suggestedArgs 보유 노드에 수정 고지. 하류 propagateStale 적용.
- pfUpdateCatalog(sessionId, entries) — 수집은 local, 저장만 core. 세션
  toolCatalog 전체 교체 (가이드 표의 sessionId 생략은 표기 간소화로 보고
  세션 기준으로 구현).
- getEvents + Store.readEvents — 메모리·파일 구현, sinceSeq 지원. Tx는 base
  위임 (미확정분 제외).
- MCP pf_edit_args/pf_edit_node — App 1:1 + tools/list 등록 (순서 고정).
  빈 patch도 변경 없음으로 거부.

## M4.2-2.5 (App 직접 접근 제거)

- 2.5-1a: core.getSession/getNode + TTL/touch core 이관. Store에
  touchSession/getLastUsed 추가. errResult 정규식 분기 제거 (core가 직접
  session_not_found).
- 2.5-1b: App은 core 조회로 전환, 조립은 진입점(main·테스트)으로 이동하고
  server는 완성된 App만 받음.
- 2.5-2: 세션 잠금을 core change() 안으로 이동. Store.withLock
  (FileStore lockfile, Memory no-op). App.locked()/store 필드 제거.
- 2.5-3: pending-<rev>.json 원자 커밋 (기록 → 노드 → 세션 → 이벤트 →
  삭제). getSession·commitChange 진입 시 재반영 (이벤트 seq 중복 방지).
  getNodes/getNode는 미적용 (세션 열기가 선행되는 흐름 전제).
- 2.5-4: pf_next 쓰기 전환 (READ_ONLY 제외·WRITE_ANN·잠금은 change 내장).
  confirmLeaf 결과물 수정+확정을 leaf 입력 artifacts로 통합 (amend 2회차
  제거). guide-3단계-6(pf_next annotation) 선행 해소.
- 2.5-5: 변경 응답에 revision/changedNodeIds (done:true 포함 균일).
  순서 인자 core 메서드는 객체 입력으로 통일 (ChangeOpts 삭제). MCP 입력에
  expectedRevision/actor 추가 (actor 미지정 시 host). App은 전달만.
- 2.5-6: App 입출력 DTO (shared/dto, MCP inputSchema와 공유, 단일 원천).
  argSpecs path는 shared 스키마 기준(inout 허용으로 일치). test nodeId는
  wire 스키마에 없음 (3단계-4에서 추가, runner 직접 호출용 유지).
- 2.5-7: change() 본문 Promise 반환 시 internal 즉시 실패 (tx는 finally 복구).
- 2.5-8: 분리 실증 (m25-separation) — MemoryStore core + 임시 폴더 App으로
  MCP 흐름 통과. pf_test/pf_finalize 제외 (runner가 FileStore 세션을 직접
  읽음, 추후 core 경유로). 완료 grep은 store 직접 호출 기준 (core./app.
  제외).
- 2.5.1-1: 읽기 경로 복구 제거. pending은 숫자 revision 순 메모리 뷰로만
  반영 (파일 불변). 동시 커밋은 lockfile 직렬화 + 호출 측 재시도로 seq 중복 0.
- 2.5.1-2: pending 숫자 정렬, 손상은 .corrupt-<ts>로 이동 (삭제 금지),
  복구 실패 시 새 커밋 거부 (internal + 힌트 "복구 필요").
- 2.5.1-3: pfNext 분기 시 open→probing 전환 저장, 처음 전환만
  enteredProbing. App은 true일 때만 스냅샷 (실패는 응답 경고),
  pf_retry 성공 시도 기록. guide-3단계-6 잔여분 해소.
- 2.5.1-4: report/confirmLeaf/advise는 expectedRevision 생략 시 읽은
  revision 전달. App 호출-읽기 사이 끼어든 변경은 conflict (호스트 재시도).
- 2.5.1-5: filestore withLock은 잠금 중이면 25ms×20회 재시도 후
  conflict. Store.withLock/service.change 비동기로 전환.
- 3-0-1: pending에 커밋 revision 기록(CommitChangeSchema). 낡은 pending
  (revision<=파일 session.revision)은 읽기·복구에서 적용 없이 정리만.
  pending 삭제는 fsutil.unlinkRetrySync 재시도 사용.
- 3-0-2: recoverSession은 첫 실패·손상에서 중단, 손상도 failed 처리로
  새 커밋 거부. 손상 파일명은 .corrupt-<rev>-<ts>.json (파일명에서 rev 추출).
- 3-0-3: FileStore.commitChange는 session 필수 (없으면 internal).
  revision 파일 폴백 제거 (호출자가 항상 bumped session 전달).
- 3-0-4: 읽기 pending zod 파싱은 3-0-1에서 완료. applyPending seq Set 1회
  계산, 파일락 낡은 주석 정리, filestore assert/conflict를 pfError로 통일.
- 3-1: 바뀐 파일은 inout 분류. 원본 탐색 seed→앞노드캡처→pre-copy,
  pf_next/retry 시점 사본(nodes/<id>/pre/, 5MB 이하) + seed 원본 보존.
  원본 fixture를 golden에 유지(증거는 outs), run fs 오버레이는 원본 우선.
  미해결 inout은 confirm 거부.
- 4-0-1: .corrupt-* 잔류 시 commitChange 계속 거부. 해제는 CLI
  `procforge repair <sid> --discard <rev>`로만 (App.repair 경유, MCP 도구 없음),
  human repair 이벤트 기록.
- 4-0-2: planPendings 단일 계획으로 읽기·복구 공용. 적용은
  revision===직전+1 연속분만, 첫 손상·불연속에서 중단.
  CommitChangeSchema.revision 필수 (누락은 손상 취급).
- 4-0-3: session.json 부재 시 적용 가능 pending에서 세션 뷰 구성
  (getSession/getNodes pending 뷰, 다음 커밋으로 파일 복구).
- 4-1: 어댑터 import 허용 목록 (check-deps). App 합성은 app/bootstrap,
  CLI 인자는 app/cli-args, 표면 값은 app/surface 경유. CLI test/trace/
  export/repair 전부 App 메서드 경유. CLI --junit/--out은 프로젝트 안만
  허용으로 통일. pf_test changed wire 추가.
- 4-2: 어댑터 fs 직접 사용 금지 (saveNode·write/read/exists/mkdir) +
  FileStore 저장 계열 호출 허용 범위 (core·합성·filestore·app·services·
  runner·procedure) 검사를 check-deps에 추가.
- 4-3: app/tools.ts APP_METHODS 단일 원천, server 핸들러를 디스패치로
  전환. TOOL_NAMES 집합 일치 + 메서드 존재 테스트.
- 4-4: shared/loopback.ts createLoopbackClient (JSON 왕복+DTO zod,
  inner 오류 그대로 전파). 테스트는 testStack/wrapClient로
  PROCFORGE_CLIENT 양쪽 실행, CI 매트릭스에 client 축 추가.
- 4-5: test/parity.test.ts — App 직접 호출과 MCP 전송 동일 시나리오,
  uuid·시각 정규화 후 session·nodes·확정 응답 일치.
- 4-6: test/arg-schema.test.ts — server 소스 정적 파싱으로 도구↔
  inputSchema 대응, 핸들러 a.*·설명서 (필수/선택) 인자는 스키마 키.
- 4-1/4-2 수정: check-deps가 Windows에서 빈 스캔(항상 통과)이던 결함
  수정 (fileURLToPath). 멀티라인 import 여는 행 제외, *.test.ts는
  저장 범위 검사에서 제외 (저장소 직접 검증 목적).
- 3-2: junitPath는 프로젝트 안만 허용(탈출 bad_request), 생략 시
  runs/<runId>/junit.xml 항상 기록. 응답에 junitPath 포함.
- 3-3: pf_test.procedure에 PROCEDURE_NAME_RE zod 적용 (MCP 입력은
  이름만, 경로 지정은 CLI/runner 직접 호출로 유지). ../ 등 거부.
- 3-4: pf_test nodeId를 wire 스키마에 추가 (runner 서브트리 실행 노출).
  서브트리만 결과에 포함, 없는 노드는 not_found.
- 3-5: golden params 경고는 복원 전 원문 기준. 자리표시자 있으면
  경고 없음, 실제 값이 박혀 있으면 경고 (복원 후 오탐 제거).
- 3-7: pf_advise 응답 constraints.summary는 constraintSummary 사용
  (기존 kind 그대로 버그 수정, nodeSummary와 통일).

## M3.2

- [M3.2-1] passthrough도 generated는 golden attempt 기록값. live 모드 추가(생성 재생성,
  M5까지 unimplemented). CLI·pf_test mode enum에 live 포함(실행 시 거부).
- [M3.2-2] confirm_leaf fixed 정규화 — sandbox/<sid>/·프로젝트 절대경로 → 상대경로,
  그 외 절대경로는 유지+warnings(응답 포함). runner도 동일 함수로 마이그레이션 적용.
- [M3.2-3] PathRole inout 추가. 추정 순서: ArgSpec.path → 내장 고정(write.path=out,
  edit.path=inout) → 카탈로그 readOnlyHint=true면 in → 인자명 규칙 →
  파일 미존재 & 비-readOnly면 out. annotations 미상은 비-readOnly 취급.
  ToolCatalogEntry.annotations 추가(수집 시 기록). 내장 read/glob/grep은 readOnly.
- [M3.2-4] projectRoot 폴백 기본 off (--allow-project-read로만 on). off + fixture
  누락 시 "fixture 없음: <경로>, record 모드로 재녹화" 에러.
- [M3.2-5] resolve.ts 구 rewritePaths 삭제 (paths.ts로 일원화).
- [M3.2-6] 내장 도구 응답에 resultJson 추가 (판정 대상). 경로 후보 판정은
  슬래시/확장자 패턴(무분별 매핑 방지). 녹화 키는 fsDir→RUNFS, projectRoot→PROJECT.

## M3.3

- [M3.3-1] 이름 규칙 in은 weakIn(약한 추정). 존재→in, 미존재+비-readOnly→out,
  미존재+readOnly→in(실패). schema format 판정은 강한 in 유지.
- [M3.3-2] 재작성은 확정 역할(명시/내장/어노테이션/이름·스키마 규칙)만.
  역할 미확정은 경고 로그 후 원문 유지. URL(스킴://)은 항상 제외.
  부수 발견: MCP 서버 입력 검증이 스키마 외 키를 strip하므로 녹화는 실제 수신값 기준.
- [M3.3-3] in + fs 밖 절대경로 + 폴백 off → bad_request(fixture 없음).
- [M3.3-4] inout은 run fs 내 존재 필수. 미존재 → bad_request(fixture 없음).
  inout의 projectRoot 폴백 없음(편집 쓰기가 원본에 닿는 것을 방지). 죽은 생성-매핑 분기 제거.
- [M3.3-5] latest.json에 lastPassHash 병합 저장. pass만 갱신, 미실행 유지,
  fail/blocked 삭제. --changed는 불일치·부재를 변경으로 처리. 서브트리 실행은
  범위 밖 기록을 보존.
- [M3.3-6] split 의존은 자손 leaf로 펼침(shared/deps: isResolved·expandDepLeafs·
  descendantLeafs, core·runner 공용). split 출력={childId:output}. $2.2 같은
  자식 직접 참조는 기존 규칙 그대로.

## M3.4

- [M3.4-1] readOnly는 확정 아님. 미확정 역할은 경고 후 원문 유지(URL 포함).
  toolReadOnly는 weakIn 판정에만 사용(미존재 시 out 금지 → in 실패).
- [M3.4-2] existsInScope는 폴백 on일 때만 projectRoot 검사.
- [M3.4-3] 절대경로 일원화: fs 안은 상대경로와 동일 규칙. fs 밖은 in + 폴백 on +
  프로젝트 안 + 존재만 허용, 나머지 전부 거부(프로젝트 미지정 시도 거부).
- [M3.4-4] inout은 run fs 내 존재 필수(미존재 → fixture bad_request).
  inout의 projectRoot 폴백 없음(편집 쓰기의 원본 침범 방지).
- [M3.4-5] latest.json에 lastPassHash 병합 저장(pass만 갱신·미실행 유지·
  fail/blocked 삭제). --changed는 불일치·부재를 변경으로 처리.
- [M3.4-6] 노드 hash의 의존 입력 = 펼친 leaf hash 집합. hashFor+propagateStale을
  resolve/split/report-pass/advise에 적용. split 자식은 빈 해시 저장 금지
  (FileStore 엄격 파싱 때문, 계산 후 저장).
- [M3.4-7] confirm_leaf additionalProperties:false + 등록 외 키 → bad_args
  (편집 거리 2 이내 유사 키 제안). validator는 조상/자손 의존을 dep_on_lineage로 거부.
- [M3.4-8] 녹화 응답 정규화: record 시 runFs 절대경로 → {RUNFS}(양 구분자),
  replay 시 현재 runFs로 복원 + 옛 runs/<id>/fs 패턴 마이그레이션.

## M3.4.1

- [M3.4.1-1] cassette 버전화 {version: 2, entries}. 로드 시 무버전이면 1회
  마이그레이션 후 v2 저장. restore는 {RUNFS} 복원만. 마이그레이션은
  runId/fsDir 리터럴 우선, 없으면 공백 허용 개선 정규식 + 경고.
  Recording에 runId/fsDir 기록 (save 시).
- [M3.4.1-2] 경로 정규화 단일 함수 runner/pathnorm.ts. 치환 형태 = 원형,
  "/"형, JSON 이스케이프형(JSON.stringify slice), 각 "/" 변형. 드라이브 대소문자
  무시. 녹화 키 + 응답 정규화가 공유.
- [M3.4.1-3] inferPathRole 토큰화(snake/kebab/camel 분해). weakIn은 마지막 토큰이
  경로 토큰(path/file/filepath/dir/directory/folder/src/source/template) 또는
  전체명이 IN_EXACT일 때만 (filename 제외). weakIn + 비경로값은 원문 유지 + 경고.
  쓰기 툴 profile/xpath/file_type/input_language 보존 테스트.
- [M3.4.1-4] loadCassette 파싱 실패 → 원본 .corrupt-<ts> 이동 + bad_request.
- [M3.4.1-5] 펼침 빈손(split 자손 leaf 0개·자식 id 부재) 의존은 blocked.
  core isResolved(false)와 판정 일치 테스트.
- [M3.4.1-6] mapRel의 코드 없는 Error 3곳 → bad_request 통일.
- [M3.4.1-7] CI 매트릭스에 windows-latest 추가. Windows 실패는 skip 없이 수정
  (자식 프로세스 경로 fileURL·구분자·대소문자 이슈 해결).

## M4 (절차서 산출 + 검증 강화)

- [M4-1] pf_finalize는 local 전담 (core 변경 없음). resolved = 전 노드 leaf 또는
  완성 split (shared isResolved). 미해결 목록과 함께 bad_request.
  fixed==params는 warning만 (차단 아님).
- [M4-2] procedure.json이 재실행 단일 원천. 실행 시 새 세션으로 import
  (goldenArgs→attempts 재구성으로 generated 해결, 경로 무변경). params는 import 시
  덮어씀. command 파일은 procedures/<name>/.opencode/command/에 두고 프로젝트로
  복사해 사용.
- [M4-3] numeric_match expectedRef는 runner에서만 판정. core에는 nodeOutputs이
  없어 deferred→unverified (llm_rubric와 같은 통로, 사유 요구 없음).
  부가세 자동 변환(regex)은 문구 검사에 불과하므로 제거 → llm_rubric +
  pfAdvise 응답의 numeric_match 제안 안내로 대체.
- [M4-4] pf_advise proposedConstraints: 제안 있을 때만 평가 경로 (없으면 기존
  자동 변환). fixture 내용 + 최신 요약으로 실제 평가. 채택=결정적 판정 가능
  (pass/fail 무관), 거부 사유 반환. 채택 0개 → llm_rubric 폴백. CoreClient에
  4번째 선택 인자로 추가 (기존 호출 호환).
- [M4-5] trace는 events.jsonl(서버 기록) + 노드 기록 폴백 이중 지원. export zip은
  STORE 무압축 자작 (의존성 없음), Python zipfile·Expand-Archive 호환 검증.
  M3.5 실측은 사람 담당, 에이전트는 도구+측정표까지.

## M3.4.4 (실효 의존 통일 + 교착 종결)

- [M3.4.4-1] shared/deps에 effectiveDeps(raw own+조상+var 펼침, 자기·자손 제외) 신설.
  pfNext ready·runner 순서·hashFor·propagateStale·hasCycle이 이것만 사용.
  정정: M3.4.3-3 기대값 '1.3.2 leaf 유지'는 상속 미반영 가정이었다. 1.3.2는 조상
  1.3의 dependsOn ["1.2"]를 상속하므로 1.2.1 변경 시 함께 open이 맞다.
- [M3.4.4-2] computeDeadlock 원인 하강 + 승격 폴백. 원인 0개면 stuck 자신 승격,
  승격 불가 원인만 있으면 첫 stuck 승격. seed 고정 50 그래프 불변식
  (needs_human 종결·blocked 2회 연속 금지). descendantLeafs corrupt 순환 가드.
- [M3.4.4-3] pf_split 자식 dependsOn 검증 (기존·형제 외 bad_request dep_missing).
  tentative 순환 + hasLineageDep(자식 parentId 포함) 이중 검사.

## M3.4.3 (그래프 교착)

- [M3.4.3-1] pfNext 교착 응답 — ready 0 + pending + needs_human 없음이면
  done:false + blocked[{nodeId, waitingOn, reason}] + 첫 stuck 노드.
  reason: dep_missing(부재)/dep_empty_split(빈 펼침)/dep_failed(마지막 실패)/
  dep_pending(그 외·순환 포함). 존재하는 원인은 needs_human 승격.
  instruction은 pf_advise/pf_reopen 지시. computeDeadlock 순수 함수로 분리·단위 테스트.
- [M3.4.3-2] 순환 검사는 펼친 그래프 기준 (shared hasCycle, validator·core 공용).
  pf_split 저장 전 검사, 순환 생성 시 bad_request. validator 기존 cycle 테스트 유지.
- [M3.4.3-3] propagateStale: 하류 split은 상태 유지 + 해시만 갱신. 펼친 의존
  검사가 자손 leaf에 직접 도달하므로 하강 불필요. 재-split 불필요 테스트.
- [M3.4.3-4] argSpecs 검사는 shared/args-schema 공용 (core bad_args·validator
  bad_args). type 배열(["string","null"] 등) 지원. similarKey 이동.

## M3.4.2 (CI green)

- [M3.4.2-1] pnpm/action-setup의 version 핀 제거 (packageManager 필드 사용).
  packageManager pnpm@9.0.0 = 로컬 일치 확인, lockfileVersion 9.0.
- [M3.4.2-2] job defaults run shell bash (grep 검사 Windows 호환).
- [M3.4.2-3] lockfile 강제 종료 테스트: Windows=taskkill /f, 그 외 SIGKILL +
  exit 이벤트 대기 (고정 sleep 제거). 플랫폼 분기는 테스트 내부에 한정.
- [M3.4.2-4] writeAtomic EPERM/EBUSY/EACCES 재시도 (최대 5회, 50ms 간격).
  local/src/fsutil.ts로 일원화 (filestore/artifacts/recordings/catalog/run).
- [M3.4.2-5] 테스트 명령을 CI와 동일하게 `pnpm -r run test -- --run
  --testTimeout=20000 --hookTimeout=20000` (`pnpm -r test --` 형식은 pnpm이
  옵션을 거부하므로 `run` 경유).
- [M3.4.2-6] README CI 배지 추가. 이후 보고에는 Actions run URL 포함.

## M1

- [M1-1] checker 주입 — §6 pf_report의 verdict 계산은 local checker(§7)가 소유. core는 `EvaluateFn`을 생성자 주입받고 기본값은 constraints-empty→pass, 그 외→fail. 이유: core→local import 순환 방지 + 의존방향(local→core 금지) 유지. M2에서 local MCP 핸들러가 `checker.evaluateAll`을 주입한다.
- [M1-2] split 자식에 sideEffect 지정 — `PfResolveInput.children[]`에 `sideEffect?` 추가(가이드 §6의 `sideEffect?`를 자식별 지정으로 확장 해석). 이유: external 차단 테스트에 필요. 영향: shared/core-client 변경.
- [M1-3] "부가세 제외" 조언 변환 — regex `{ path: "summary", pattern: "부가세.?제외|세전|VAT[^\n]*excl" }`로 결정적 변환. 이유: M4 "자동 검사"를 llm_rubric(비가역)으로는 만족 불가. 요약에 기준 명시를 강제하는 형태로 검증 가능하게 함.
- [M1-4] stale 처리 — hash 변경 시 하류(dependsOn으로 직접/전이적 연결) 중 leaf/split만 open으로 되돌림. `stale` 상태값은 추가하지 않음(NodeStatus 변경 금지).
- [M1-5] needs_human만 남으면 pfNext가 해당 노드 반환(조언 유도). done은 open/probing/needs_human이 모두 없을 때만 true.
