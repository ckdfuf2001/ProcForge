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
  거부. procedures/<name>/ 안에는 `command.md` 사본만.
- [M4.1-2] PROCEDURE.md 단계·목차는 compareNodeIds 정렬 (문자열 정렬의
  1.10 < 1.2 전도 방지).
- [M4.1-3] params 경고 확대 — fixed 문자열의 부분 포함(길이 3 이상 값만) +
  golden.output 포함 (자리표시자 복원 후 검사).
- [M4.1-4] finalize 전 validateTree 실행. 오류 있으면 bad_request + 목록
  (resolved 검사 이후).
- [M4.1-5] 재-finalize는 `procedures/<name>.tmp-<uuid>`에 생성 후 원자 교체.
  Windows rename 덮어쓰기 불가 → 기존 폴더를 `.old`로 이동 후 교체·삭제,
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
  - [M5-6 철회] run 지원으로 위 표기 철회. SKILL/command에 replay+run 병기.

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
- M3.5.1-1: auto file_exists는 fixture 키 대신 sandbox 논리 경로 저장
  (artifactSources 전달). 매 pass마다 source:auto 재생성(human 유지) 후
  평가·저장. runner fileExists는 manifest 역조회. 재보고 pin 해소.
- M3.5.1-2: passthrough drift는 녹화 응답과 정규화 비교 (호스트 요약 제외).
  재바인딩 대비 녹화에 params 저장·양측 마스킹. 바이너리는 sha/size 지문.
  updateGolden 시 카세트도 재기준.
- M3.5.1-3: report 시 resultJson 키를 카세트 녹화 응답과 대조 (키 일치로
  탐색). 미확인 키는 경고, auto json은 확인된 키에서만 생성. 없으면 신뢰 유지.
- M3.5.1-4: 카탈로그 수집 기본 15s + 서버당 1회 재시도. App/CLI 설정화
  (PROCFORGE_CATALOG_TIMEOUT_MS).
- M3.5.1-5: 도구 없는 단계(호스트 스크립트) 처리 — 결정만, 구현은 M5.
  관찰: xlsx 집계처럼 MCP 도구가 없는 단계는 현재 opencode/read +
  호스트 작성 resultJson으로 기록된다. replay 검증 불가·passthrough drift가
  따른다 (M3.5 관찰 2).
  결정: `script` 리프 도입 (M5에서 구현). 형식 제안: 노드 tool을
  `{server: "host", name: "script"}`로 두고 args에 `{script: <run fs 상대경로>,
argv: [...]}` 고정. runner는 run fs에서 직접 실행해 stdout을 golden으로
  삼는다 (바이너리 출력은 sha/size 지문). 호스트 자의 실행은 pf_report 대상이
  아니며, 스크립트 없는 단계는 ask_human으로 전환한다.
- M3.5.2-1: lockfile 원자 획득 (openSync wx, 존재확인→쓰기 금지).
  내용은 {pid, token, at}. stale은 rename 경합 승리자만 회수·재시도,
  release는 token 일치 시에만 삭제. Windows 일시 오류는 conflict로 재시도.
- M3.5.2-2: 8자식×50회 동시 보고 부하 테스트 (CI 양 OS 자동 포함).
  events seq 중복 0·revision 연속·실패는 conflict만.
  m25 20회 연속 통과, 클린 클론 36+61+163 통과.
- M5.1-A: 잠금 회수 정정. stale = pid 사망 또는 (age 초과 AND 하트비트 미갱신),
  보유 중 heartbeat, 생존 pid 절대 회수 금지. 회수는 rename 승자 + token 일치
  확인, 불일치 시 원위치 후 conflict. 회수 계측 + stderr 로그.
  m25 파일 50회 연속 통과 (전체 스위트 추가 검증은 최종 보고 전).
- M5.1-B1: finalize 고정값 감사 (params 부분 일치=core 담당과 중복 방지로
  constraint만·날짜 4종·녹화 수치 4자리+). warnings + PROCEDURE.md 절,
  strict 시 bad_request. 역치 근거: 인덱스·개수·tolerance 오탐 방지.
  정밀화 R1 numeric_match 검사값(expected/Ref/min/max) 면제,
  R2 자신의 결과물 미러 면제 (params·날짜 검사는 유지).
- M5.1-B2: numeric_match.expected에 ref 허용 ("$노드.필드" 약식,
  "${params.x}"). core는 deferred, runner에서 판정. advise 안내 문구 갱신.
- M5.1-B3: 기간 값 var 분류 문구 (PROMPT_TEXT 7항·SKILL).
  resolveVar 문자열 내 ${params.k} 치환 구현 ($노드 혼합은 미지원).
- M5.2-1: 입력 바인딩. in/inout + "${params." 포함 값만 run 시작 시
  projectRoot에서 해석해 run fs로 복사 (fixture 아님, bound가 덮어씀).
  fixed 리터럴·$노드 참조는 제외. 부재·탈출·미등록 키는 실행 전 bad_request.
  전 모드 적용 (replay 포함).
- M5.2-2: 스크립트 leaf. arg kind "script" {file, runtime python|node,
  timeoutMs} (노드당 1개). finalize가 procedures/<name>/scripts/<nodeId>.ext로
  수집·재작성 → import 시 세션 → run fs의 scripts/ (cwd는 fs).
  stdin=해석 인자 JSON, stdout={"summary","json"}=노드 출력. 타임아웃 기본 60s.
  script 항목은 resolve·rewrite·recordKey 제외. 전 모드 실행 (녹화 없음).
- M5.2-3: 값 흐름. PROMPT 8항·SKILL에 "앞 노드 출력과 같은 값은 ref" 명시.
  감사 변경: fixed가 다른 노드 녹화 출력과 일치하면 미러 여부 무관 경고
  (ref 후보). R1(검사값 면제)·R2(자기 노드 미러 면제)는 유지.
- M5.2-4: constraint. numeric expected 고정 숫자는 감사 대상에서 제외하지
  않음 (R1 축소: expectedRef/min/max만 면제). equals expected의
  ${params.k} 해결 (params 없으면 deferred, 미등록 키는 hard fail).
  R1 변경 사유: 검사값 자체가 녹화 수치와 같으면 하드코딩이므로 ref 강제.
  약식 ref: validator·resolveVar가 "$1.1.rows" 허용 (숫자 꼬리는 노드 id 귀속).
- MCP 에러 계약: 에러 결과에 structuredContent를 붙이지 않는다.
  SDK 출력 검증이 object 스키마만 지원하고 (union 불가 확인),
  엄격한 클라이언트는 에러 봉투를 성공 스키마로 검증해 실제 에러를
  -32602로 가린다. 코드는 텍스트 맨 앞에 둔다 ("code: message (힌트: ...)").
  (bc-guide 세션 finalize 실패 추적에서 발견: 실제 원인은
  1.2/1.3 missing required arg: command였으나 -32602에 가려졌음)
