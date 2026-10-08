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

## M1

- [M1-1] checker 주입 — §6 pf_report의 verdict 계산은 local checker(§7)가 소유. core는 `EvaluateFn`을 생성자 주입받고 기본값은 constraints-empty→pass, 그 외→fail. 이유: core→local import 순환 방지 + 의존방향(local→core 금지) 유지. M2에서 local MCP 핸들러가 `checker.evaluateAll`을 주입한다.
- [M1-2] split 자식에 sideEffect 지정 — `PfResolveInput.children[]`에 `sideEffect?` 추가(가이드 §6의 `sideEffect?`를 자식별 지정으로 확장 해석). 이유: external 차단 테스트에 필요. 영향: shared/core-client 변경.
- [M1-3] "부가세 제외" 조언 변환 — regex `{ path: "summary", pattern: "부가세.?제외|세전|VAT[^\n]*excl" }`로 결정적 변환. 이유: M4 "자동 검사"를 llm_rubric(비가역)으로는 만족 불가. 요약에 기준 명시를 강제하는 형태로 검증 가능하게 함.
- [M1-4] stale 처리 — hash 변경 시 하류(dependsOn으로 직접/전이적 연결) 중 leaf/split만 open으로 되돌림. `stale` 상태값은 추가하지 않음(NodeStatus 변경 금지).
- [M1-5] needs_human만 남으면 pfNext가 해당 노드 반환(조언 유도). done은 open/probing/needs_human이 모두 없을 때만 true.
