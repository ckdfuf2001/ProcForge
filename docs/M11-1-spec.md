# M11-1-spec — To-Do 운영 (사양 초안, [M11-1-spec2] 재작성)

> 상태: 초안 (판정 요청 — §5). 코드 변경 없음.
> 사용자 답: To-Do 운영은 (a)안 기준.

## §0 현황
- 출처: `docs/M10-spec.md:13-15` (§0-4: "진행률, 남은 작업 ... 한 화면에 보여준다 (OmO 화면 구성 참고)")와 `docs/M10-spec.md:23-25` (§1 2차 범위 목록: "To-Do 운영 (M11-1)").
- 호출하는 컴포넌트: `packages/ui/src/GuideView.tsx:68` `<RemainingList nodes={nodes} needsHuman={needsHuman} />`.
- 값의 출처: `packages/ui/src/GuideView.tsx:30` `setNodes(t.nodes.nodes)`, `packages/ui/src/GuideView.tsx:32` `setNeedsHuman(t.blocked.needsHuman)`.
- API 경로: `packages/ui/src/api.ts:327` `tree: (sid) => get<TreeResponse>("/api/sessions/${sid}/tree")`, 타입 `packages/ui/src/api.ts:161-165` `TreeResponse { nodes: { nodes, revision }, blocked: { needsHuman } }`.
- 계산식: `packages/ui/src/RemainingList.tsx:16-20` (undone = isLeafId && status !== "leaf", reverify = status === "needs_reverify", 합집합 + needsHuman, 정렬은 `compareNodeIds` — `packages/ui/src/TreeView.tsx:37`).
- 현재 `RemainingList` (`packages/ui/src/RemainingList.tsx:8-20`)는 현재 세션 트리만 보여주는 표시 컴포넌트다. 저장·체크 기능이 없고 세션을 바꾸면 내용이 바뀐다.
- `SIDECAR_KEEP` 원문 (`packages/local/src/services/procedureWriter.ts:241-247`): `const SIDECAR_KEEP: { rel: string; dir: boolean }[] = [ { rel: \"state.json\", dir: false }, { rel: \"approvals.json\", dir: false }, { rel: \"lessons.md\", dir: false }, { rel: \"approved\", dir: true }, { rel: \"history\", dir: true } ];`
- 가이드 실행 상태 필드 원문 (`packages/local/src/services/guide.ts:11-17`): `status: "pending" | "running" | "waiting" | "done" | "failed" | "cancelled"`, 타입 정의 `packages/local/src/services/guide.ts:11` `export type GuideStepState`, 묶음 `packages/local/src/services/guide.ts:23` `state: GuideStepState[]`.
- 확정된 절차서의 실행 결과 기준 진행 상태를 읽을 수 있는 기존 출처: `packages/local/src/services/procedure-latest.ts:25` (`runs/by-procedure/<name>/latest.json` 기록), 타입 `packages/local/src/runner/types.ts:109-113` `ProcedureLatest { runId, status: "done" | "failed" | "cancelled", at }`; 보조로 `packages/local/src/services/events-log.ts:10-11` `eventsLogPath` (`runs/by-procedure/<name>/events.ndjson`), 가이드 파일 `packages/local/src/services/guide.ts:19-26` `GuideFile`.
- OpenCode 세션 todo API: `docs/M10-0-opencode-api.md`에서 `todo` grep 결과 없음(0건). 실서버 읽기 전용 GET 1회 (`GET /session/:id/todo`) 실패로 "미확인" (재시도 없음).

## §1 동작 후보 3안
### 안 a (채택 기준, 사용자 답): 절차서별 남은 단계 수와 진행률 보기
- 데이터 출처: 각 절차서의 최신 run tree (`TreeResponse` 상당) + `runs/by-procedure/<name>/latest.json` (`packages/local/src/services/procedure-latest.ts:25`)를 합산한 읽기 전용 집계.
- 쓰기 경로 유무: 없음. 새 파일·기존 파일 쓰기가 없다.
- 재finalize 시 동작: 영향 없음. 쓰는 상태가 없어 유실이 없고 `SIDECAR_KEEP` (`packages/local/src/services/procedureWriter.ts:241-247`) 추가가 필요 없다.
- 재분석 시 동작: 새 tree를 그대로 다시 읽으므로 엉뚱한 노드에 체크가 남는 문제가 없다 (저장된 체크가 없기 때문).
- "미완료" 정의 (하나로 고정): 실행 결과 기준. 최신 run tree의 leaf 노드 중 `status !== "leaf"`인 것 + `status === "needs_reverify"`인 것 + `needsHuman` 차단분 (`packages/ui/src/RemainingList.tsx:16-20`과 동일 셈). 가이드 단계 기준(`status !== "done"`, `packages/local/src/services/guide.ts:12`)은 쓰지 않는다.
- 새 조회 함수·API 이름 후보: `listRemainingByProcedure()` (로컬 조회) 또는 `GET /api/procedures/remaining` (UI용 읽기 API). 신규 `pf_*` MCP 없음.