- 검증 규율: 로컬 vitest는 패키지 간 import를 dist로 해결한다.
  core/shared 변경 후에는 반드시 `pnpm -r build`부터 하고 테스트할 것.
  (M5.3-0-4 확정 문구가 stale dist 때문에 로컬에서만 통과하고
  클린 클론에서 실패한 사례. 확정 instruction은 경고가 있어도
  다음 도구 언급을 유지해야 한다 — 기계 추종 계약.)
- M5.3-0-4: 증거. 호스트 내장 툴(bash 등) leaf는 실행 증거가 없다 —
  attempt에 남는 건 호스트 주장(resultSummary)과 인자뿐. confirm은
  artifacts 비어 있으면 경고 (거부 아님). 한계: core attempt는 resultJson을
  저장하지 않아 (실측 확인) 결과 JSON을 증거·미러로 쓸 수 없다.
  R2 미러 면제는 attempts resultJson이 있을 때만 동작 (단위 계약).
  auto constraint 강제는 경로가 있어야 가능하므로 미적용 (경고로 대체).
- M5.2-5: 수락 테스트. CI E2E m52-monthly.test.ts (절차서 monthly):
  1.1 script 집계 + period==${params.month}, 1.2 script 렌더 +
  total==$1.1.total. a 9월 분해 strict 0, b 10월 실행·독립 계산 일치,
  c 11월 부재 bad_request, d 데이터 교체 period fail+blocked.
  CI에 setup-python + openpyxl (+ M5.3-2부터 python-pptx).
- M5.3-1: 파일 내용 감사. script-kind 스크립트 + 고정(in/inout) 템플릿 파일
- M5.3.1-1: file_exists 논리 경로. export 시 auto file_exists의
- M5.5-3: 실행 간 state. procedures/<name>/state.json, 성공 종료 시에만 원자 저장
  (실패·중단 불변). 노드 stateWrites[{key,from}] (edit_node 설정).
  참조 ${state.k} (var 전용, resolve/checker/validator 지원).
  첫 실행 state 부재 → params.stateDefaults(JSON) 또는 bad_request.
  절대경로 var는 입력 바인딩 제외 (rewritePaths가 처리).
- M5.5-4.1-0: M5.5-3(612030a)은 CI failure(run 38126010591, ubuntu/inprocess가
  pnpm -r run test에서 실패, 나머지는 fail-fast 취소) 상태에서 완료 처리됨.
  원인은 로컬에서 신규 파일(m55-state)만 실행하고 CI를 확인하지 않은 것.
  CI는 전체 스위트를 돌리므로 m55-until이 실행되어 확정적 실패했음
  (M5.5-3의 resolveArgs 호출에서 selfCarry 누락 → $self 미전달 → 미수렴.
  9e1d0b3에서 수정). "CI에서 안 돌았다"가 아니므로 파일 수 검사는 추가하지 않음.
  교정: 항목 완료 선언 전 API로 head_sha 일치 run의 conclusion=success 확인 필수
  (gh 없음 → api.github.com repos/.../actions/runs?head_sha=...).
  중간 커밋은 run이 생기지 않음(푸시 head만 실행). M5.5-4(a75a3c5)는
  run 38127197074 success로 M5.5-3 회귀까지 해소됨.
- M5.5-4.2-3: 런타임 node hash는 procedure.json 파일 내용에서 재계산
  (importProcedure가 computeNodeHash(goal·args·constraints·dependsOn []) 호출,
  세션 노드 파일의 hash와 일치 확인). 텍스트 1글자 수정(args "hi"→"ho")만으로
  stale → fail ["approval"] + "승인 갱신 필요" (exit 3). dependsOn은 항상 []이므로
  순서 변경은 해시에 영향 없음. map/until 템플릿 변경도 현 공식에는 미반영
  (부모 pin 승인 시 템플릿은 args 패턴으로만 통제).
- M5.6 하네스 과제 (c·d·j, repo 대상 아님):
  - c: 채팅 백엔드의 evaluator가 defaultEvaluate (제약 있으면 전부 fail).
    repo core는 실제 checker를 주입하므로 하네스 한정. "미판정" 구분 필요.
  - d: 채팅 도구 경계가 map/until/stateWrites·sideEffect·params 선언·script 배치를
    전달하지 않음 (repo DTO는 모두 지원, 병렬 세션 §5에서 귀속 검증).
    seedFiles는 시작 시에만 있고 중반 추가 수단 없음.
  - j: 토큰 사용량이 모델에게 비가시. pf 호출 수가 유일한 대리 지표.
    계측 노출은 하네스 과제.
- M5.6.1-3 readOnly 신뢰 한계: 재시도는 카탈로그 readOnlyHint + 노드 sideEffect none을
  신뢰한다. 카탈로그는 세션(작성자) 제공이라 쓰기 도구를 readOnly로 속이면 중복
  실행될 수 있다. 완화: local_write·external은 힌트와 무관하게 재시도 제외,
  external은 approvals 정확 일치까지 요구. 잔여 신뢰(카탈로그 정직성)는 도구 구현과
  동일 선상 (별도 검증 없음).
- M5.7-2 fail-on-unverified 기본 on (무인 실행): 사람 검토 없는 누적은
  조용히 통과보다 크게 실패가 낫다. on이면 unverified>0 → exit 1 + state 미저장.
  `--allow-unverified`로 해제 (RunOptions로는 failOnUnverified:false).
  대화형(MCP·세션 실행)은 기존 동작 유지.
- [M5.7.1-1] `--fail-on-unverified` 제거 예정 — `--allow-unverified`로 단일화
  (기본 fail-on on 유지). 구 옵션은 1개 버전 동안 경고 후 무시한다.
  이유: 두 플래그가 같은 스위치를 정반대 극성으로 제어해 조합 의미가 모호했음
  (`--fail-on-unverified=false`와 `--allow-unverified` 중복).
  영향: RunOptions/ProcedureRunOptions `failOnUnverified` → `allowUnverified`로
  개명 (반전 의미, 기본 false). `--no-` 형식은 Node parseArgs 미지원이므로 도입하지 않음.
- M5.6.1-4 세그먼트 중간 리터럴: 자르지 않고 마지막 세그먼트 문자열 접두로 비교
  (URL·경로 공통, 나머지 세그먼트는 정확 일치). "https://h/x/item-" 패턴은
  "https://h/x/item-123"에 통과, "https://h/y/..."·"https://h/x/other"에 거부.
  마지막 "/"까지 자르는 안은 과승인이라 기각. ${} 2개 이상은 앞부분 과승인
  위험을 approve 출력 경고로 알림.
