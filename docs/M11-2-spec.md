# M11-2-spec — 병렬 실행 사양 초안 (구현 없음, 조사 + 권장안)

질문 (a)/(b)/(c) 무답이므로 세 안을 모두 조사하고 권장안 1개를 제시한다.

## §0 현황 (단계 0 확인, 파일:행)

- 메인 실행 루프는 직렬 고정: `packages/local/src/runner/run.ts:445` `for (const n of ordered)` + `run.ts:534` `await execNode(...)` — 노드마다 await 순차 실행.
- 순서는 위상 정렬: `run.ts:85` `orderNodes` (topo `childrenOf`, `run.ts:95` pending 루프). `dependsOn` 없는 형제 노드도 정렬 순서대로 1개씩 실행된다.
- map 항목 루프도 직렬: `execMap` (`run.ts:1532`)이 `run.ts:1658` `for (let i = 0; i < items.length; i++)` + `run.ts:1713` `await execNode(...)` 로 항목을 1개씩 실행. 항목 수 상한은 스펙 `maxItems` (`run.ts:1587-1591`, `slice(0, maxItems)`).
- until 본문도 직렬 반복: `execUntil` (`run.ts:1833`) 내 `run.ts:1988` `await execNode(...)`.
- run 구동은 절차서별 단일 루프: `packages/local/src/app/app.ts:4226` `driveRun` (`runStep` 반복, `need_approval`이면 사람이 결정해야 하므로 멈춤 `app.ts:4255`).
- 같은 절차서 중복 실행 방지: `app.ts:380` `activeRuns` (절차서명 키) + `app.ts:3432-3447` 실행 중이면 `conflict`, `app.ts:3450` set / `app.ts:4339,4892` delete. `prepareRun`도 `acquireProcRunLock` 실패 시 conflict (`app.ts:2602,2610`, 락 경로 `packages/local/src/services/run-lock.ts:12` `procRunLockPath`, 획득 `run-lock.ts:32`). runner 측도 락을 잡는다 (`run.ts:344-350`).
- `report.json` `results[]` 순서: push 순서 그대로이며 정렬 없음. push는 `ordered` 순서이므로 결과적으로 노드(위상) 순서다. 기록 지점 `run.ts:666-681` (`results` 그대로 `JSON.stringify`). `run_end` 이벤트의 `nodes` 배열도 같은 순서 (`run.ts:690`).
- golden은 순서 무관 공급: 범위 밖·완료분 출력은 실행 전 `outputs`에 주입 (`run.ts:428-441`).
- M11-2 언급 원문 (`docs/M10-spec.md:23-25`): 2차 범위 밖 목록에 "병렬 실행 (M11-2)" 명시.

## §1 후보 (a)(b)(c)

### 안 (a) map 자식(항목) 동시 실행
- 바뀌는 곳: `execMap` 항목 루프 (`run.ts:1658-1713`)를 동시 실행으로. 항목 출력 키는 `run.ts:1734` `${n.id}.${j+1}` 로 인덱스 분리됨.
- 상한: `maxItems` 이하, 추가 상한(동시 실행 수)은 신규 도입 필요.
- 위험: `outputs` Map 동시 쓰기 경합; 항목별 승인 단위(현재 map 노드 단위 승인)와 `approvalHash` 재계산; 실패 시 나머지 항목 취소 규칙(`run.ts:1734` 정리 로직과 충돌); golden 결정성(항목 순서에 따라 합산 출력이 달라지면 안 됨); events `run_end.nodes` 순서는 항목이 아니라 노드 단위라 영향 없음.

### 안 (b) dependsOn 없는 형제 노드 동시 실행
- 바뀌는 곳: 메인 루프 (`run.ts:445`)를 ready-set(의존 충족 집합) 스케줄러로 교체. `orderNodes`는 순서만 주므로 실행기 변경이 필요.
- 상한: 동시 실행 수 상한 신규 도입 필요 (CPU/메모리, MCP 동시 호출).
- 위험: `outputs`·`accumulate` 공유 상태 경합; 승인 대기 노드가 섞이면 `driveRun` 전체가 멈춤(`app.ts:4255`) — 동시 실행 중 1개라도 승인 대기가 되면 나머지도 함께 멈추는지 규칙 필요; `procRunLock`은 절차서 단위라 형제 간 보호가 안 됨(노드 단위 잠금 신설 또는 금지 규칙); events와 `report.json` 순서는 노드 순서 고정 유지 필요(완료 순서대로 push하면 순서가 깨짐); golden 결정성(병렬 완료 순서가 출력에 반영되면 안 됨).

### 안 (c) 서로 다른 절차서 동시 실행
- 바뀌는 곳: runner 변경 없음. App 동시 구동 가능 여부 확인이 중심 — `activeRuns`는 이미 절차서명 키(`app.ts:380`)라 구조상 분리됨. `procRunLock`도 절차서별(`run-lock.ts:12`).
- 상한: 동시 run 수 상한 신규 도입 필요 (없으면 무제한 병렬).
- 위험: 프로세스 공유 자원(CPU/메모리, MCP `ConnectionPool` 동시 호출 한계); UI 동시 표시·runState 세션 분리; `driveRun` 루프 2개가 같은 `activeRuns` Map을 건드리므로 원자성 확인 필요; 승인·golden·`results[]` 순서에는 영향 없음(절차서별 독립 파일).

## §2 불변 조건
- 승인 hash와 golden은 바뀌지 않는다 (승인 판정 `approvals.ts:676`, golden 주입 `run.ts:428-441` 현행 유지).
- `results[]` 순서는 노드 순서로 결정된다 (정렬 추가 없음, `run.ts:666-681`).
- MCP 도구는 21개 그대로다 (`packages/local/src/server.ts:58-80` `TOOL_NAMES`).

## §3 테스트 후보
- (a) 항목 3개 map을 동시 실행해도 `needsReapproval`/출력 합산이 직렬과 동일 (golden 결정성).
- (b) 의존 없는 형제 2개 동시 실행 시 `report.json` `results[]` 순서가 노드 순서 유지.
- (c) 절차서 2개 동시 실행이 모두 done, 한쪽 취소가 다른 쪽에 영향 없음, `conflict`는 같은 절차서 중복 실행에만 발생.
- 공통: 승인 대기 1건이 포함된 병렬 실행의 멈춤·재개 규칙 단언, events `run_end` 순서 무관 단언.

## §4 범위 밖 (각 1줄)
- events 로그 회전: `events.ndjson` 증가 대책은 본 사양에서 다루지 않는다.
- Basic auth 1.18.18: 미검증 항목으로 남으며 본 사양과 무관하다.

## §5 판정 요청 (최대 3개, 권장안 포함)
1. 권장안 (c) 채택 여부를 판정해 주세요 — runner·승인·golden·`results[]` 순서를 전혀 건드리지 않고 변경점이 App 동시 실행 확인으로 한정되기 때문입니다.
2. 동시 실행 상한 값을 정해 주세요 (예: 절차서 3개, map 항목 4개 — 후보치이며 판정으로 확정).
3. (a)(b)는 폐기(향후 필요 시 재제안) 대 보류 중 어느 쪽으로 기록할지 정해 주세요.