### 안 b (참고): 체크형 (사람이 완료 표시)
- 데이터 출처: 별도 저장 파일 제안 `procedures/<name>/todos.json` (절차서당 1개). `procedure.json`에서는 읽지 않는다.
- 쓰기 경로 유무: 있음. 체크 설정·해제 쓰기 경로가 필요하고, 동시 쓰기 잠금이 필요하다 (`packages/local/src/services/run-lock.ts:32` `acquireProcRunLock` 선례, `packages/local/src/services/lessons-agg.ts:199`는 App이 `procRunLock`을 잡으므로 finalize와 겹치지 않는다는 주석, 사용례 `packages/local/src/app/app.ts:4196`).
- 재finalize 시 동작: `SIDECAR_KEEP` (`packages/local/src/services/procedureWriter.ts:241-247`)에 `todos.json`을 추가하지 않으면 재finalize 때 유실된다. 추가하면 보존된다.
- 재분석 시 동작: 키를 노드 id로 하면 재분석 후 엉뚱한 노드에 체크가 붙는 문제가 생긴다. 키를 노드 hash로 하면 id 변경에 강하지만 추적·이관 규칙이 별도로 필요하다.
- 잠금: `refreshLessons` 선례처럼 쓰기 구간에 `acquireProcRunLock`이 필요하다 (`packages/local/src/services/run-lock.ts:32`).

### 안 c (참고): 에이전트 todo 표시
- 데이터 출처: OpenCode 세션 todo API (있다면).
- 쓰기 경로 유무: 없음 (표시만).
- 재finalize 시 동작: OpenCode 쪽 상태이므로 finalize와 무관하다.
- 재분석 시 동작: OpenCode 세션이 바뀌면 내용이 바뀌므로 절차서와 1:1로 묶이지 않는다.
- 실현 가능성 (§0-8번 결과): "미확인"이므로 이번 배치에서 구현 불가. grep 0건 + 실서버 GET 1회 실패라서 안 c는 보류한다.

## §2 불변 조건
- `procedure.json` 바이트 불변 (읽기만 하고 쓰지 않는다).
- 승인 hash 불변.
- golden 불변.
- `approvals.json` 불변 (`packages/local/src/services/procedureWriter.ts:243`가 sidecar로 보존하는 파일).
- run 기록 불변 (`runs/by-procedure/<name>/latest.json`, `events.ndjson`에 쓰지 않는다).
- MCP 표면 불변: Proof MCP 도구는 21개 그대로다 (`packages/local/src/server.ts:58-80` `TOOL_NAMES`). 신규 `pf_*` 없음.

## §3 테스트 후보 (안 a 기준, 3모드)
- 절차서 2개의 합산 수와 진행률이 표시된다 (미완료 수·완료율).
- 절차서 0개이거나 run 0회일 때 빈 표시가 나온다.
- 정렬이 기존 `compareNodeIds` 순서 (`packages/ui/src/TreeView.tsx:37`)를 따른다.
- 원본 파일의 바이트가 바뀌지 않는다 (`procedure.json`, `approvals.json`, run 기록).

## §4 범위 밖
- M11-2 (병렬 실행).
- events 로그 회전.
- remember.
- 안 b와 안 c의 구현.

## §5 판정 요청 (최대 2개)
1. "미완료" 정의로 실행 결과 기준 (`status !== "leaf"` + `needs_reverify` + `needsHuman`, `packages/ui/src/RemainingList.tsx:16-20`과 동일)을 확정해도 되는가. 가이드 단계 기준(`packages/local/src/services/guide.ts:12` `status !== "done"`)이 아니라 이 정의로 가도 되는가.
2. 새 읽기 조회 이름으로 `listRemainingByProcedure()` (또는 `GET /api/procedures/remaining`)을 써도 되는가. 신규 `pf_*` 없이 로컬·UI 조회로만 둔다는 점도 함께 확정해 달라.