- [M5.8.1-1] bash leaf 기본 거부·절차서 단위 opt-in: runner 실행 가능 집합은
  LocalServices.runnableTools가 계산 (catalog의 MCP 도구 + 활성화 builtin.
  bash는 confirm 입력 allowBash 선언 시만 포함). App은 집합을 core confirmLeaf
  입력에 넘기고 판정은 core가 한다 (R1~R4). 명령 문자열을 path in/out/inout으로
  확정하면 core가 거부 (kind:"script" 사용). bash leaf 포함 절차서는 finalize가
  run --allow-bash 필요를 경고.
- [M5.8.1-2] 실행 불가 vs 녹화본 없음 구분: runner가 도구를 실행할 수 없는 경우
  (미지원 내장·allowBash 없는 bash)는 fixture 게이트보다 먼저 "실행 불가"로
  실패. record/live 모드의 fixture 에러에서는 "record로 재녹화" 힌트를 내지
  않는다 (replay/passthrough는 유지).
- [M5.8.1-5] CI 수정: export 정리 실패가 본 에러 마스킹. `rmSync(force)`는
  ENOENT만 삼키고 ENOTDIR(파일 밑 통과, Linux)은 그대로 던져서, catch 안의
  정리가 원본 에러를 덮고 raw가 전파됐다 (Windows는 ENOENT라 통과, ubuntu만
  실패). 정리 rmSync는 전부 best-effort로. E2E 잔재(.tmp-*)와도 일치.
- [M5.8.1-4] dependsOn 사후 편집: pf_split에서 형제 2개 이상인데 전부 의존이
  비어 있으면 경고 + instruction에 연결 문구. pf_edit_node에 dependsOn 추가
  (CoreClient 경유, 기존 노드만·자기참조/순환 거부, 해시 재계산·stale 전파·
  revision 증가는 공용 경로).
- [M5.8.1-3] finalize export 무명 예외 제거: E2E에서 artifact 없는 leaf 트리로
  finalize 4회 internal (완성 .tmp-* 잔재, 교체 안 됨. 유령 재시도 1회 포함).
  원인 확정: 보고 경로(ingestReportJobs→appendManifest)가 manifest를 무조건 만들고,
  fixtures/가 없으면 copyTree가 tests/를 안 만든 채 manifest 복사 → ENOENT.
  #5는 fixtures 복사가 tests/를 먼저 만들어 우연히 성공. core 직결 보고는
  manifest가 안 생겨서 기존 테스트가 가렸음. 수정: 복사 전 tests/ 생성.
  fs 실패 코드는 io_error로 분리 (입력 수정 불가, 재시도·디스크/권한 확인).
  artifact 없음 자체는 거부 사유가 아니다 (M5.3-0-4 유지).
- [M5.8.2-3] script 승인 기본 요구 (opt-out 없음): 스크립트는 임의 코드 실행이라
  무인 live에서 script 노드도 approvals 항목(node id/hash + script sha256)이
  필요. procforge approve가 script 노드를 지원 (sideEffect 무관, 내용은 해시로
  커버). 스크립트 1글자 수정 → stale → exit 3. 대화형 live·record/replay는
  기존 동작 유지.
- [M5.8.2-1] ref 의미 확정: `$N` = 출력 전체, `$N.<field>` = 그 필드만.
  종전 bare `$N.output`(= 전체) 특수 처리를 없애고 output도 일반 필드로 취급
  (`$N.output.x` 접두 형태는 유지). 출력에 output 필드가 있으면 예전 의미와
  달라지므로, 전체가 필요하면 `$N`을 쓰라. E2E에서 `$1.1.output`이 필드가
  아니라 전체를 돌려줘 스크립트가 터진 것이 계기.
- [M5.8.2-2] probing/run 차이 차단: pf_next가 ref 해석 인자(resolvedInputs)를
  내려주고, 보고 인자는 attempt에 기록된다. confirm에서 argSpecs var를 상류
  resultJson(저장 신설)으로 해석해 통과 attempt 인자와 다르면 거부.
  finalize는 상류 resultJson으로 var ref 필드 존재 검증 (bad_ref_field).
  map/until 템플릿 probing과 map/until 대상 참조는 면제/제외 (런타임 출력이
  누적 수집이라 정적 해석과 다름).
- [M7-1] UI→모델 연결 모드 순서: B>A>C (M7-0 ③④ 실측 근거).
  B(session/:id/message, 기본): 처음부터 끝까지 동작 확인.
  A(TUI append+submit): attach된 TUI 있을 때만, 화면 반영 미확인.
  C: 상시 폴백 ("계속" 문구+복사 버튼).
- [M7-1] plan 모드 무실행 위험: plan 모드 세션은 텍스트만 내고 도구를
  실행하지 않는다 (M7-0에서 목격. 겉으로 성공처럼 보임).
  B 전송 시 agent=build 지정, 지정 불가 버전이면 경고+C.
  신호 후 60초 안에 해당 세션 pf_* 호출 0건이면 degraded
  ("모델 무응답/plan 모드 의심")+C 문구. 가짜 서버 E2E에 plan 모드
  (텍스트만 응답) 케이스 추가.
- [M7-1] 짝짓기 재연결(latest-wins): OpenCode 세션 1개 ↔ ProcForge 세션 1개를
  다시 짝지을 때의 규칙. 새 세션 첫 pf_* 호출의 ProcForge sessionId로
  pairings.json 갱신, 이력 보존.
- [M7-1] 병행 세션은 저장소 위치 문제다: 같은 작업인데 TUI 쪽은 repo 저장소,
  webui 쪽은 workspace 저장소에 따로 기록됐다 (207a8f93 rev 5 open vs
  5762fb44 leaf 진행). MCP 서버가 실행 위치(cwd) 기준으로 `.procforge/`를
  찾기 때문으로 보임. UI는 한쪽 저장소만 보면 다른 쪽 세션이 화면에서 사라진다.
- [M7-1-저장소] 저장소 경로를 `opencode.json`의 MCP env(`PROCFORGE_DIR`)로
  명시하고, 기본값 규칙을 하나로 정한다. 서버 시작 로그·`pf_start` 응답에
  실제 저장소 경로를 넣는다. 같은 프로젝트에서 저장소 2개가 감지되면 경고한다.
- [M7-1] calls.jsonl 귀속: 세션 단위가 아니라 호출마다 다음 두 가지를 남긴다.
  연결 id (MCP 연결마다 `randomUUID`로 부여) + 그 연결의 clientInfo.
  스크립트가 MCP로 호출하면 그 호출도 `opencode 1.18.18`로 찍힐 수 있어서
  세션 단위로는 부족하다. UI는 MCP를 거치지 않고 App을 직접 부르니
  actor:"ui"로 표시한다. 한 세션에 connectionId 2개 이상이면 pf_tree/UI에 표시.
  (M7-0 ④에서 확인. conflict→재시도는 스크립트, bad_request→수정은 모델).
   TUI 기본 내장 서버 포트 4096 확인 (SDK server 기본값).
