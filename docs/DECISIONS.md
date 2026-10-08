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
- [M0-6] local→core 직접 import 금지 범위 — `packages/local/src/**`에서 `from "@procforge/core"` 또는 `packages/core/src` 경로 import를 CI(`scripts/check-deps.mjs`)에서 실패 처리. 허용: `@procforge/shared`, `CoreClient` 인터페이스 경유만. M0~M5 in-process 어댑터는 `packages/core` 측의 `createInProcessClient()`가 `CoreClient`를 반환하고 local은 인스턴스 주입으로만 받는다.

## M1

- [M1-1] checker 주입 — §6 pf_report의 verdict 계산은 local checker(§7)가 소유. core는 `EvaluateFn`을 생성자 주입받고 기본값은 constraints-empty→pass, 그 외→fail. 이유: core→local import 순환 방지 + 의존방향(local→core 금지) 유지. M2에서 local MCP 핸들러가 `checker.evaluateAll`을 주입한다.
- [M1-2] split 자식에 sideEffect 지정 — `PfResolveInput.children[]`에 `sideEffect?` 추가(가이드 §6의 `sideEffect?`를 자식별 지정으로 확장 해석). 이유: external 차단 테스트에 필요. 영향: shared/core-client 변경.
- [M1-3] "부가세 제외" 조언 변환 — regex `{ path: "summary", pattern: "부가세.?제외|세전|VAT[^\n]*excl" }`로 결정적 변환. 이유: M4 "자동 검사"를 llm_rubric(비가역)으로는 만족 불가. 요약에 기준 명시를 강제하는 형태로 검증 가능하게 함.
- [M1-4] stale 처리 — hash 변경 시 하류(dependsOn으로 직접/전이적 연결) 중 leaf/split만 open으로 되돌림. `stale` 상태값은 추가하지 않음(NodeStatus 변경 금지).
- [M1-5] needs_human만 남으면 pfNext가 해당 노드 반환(조언 유도). done은 open/probing/needs_human이 모두 없을 때만 true.