- [M7-1-신호] B는 `POST /session/:id/message` + `{parts}`
  (M7-1.1 실서버 1.18.18 확인: 200. `{"prompt":{...}}` 래퍼는 이 경로에서
  400 — 래퍼는 `/api/session/:id/prompt`용. M7-0 §B에 측정 기록).
- [M7-1.1-1] plan 감지는 신호 전 기준점 이후의 새 pf_*만 센다.
  짝 세션의 기존 pf_start 때문에 항상 통과하던 문제를 막는다.
- [M7-1.1-2] 버전 default-deny. serverVersion 없으면 미확인→무전송+C.
  호출자가 연결의 clientInfo 버전을 넣는다 (읽지 못하면 넣지 마라).
- [M7-1.1-3] 신호 전 짝 검증. pairings의 pfSessionId ≠ 조언 세션이면
  무전송+C ("다른 세션과 짝"). 짝이 없으면 허용 (첫 신호가 짝을 만든다).
  재연결은 OpenCode 세션의 새 pf_start가 먼저 관찰돼 짝이 갱신된 뒤 허용.
- [M7-1.1-5] R5: adviseAndSignal 입력은 JSON만. fetch 주입은 App 생성자.
- [M7-1.1-6] 감지는 SSE message.part.updated 우선, messages 폴링은 폴백
  (대용량 세션 빈 페이지 오탐 회피. M7-0 §3).
- [M7-ui1-1] UI 서버는 어댑터: App.listSessions만 호출, 판단 없음.
  127.0.0.1 전용 바인딩·실행마다 무작위 토큰(헤더, fragment로 전달)·
  Host/Origin 검사. 토큰 없음 401·Host/Origin 불일치 403.
  `/`는 데이터 없는 정적 골격만 토큰 없이 서빙.
- [M7-ui1-2] 짝 표시는 pairings 역조회(openCode→pf가 아니라 pf→openCode 목록).
  connectionIds는 calls.jsonl distinct (2개 이상이면 UI가 경고 배지).
- [M7-ui1-3] `--open` 브라우저 실행은 App 모듈(openUrl)에 둔다
  (check-deps: cli.ts는 node 내장 import 금지).
- [M7-ui1-4] 화면 경로는 하나: packages/ui 빌드 산출물만. 인라인 골격은
  제거했고 빌드가 없으면 "pnpm -r build 필요" 안내만 낸다(중복 경로 방지).
- [M7-ui1-5] 토큰은 메모리에만 두고 읽자마자 fragment를 지운다. 따라서
  새로고침하면 401이 난다 — **의도된 동작**이다. 401 화면은
  "터미널에 출력된 URL로 다시 열기"를 안내한다.
- [M7-ui2-1] SSE 클라는 EventSource를 쓰지 않는다 (토큰 헤더를 붙일 수
  없다). fetch ReadableStream으로 SSE를 직접 파싱한다. 쿼리스트링
  토큰은 금지(로그·기록 잔류). 서버는 헤더를 먼저 flush하고,
  `req`가 아니라 `res`의 close로 구독을 정리한다.
- [M7-ui2-2] 이벤트는 core에서만 읽는다 (`getEventsPage`). UI 서버가
  events.jsonl을 tail하면 원격 core 모드에서 아무 이벤트도 오지 않는다.
  세션당 폴러 1개를 구독자들에 공유하고, 구독자 0이면 정지.
- [M7-ui2-3] blocked·needs_human은 읽기 전용 `getBlocked`로 따로 받는다
  (`pfNext`는 쓰기 메서드 — 화면을 보기만 해도 상태가 바뀌면 안 된다).
- [M7-ui2-4] stale은 상태가 아니라 `staleSince:{revision,causeNodeId}`
  로 core가 기록하고 UI는 표시만 한다 (R3: UI가 추측 금지).
  `pfReport`(pass/fail)로 재실행되면 해제된다.
- [M7-ui2-5] **split에는 stale 표시를 미기록**한다 (택1). 실제 작업 단위는
  leaf이고, split까지 표시가 켜지면 신호 노이즈가 된다. 전파 중 split은
  해시만 갱신하고 기존 표시도 함께 지운다.
- [M7-ui2-6] `staleSince.revision`은 **커밋되는 revision**(그 변경 이벤트
  revision과 동일)이다. 표시가 생긴 시점의 세션 revision이 아니라 이벤트
  revision이라 "어느 변경 때문인가"가 UI에서 대조된다.
- [M7-ui2-7] 읽기 전용 경로(getNode·getEventsPage·getBlocked·getSessions)는
  **touch하지 않는다**. 화면을 보기만 해도 세션 파일이 바뀌면 안 된다
  (폴링이 TTL을 무한 연장하는 것도 방지). 만료 판정은 같은 규칙이고,
  TTL은 쓰기 경로 기준이다.
- [M7-ui2-8] SSE 폴러 오류: `session_not_found`/`not_found`는 영구 오류로
  보고 `event: error`를 쏜 뒤 구독·폴러를 종료한다. 그 외는 다음 주기에
  재시도한다 (일시 오류 가정).
- [M7-ui2-9] `Last-Event-ID`가 없으면 시작점은 **현재 revision**이다 —
  화면을 처음 열었을 때 과거 이력을 전부 재전송하지 않는다.
- [M7-ui3-1] 산출물은 `sessions/<sid>/fixtures/...`에 저장된다. 미리보기·전문
  모두 이 디렉터리 밖은 거부하고, 전문은 5MB 상한 + `text/plain` +
  `nosniff` + `attachment`로만 내려준다(HTML·JSON 모두 텍스트, iframe 렌더
  없음). 미리보기는 UI가 `<pre>` + textContent.
- [M7-ui3-2] 노드 이력은 `getEventsPage({nodeId})`의 **서버측 필터**를 쓴다
  (UI가 전체를 받아 거르지 않는다).
  짝짓기 읽기는 최신 pf_start 기준 (latest-wins) — messages 뒤쪽이 이긴다.
  advise 실패 시 신호 미전송 (App.adviseAndSignal이 순서 보장).
  pairings UI 배선은 M7-2로 미룸 (App·pairings.json까지만).
 - [M7-ui3-3] 산출물 URL은 `.../artifacts/<attemptId>/<index>`다. 경로를
   클라이언트가 만들지 않는다 — core가 `attempt.artifacts[index]`로 상대경로만
   골라내고, realpath로 fixtures 루트를 벗어나면 거부한다. 원격 모드에서 파일이
   없으면 404(`not_found`)로 500을 흘리지 않는다.
 - [M7-ui3-4] 노드 이력은 최신 200건. 상수는 UI 서버가 아니라 `App`이 정한다
   (`NODE_HISTORY_MAX`) — UI 서버는 App 메서드만 호출한다.
 - [M7-ui4-1] 편집 미리보기는 `previewEdit({sessionId,nodeId,change})` **읽기
   전용**이다. 같은 검증·hash 규칙으로 `wouldStale`(노드 id 배열)과 `newHash`만
   돌려주고 core·저장소는 건드리지 않는다. 잠긴 노드는 거절한다.
 - [M7-ui4-2] UI 쓰기는 POST + `application/json`만 허용하고(그 외 415),
   `expectedRevision`를 **모두 필수**로 받는다(누락 400, 불일치 409).
   자동 재시도는 없고, 409는 UI가 초안 그대로를 붙들고 최신 다시 읽기를
   제안한다.
 - [M7-ui4-3] UI 경로 쓰기는 App이 `actor:"ui"` + connectionId를 강제로 찍는다.
   클라이언트가 actor를 보내도 무시된다.
 - [M7-ui4-4] 의견 저장은 **1회만** 한다. 저장이 먼저 끝나고 그다음 신호를
   시도하므로, 신호 실패·degraded여도 저장분·revision·의견은 그대로다.
   (advise를 두 번 부르면 두 번째가 같은 `expectedRevision`으로 conflict 난다.)
 - [M7-ui3-5] 읽기는 TTL을 연장하지 않는다. 이건 예전에는 반대로 동작했는데
   만료 판정 기준이 `lastUsed` 메모리 맵에 있어, HTTP로 요청마다 store가 새로
   만들어지는 원격 모드에서는 **만료가 아예 일어나지 않았다**. 기준이 없으면
   `createdAt`로 간주하고, 연장은 **쓰기만** 하도록 바꿨다.
 - [M7-ui4-a] TTL 기준은 **디스크**다. 쓰기 커밋이 `session.json`에
   `lastWriteAt`를 남기고 판정은 `lastWriteAt ?? createdAt`. 메모리 lastUsed는
   제거했다 — 프로세스 재시작 후에도, 원격 core(요청마다 store 재생성)에서도
   같은 결과여야 한다.
 - [M7-ui4-b] 신호 대상(baseUrl·mode·openCodeSessionId)은 **서버 설정에서만**
   온다. UI POST 본문에 `link`/`baseUrl`/`mode`가 오면 400이고, MCP 경로도
   서버 설정과 다르면 400이다. 조용히 무시하면 클라이언트가 다른 주소로 갈 수
   있어 버그를 숨긴다. 미지정 시 `PROCFORGE_OPENCODE_URL`/`_MODE`.
 - [M7-ui4-c] `signalOnly`를 advise와 분리했다. advise는 **한 번만** 하고
   그다음 신호를 시도한다(두 번 부르면 두 번째가 같은 expectedRevision으로
   conflict 난다). 짝 없음 처리는 M7-0.2 그대로 — 짝이 없으면 허용, 다른 세션과
   짝이면 degraded. 신호 실패·degraded여도 저장분은 그대로다.
 - [M7-ui4-d] UI 호출 기록은 core 호출 **뒤** 실제 결과(ok/오류코드)로 남긴다.
   실패한 쓰기가 성공처럼 기록되면 추적이 거짓말을 한다.
 - [M7-ui4-e] 쓰기 본문: media type을 정확히 비교(`application/json`만,
   매개변수는 허용), 단일 루프 + 바이트 상한, JSON 실패·비객체는 400.
 - [M7-ui4-f] 편집은 순수 함수 `applyEdit`(packages/core/src/edit.ts) 하나다.
   `previewEdit`와 `pfEditNode`가 공유하므로 "미리보기 N개 stale"과 "저장 후 N개
   stale"이 어긋날 수 없다. 중복 constraint는 조용히 버리지 않고 거절한다
   (미리보기가 "적용됨"이라 말한 뒤 저장이 무시하면 안 된다). goal 규칙의 단일
   소스도 core이며 wire/loopback 스키마는 다시 정의하지 않는다.
 - [M7-ui4-g] 노드 이력은 **최신** 200건(`tail: true`)이다. 오래된 것부터
   자르면 이벤트 250건 세션에서 마지막 사건이 화면에서 사라진다. SSE 증분은
   기본(head) 동작을 유지한다.
 - [M7-ui4-h] `lastWriteAt`는 **core가 커밋 세션에** 심는다 (FileStore가 아니다).
   저장소가 찍으면 메모리 store와 판정이 갈리고 시각 주입이 안 된다. 시각은
   `now` 옵션으로 주입해 가짜 시계로 판정한다. 미사용 `touchSession` 제거.
 - [M7-ui4-i] `serverVersion`은 서버 설정 또는 OpenCode 서버 조회값만
   (클라이언트가 지정하면 400). timeout은 120s 상한.
 - [M7-ui4-j] 짝이 없고 openCodeSessionId도 없으면 **전송하지 않는다**(C 문구).
   어디로 보낼지 모르는 신호는 아무것도 바꾸지 않는 쪽이 낫다. 문구 우선순위는
   미설정 주소 → 짝 없음 → 다른 세션과 짝 → 전송 실패 순으로 통일.
 - [M7-ui4-k] 본문은 content-length 로 **사전**에 413, 스트리밍 중 초과면 끝까지
   소비한 뒤 413 + `Connection: close`로 답한다. (`for await` 로 일찍 빠져나가면
   스트림이 destroy 되어 클라이언트가 리셋을 받는다.)
 - [M7-5-1] `uiRun`은 **즉시** `{runId}`를 돌려주고 진행은 백그라운드다. 등록된
   절차서·선언된 param만 받고 경로/명령/out 주입은 400, 절차서당 동시 1개(409).
   실행 기록은 `.procforge/runs/<runId>` 이고 **세션 TTL과 무관**하다.
 - [M7-5-1] 취소는 플래그 + 등록된 자식 pid의 **프로세스 트리** 종료
   (Windows `taskkill /T /F`). 트리만 죽이므로 고아 프로세스가 남지 않는다.
 - [M7-5-2] 승인은 화면에서 보고 **core가 판정**한다. `approvalHash`가 지금 값과
   다르면 409, 없으면 400 — 조용히 승인하지 않는다. 화면의 "승인됨"은 approvalHash
   일치만 본다(승인 직후 node.hash는 바뀌므로).
 - [M7-5-3] CSP nonce는 **요청마다** 새로 발급하고 `style-src 'nonce-…'` 로만 쓴다.
   `unsafe-inline` 은 넣지 않는다(넣으면 nonce가 무의미해진다).
 - [M7-5-1] UI 서버 종료 시 실행 중 run은 **끝까지 두고 UI만 닫는다** — 실행은
   `.procforge/runs/<runId>` 에 기록되고 서버와 독립이므로, 재접속하면 결과가
   그대로 보인다(실행 중 취소는 사용자가 명시적으로 해야 한다).
- [M6.1-신뢰경계] 판정은 local이 하고 core는 그 판정을 믿는다.
  원본을 보내지 않으니 당연한 결과. 다만 클라이언트가 판정을 조작할 수
  있다는 뜻이기도 하니, 판정 신뢰 경계 = 테넌트 자신 으로 명시한다.
  모방 방지 자산은 검사 로직이 아니라 분해 정책·패턴 라이브러리 쪽에 쌓고,
  저장소를 공개로 유지하기로 했으니 그 로직은 공개 저장소에 넣지 않는다.
- [M6.1-keepalive] 서버 keep-alive 120s는 테스트·loopback용이다.
  공개 서버에서는 놀고 있는 연결이 오래 남으니, 클라이언트 유지 시간을
  서버보다 짧게 (예: 서버 5s·클라 4s) 두는 게 정석. 공개 서버 도입 시 되돌린다.
- [M6.1-재시도범위] 쓰기 재시도 범위는 지금이 맞다. 서버가 요청을 받지도
  못한 실패(ECONNREFUSED 등)만 재시도하고, 이미 반영된 경우는
  expectedRevision 충돌로 걸러진다. 나중에 요청 id(멱등 키)를 붙이면 더 확실해진다.
- [M6.1-5] 저장소 공개: 공개 유지 (사용자 결정, 2026-10-14).
  비밀 URL·키는 `$prefix`·환경 분리, 토큰 하드코딩 금지 유지.
- [M6.1-3] 테스트 재시도 제거: withNetRetry·fetchRetry·healthz 대기·
  perf 성공시도 기록을 없애고 포트 0 + 할당 포트만 사용.
  product connect-phase 재시도(EACCES·ECONNREFUSED, 서버가 못 봄)는 유지
  (정확히 1회 의미 보존).
  실험 결과 listen EACCES 재현 (m55-map·state·external·m582 등 파일 전체
  실패. 원인: Windows 병렬 bind 경합. connect 측이 아니라 listen 측).
  대응: startServer listen 재시도만 복원 (bind 멱등·안전, 어서션과 무관).
  어서션 재시도는 제거 유지. [!] 지정 없음 (전면 실패라 해당 테스트만
  지정하는 방식이 안 맞음).
  후속 특정: SO_EXCLUSIVEADDRUSE + TIME_WAIT 충돌이 유력
  (ephemeral 재사용 시 EACCES가 EADDRINUSE 대신. 순차 300·병렬 120
  bind는 재현 안 됨, 전체 스위트에서만 재현). exclusive:false로 허용.
- [M6.1-4] 인증 강화: 키는 sha256 해시만 보관, 비교는 timingSafeEqual.
  default 테넌트(bare 키 포함)는 PROCFORGE_DEV_AUTH=1에서만 허용,
  없으면 401. TenantKeys는 Map에서 배열로 변경 (cli size→length).
- [M6.1-2] 전체 스위트 remote 이식: PROCFORGE_CLIENT=remote면 testStack이
  파일당 서버 1대 지연 기동 + 서버 저장소를 메타 단언에 사용.
  runSession은 core 주입 시 하이드레이트 후 실행 (runTestSession 별칭),
  record도 허용 (golden은 pfWriteGolden 반영). importProcedure는
  wire pfImportProcedure + 로컬 파일 복사 병행. app.runStart도 core 경로.
  송신 수집 + 파일 끝 egress 위반 0건 단언 (setup-remote afterAll).
  CI remote 잡이 전체 스위트를 돈다. loopback 순간 실패 원인 확정:
  burst connect EACCES (200병렬 중 116) + stale keep-alive.
  대응: 쓰기는 연결 단계 실패(EACCES·ECONNREFUSED, 서버가 못 봄)만 재시도,
  그 외는 정확히 1회 (prod 의미 유지). 서버 keepAlive 120s.
  finalize getNode 팬아웃 제거 (pfTree가 전체 노드. 왕복 절감+burst 제거).
  CLI 서브프로세스 테스트는 spawnCli (spawnSync는 워커 루프를 막아
  인프로세스 서버가 얼어붙는다). remote 병렬 4 (vitest.config).
  runProcedureTest 흐름은 local-local이라 그대로 (서버 미사용).
- [M6.1-1] egress R8 일치: pfReport 원문 resultJson 원격 전송 금지
  (메타+판정만. 직접 전송은 egress 차단). 평가는 LocalServices
  (checkerEvaluate), core는 저장·규칙 적용 (refCheck 패턴).
  resultJsonMetaOf·autoConstraints·decideReportVerdict를 shared/report.ts로
  옮겨 core·local이 같은 함수 사용 (parity).
  resultSummary·rubricReasons 값은 4KB 상한+교정, 예외 없음.
  params·args는 정의라 원문 유지+교정만.
  남는 예외 목록: (a) params/args/argSpecs 안의 절대경로 (정의 입력.
  argSpecs fixed가 args와 같은 문자열이라 차단하면 일관성 붕괴 + 스위트
  필수 흐름 (m3 절대경로 replay·xpath //title). 경로 안 사용자명 노출은
  감수, 토큰은 교정), (b) PROSE_KEYS 산문 안의 절대경로,
  (c) 메타 형태 {sha256,size,preview}, (d) URL 문자열.
  미리보기(≤4KB) 안의 원문 조각은 R8 설계상 허용.
  params/args 안의 resultJson 키도 차단 (예외 없음).
  제약 spec.path·artifacts명의 절대경로는 계속 차단.
- [M6-0] 저장소 공개: 공개 유지 (사용자 지시). [!] 아님. 공개 운영 선택지
  (사용자 결정 대기): (a) `.procforge/`는 gitignore라 세션·run 기록은 커밋 안
  됨 — 현 상태 유지가 기본. (b) `procedures/` 승인·스크립트는 커밋됨 —
  비밀 URL·키는 `$prefix`·환경 분리, 토큰 하드코딩 금지 (강제 검사 여부 미결정).
  (c) 이슈·PR에 비밀 첨부 금지 문구 (템플릿 여부 미결정).
- [M6-0] @날짜 param: `@today:utc`·`@today:local`·`@yesterday:utc` 3종.
  live 시작 시 1회 해석, 해석값이 run 기록(params)에 남는다. replay 등에서는
  해석하지 않는다 (golden drift 방지).
- [M5.8.2-4] csv_rows(path, op, value|ref): CSV 데이터 행 수 검사. resultJson
  없이 판정 (행 세기만, 셀 파싱 없음). 헤더 1행 제외가 기본 (pptx skipHeader와
  동일). expected/ref 해결은 numeric_match와 같은 함수 재사용. core에는 fs가
  없어 deferred. 결정적 단언 집합에 포함.
- [M5.8.2 후속] 상류 출력 기준: golden attempt resultJson, 없으면 마지막 pass
  attempt. fail 본은 사용 금지 (재시도로 마지막이 fail이어도 golden 기준 판정).
  ref 해석 불가는 경고 "검증 불가: <node>.<key>", confirm strict면 거부.
  finalize의 없는 필드는 bad_ref_field (App 사전검사. core에는 실데이터 없음).
- [M5.8.2 후속 R8] resultJson 분리: 실데이터는 로컬 attempt 파일
  (sessions/<sid>/resultJson/<attemptId>.json), core attempt에는
  {sha256, size, 4KB 미리보기} 메타만. 기존 inline은 로드 시 1회 분리
  마이그레이션. 대조 계산은 LocalServices, 판정 규칙은 core.
  attempt = 메타のみ (preview ≤4KB cap).
- [M5.8.2 후속] 비교는 stable 직렬화 (키 순서 무관). 삽입 순서에 따라
  달라지는 JSON.stringify 동등 비교 금지.
- [M6-1] wire 계약: CoreClient 17 메서드 1:1 `POST /v1/<method>` (JSON object
  body. positional 인자도 명명 객체로). 요청·응답 모두 shared zod로 양쪽 검증
  (공유 스키마 재사용 + 필수 키. 깊은 페이로드는 shared 그대로).
  `x-procforge-version` 헤더, 불일치면 conflict + 업그레이드 힌트.
  에러는 기존 코드 체계 그대로, internal은 고정 메시지만 (스택 비노출).
- [M6-2] FileStore shared 이동: local/src/{logger,fsutil,filestore}.ts를
  shared로 이동 (core-server 재사용 + core-server→local import 금지 대응).
  기존 import 경로는 re-export shim으로 유지 (adapter 검사·테스트 경로 보존).
  checker는 fs 2종만 local 래퍼에 두고 나머지는 shared로 (core-server는
  shared 판정기 + deferred 사용, 중복 구현 없음).
- [M6-2] core-server: Node http, CoreClient 1:1 `POST /v1/<m>` (+GET /healthz).
  테넌트별 FileStore(dataDir/tenants/<tid>), Bearer API 키(`tid:key`, bare는
  default), 키 없으면 401(unauthorized 신규 코드), 버전 불일치 409, 입력 검증
  실패 400, 출력 불일치는 500 sanitized. 타 테넌트 sessionId →
  session_not_found (격리는 디렉터리 분리로 구조 보장). 평가는 shared 판정기.
- [M6-3] RemoteCoreClient: `PROCFORGE_CORE_URL` 있으면 remote, 기본 inprocess
  (core-inprocess 분기. 로컬 FileStore는 그대로). 읽
  기(getSession/getNode/pfTree/getEvents/pfBuildProcedure)만 재시도
  (fetch 실패·타임아웃·502/503/504, 3회). 쓰기는 재시도 금지
  (expectedRevision 충돌 판단은 호출자가). 네트워크 실패 → io_error degraded.
  로컬 파일 쓰기를 하지 않으므로 로컬 상태 불변. 송신 탭(onSend) 내장.
- [M6-4] egress guard: core행 요청을 RemoteCoreClient 송신 한 곳에서 검사.
  구조 위반은 차단 bad_request (pfReport 바깥 resultJson 실데이터, 확정·제약
  경로(argSpecs·spec.path·artifacts)의 절대경로. params/args/resultJson/
  resultSummary는 실행·평가·바인딩 입력이라 원문 유지).
  민감값은 교정 후 전송 (토큰 패턴 전역. 이메일은 위 입력 제외).
  메타 형태는 파생 요약이라 면제.
- [M6-5] CI remote 모드: 별도 job (ubuntu·windows). core-server 테스트 +
  remote 전용 테스트 3종 (remote-client·m6-egress·m6-remote-run, 서버 자체
  기동). 전체 스위트 remote 이식은 M6.1 (import API·golden 쓰기 API·테스트
  이식 필요). check-deps에 core-server→local import 금지 추가.
- [M6-6] p95 (로컬 loopback remote, 2026-10-14): getSession 30.4ms,
  pfTree 8.7ms, getNode 7.5ms, pfNext 27.9ms (첫 호출 워밍업 포함).
  목표: p95 < 1000ms (여유 30배. CI 변동 감안, 초과 시 조사).
- M5.5-5: dogfood daily-crawl (fake board 날짜별 3페이지 + detail x3 실패).
  until 수집 → script 평탄화 → map 상세(external·threshold 0.5) → script 누적.
  run1(d1) x1,x2·run2(d2) x4 신규만, state seenIds 누적. (a) stale hash → fail
  ["approval"] + exit 3, (b) 겹친 실행 → conflict + exit 4.
- M5.5-4: 무인 실행. --unattended에서 external은 approvals.json 일치 시만 실행,
  불일치 시 suspended 대신 fail ["approval"] (exit 3). map 거부 항목은 map 실패에
  ["approval"] 전파, until은 그대로 전파. 매칭은 해석된 인자 기준, "*" 와일드카드.
  exit: 0 성공 / 1 실패·중단 / 2 입력 오류(bad_request) / 3 승인 필요.
  스케줄러 내장 금지, docs/scheduling.md 예시만.
- M5.5-2: until 노드. Node kind:"until" + until{until, maxIterations, carry?,
  template{tool,args,constraints}} (인라인, 자식 금지).
  $self = 이전 반복 출력의 carry 경로 값 (없으면 undefined=첫 페이지 관례).
  인자에서는 bare $self만. until 충족=중단·성공, maxIterations 도달=fail.
  반복 출력 배열 + count 집계. generated는 until 단위 supply.
- M5.5-1: map 노드. Node kind:"map" + map{over,as,maxItems,policy,template}
  (템플릿 인라인, 트리 자식 금지). ${as} 참조는 map 범위에서만 허용.
  실행은 템플릿을 항목별 ephemeral 노드로 기존 execNode 재사용
  (record/replay/script/external 그대로). 출력 배열, 정책 all|any|threshold,
  failedItems 보고. count path 생략 시 결과 전체.
  generated in map은 live-supply만 (map id 키), replay/record 미지원.
  edit_node map 설정 + split 금지 + dep over 인정 + hash 포함.
- M5.5-0: pptx_table_sum checker. 산출 pptx 표 셀을 직접 합산 (보고값이
  아닌 그려진 값). expected는 numeric과 같은 ref 규칙 ($노드·${params}).
  fsDir 없으면 deferred. numeric expected 해결을 resolveNumericExpected로
  공용화. python-pptx 1.0.2 XML은 태그에 속성이 붙으므로 정규식에 속성 허용.
  monthly c-sum을 이것으로 교체 (거짓 표 검출).
- M5.3.1-2: auto 감사 구멍 봉합. fixtures/ 형태 file_exists는 시스템 경로라
  건너뛰므로, manifest source 문자열을 finalize에서 직접 감사 (바인딩 해석분
  제외). examples/procedures/monthly는 정의부 기간 0건 (golden·goldenArgs·
  createdAt 제외, m531-monthly-grep.test.ts로 고정).
- M5.3.1-4: golden.output 원문. 저장 시점 마스킹 제거 (confirm·updateGolden).
  비교 시점 마스킹(recordings)은 유지 — passthrough 재바인딩 비교는 그대로 통과.
  golden.output은 replay 전용 (drift 기준 아님, 표시용). 원문 포함 시
  golden.output 경고는 정상 (재바인딩 확인용).
  → M5.3.1-4 후속: 원문 정책과 모순되므로 golden.output 경고 자체를 제거.
  재바인딩 안전은 비교 시점 마스킹 + required params가 담당.
- M5.3.1-3: 기간성 params. finalize가 session 값 중 감사가 날짜로 판정한 값을
  default 없이 required로 기록. 미지정 run(import 시점)은 bad_request.
  renderProcedureMd/command.md는 required 표기.
  fixtures/ 경로를 manifest 역조회로 논리 경로로 변환 (바인딩 인자는 템플릿
  문자열, 고정은 source rel). 잔류 시 finalize bad_request.
  runner file_exists는 run fs를 먼저 본다 (실행 입력·산출 검사).
  출력 미생성 시 해당 제약 fail (10월 출력 부재와 동등).
- M5.3-5: policy grep 범위 확정. src/** 중 *.test.ts 제외.
  사유: 테스트는 checker·제약 종류 문자열을 테스트 데이터로 정식 포함
  (checker.test.ts 등)하므로 스캔 대상에서 제외.
  우회 금지: 테스트에 정책 문자열을 넣어 제품 동작에 반영하는 것은 금지.
  구조적 방지책 = instruction 언급 도구 제한 테스트 (M2.6-1) +
  description 언급 도구 제한 테스트. 리뷰 시 강제.
- M5.3-3: 스크립트 실행 제한. 자식 환경 화이트리스트
  (SYSTEMROOT·TEMP 등 + PYTHONUTF8/IO 고정, PATH·HOME·비밀 제외).
  단, Node가 Windows에서 시스템 변수(PATH·USERPROFILE 등)를 강제 주입하므로
  완전 차단은 불가 (문서화로 갈음). 네트워크 차단은 이식성 있게 불가 —
  OS 수준 sandbox 아님을 SKILL·여기에 명시.
  실행 전후 projectRoot 스냅샷(size:mtime, .procforge/node_modules/.git 제외,
  10만 파일 상한) 비교로 run fs 밖 변경 감지 → 노드 fail.
  병렬 세션이 같은 projectRoot를 쓰면 오탐 가능 (detail에 변경 목록).
  (var/템플릿 경로 제외, pptx는 무의존 zip 텍스트 추출)에서 날짜·params값·
  녹화 수치(4자리+) 검사, 면제 없음. strict 시 bad_request.
  상한: 스크립트 200KB, 템플릿 8MB (초과·판독 불가 조용히 제외).
- M5.3-2: S2 제목 템플릿 (`${params.month} 실적 요약`). 템플릿은 빈 껍데기
  (shell.pptx)로 유지 — 작업 사본 렌더가 아니라 template→output 복사로 생성.
  python-pptx 1.0.2 테이블은 행 고정이라 표 전체 교체 (기하 유지).
  CI+실측 모두 10월 산출 전체 텍스트 9월 잔재 0건 단언.
- M5-1: `procforge run <procedure> --param k=v [--out dir] [--force]` 신설
  (App.runProcedure 경유). 출력은 runs/<runId>/fs, --out 지정 시에만 완료 후
  프로젝트 안으로 복사 (기존 파일은 --force 없이 거부).
- M5-2: live에서 generated 미공급·external 미승인은 suspended로 중단하고
  state.json 저장 (재개용). supplied/approved/skipNodeIds로 단계 재실행.
  live 게이트 제거.
- M5-3: pf_run_start/next/supply (App 1:1, TOOL_NAMES·APP_METHODS·계약 갱신).
  supply는 생성값 저장·승인(true) 후 자동 진행. CLI approve는 상태 표시만.
  MCP SDK는 union outputSchema 미지원 → 등록용 loose 스키마 분리.
- M5-6: SKILL/command에 run 병기 (M4.1-8 "replay 한정" 철회).
- M5-7: test/m5-live.test.ts — params 변경 live·generated suspend/supply·
  external 승인·실패 하류 차단 (fake 서버, CI 양 OS).
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
 - [M7-5-a] 스크립트 실행은 **비동기**(spawn)다. spawnSync 옛에는 이벤트 루프가 막혀
   취소가 도달하지 못했다(길게 걸린 스크립트는 끝까지 돈다). onChild 로 pid 를
   runs/<runId> 에 등록하고, 실행 중에도 취소 플래그를 200ms 간격으로 확인한다.
 - [M7-5-b] POSIX 는 detached:true 로 띄워 **그룹 리더**로 만든다. 그래야 그룹 시그널이
   손자까지 닿는다(SIGTERM → 1.5s 유예 → SIGKILL). 개별 pid 만 죽이면 손자가 산다.
 - [M7-5-c] 동시 실행 잠금은 try/finally 로 항상 푼다(예외로 409 고착 금지).
   승인·생성값 **대기 중에는 잠금을 유지**하고, 승인이 uiApprove 를 통해 진행을 재개한다.
   이미 끝난 run 은 취소해도 상태가 바뀌지 않는다.
 - [M7-5-d] 실행 요청 키는 {procedure, params} **화이트리스트**(denylist 는 구멍이 된다),
   params 값은 문자열만. 실행 로그 SSE 는 세션 SSE 와 동일 규칙(상한·heartbeat·id).
 - [M7-5-e] 승인은 스크립트 **내용 스냅샷**(procedures/<name>/approved/)을 남긴다.
   이력의 파일 경로를 다시 읽으면 그 파일이 이미 현재본이라 diff 가 늘 null 이 된다.
   경로는 index.json 에 둔다(approvals 의 args 는 zod 정규화로 여분 키가 사라진다).
 - [M7-5-f] approvalHash 가 없는 이력(v1)은 **미승인**으로 본다. 예외를 두면
   "스크립트가 바뀌면 무효" 원칙에 구멍이 생긴다.
 - [M7-5-g] 승인 화면의 스크립트 읽기는 realpath sandbox + 5MB 상한(M7-ui3-3 공통).
 - [M7-5-h] diff 의 LCS 표는 **크기 검사 뒤에** 만든다. 넘으면 "diff 생략"을 알린다.
 - [M7-5-i] 승인 POST 의 approved 는 boolean 필수 — 빠지면 400(조용한 승인 금지).