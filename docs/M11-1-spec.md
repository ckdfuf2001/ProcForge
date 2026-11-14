# M11-1-spec — To-Do 운영 (사양 초안, [M11-1-spec3] 확정 반영)

> 상태: 초안 (확정 — §5). 코드 변경은 단계 2에서 한다.
> 사용자 답: To-Do 운영은 (a)안 기준.

## §0 현황
- 출처: `docs/M10-spec.md:13-15` (§0-4: "진행률, 남은 작업 ... 한 화면에 보여준다 (OmO 화면 구성 참고)")와 `docs/M10-spec.md:23-25` (§1 2차 범위 목록: "To-Do 운영 (M11-1)").
- 호출하는 컴포넌트: `packages/ui/src/GuideView.tsx:68` `<RemainingList nodes={nodes} needsHuman={needsHuman} />`.
- 값의 출처: `packages/ui/src/GuideView.tsx:30` `setNodes(t.nodes.nodes)`, `packages/ui/src/GuideView.tsx:32` `setNeedsHuman(t.blocked.needsHuman)`.
- API 경로: `packages/ui/src/api.ts:327` `tree: (sid) => get<TreeResponse>("/api/sessions/${sid}/tree")`, 타입 `packages/ui/src/api.ts:161-165` `TreeResponse { nodes: { nodes, revision }, blocked: { needsHuman } }`.
- 계산식: `packages/ui/src/RemainingList.tsx:16-20` (undone = isLeafId && status !== "leaf", reverify = status === "needs_reverify", 합집합 + needsHuman, 정렬은 `compareNodeIds` — `packages/ui/src/TreeView.tsx:37`).
- 현재 `RemainingList` (`packages/ui/src/RemainingList.tsx:8-20`)는 현재 세션 트리만 보여주는 표시 컴포넌트다. 저장·체크 기능이 없고 세션을 바꾸면 내용이 바뀐다.
- `SIDECAR_KEEP` 원문 (`packages/local/src/services/procedureWriter.ts:241-247`): `const SIDECAR_KEEP: { rel: string; dir: boolean }[] = [ { rel: "state.json", dir: false }, { rel: "approvals.json", dir: false }, { rel: "lessons.md", dir: false }, { rel: "approved", dir: true }, { rel: "history", dir: true } ];`
- 가이드 실행 상태 필드 원문 (`packages/local/src/services/guide.ts:11-17`): `status: "pending" | "running" | "waiting" | "done" | "failed" | "cancelled"`, 타입 정의 `packages/local/src/services/guide.ts:11` `export type GuideStepState`, 묶음 `packages/local/src/services/guide.ts:23` `state: GuideStepState[]`.
- 확정된 절차서의 실행 결과 기준 진행 상태를 읽을 수 있는 기존 출처: `packages/local/src/services/procedure-latest.ts:25` (`runs/by-procedure/<name>/latest.json` 기록), 타입 `packages/local/src/runner/types.ts:109-113` `ProcedureLatest { runId, status: "done" | "failed" | "cancelled", at }`; 보조로 `packages/local/src/services/events-log.ts:10-11` `eventsLogPath` (`runs/by-procedure/<name>/events.ndjson`), 가이드 파일 `packages/local/src/services/guide.ts:19-26` `GuideFile`.
- OpenCode 세션 todo API: `docs/M10-0-opencode-api.md`에서 `todo` grep 결과 없음(0건). 실서버 읽기 전용 GET 1회 (`GET /session/:id/todo`) 실패로 "미확인" (재시도 없음).

## §1 동작 후보 3안
### 안 a (채택, 확정 반영): 절차서별 남은 단계 수와 진행률 보기
- 데이터 출처: `procedures/<name>/procedure.json`의 leaf 목록 (`packages/shared/src/procedure.ts:46-55` 노드 스키마, `children.length === 0`이 leaf) + 최신 live run의 `runs/<runId>/report.json` (`packages/local/src/runner/types.ts:78` `results: NodeResult[]`, `packages/local/src/runner/types.ts:76` `mode`, 상태값 `packages/local/src/runner/types.ts:52-60`) + `procedures/<name>/approvals.json`의 승인 hash (`packages/local/src/services/approvals.ts:224` `loadApprovals`). 최신 live runId는 `runs/by-procedure/<name>/events.ndjson`의 `run_end(mode:"live")` (`packages/local/src/runner/run.ts:684-691`)에서 찾고 `report.json`의 `mode`로 검증한다. `latest.json`은 live 외 mode에서도 갱신되므로 (`packages/local/src/runner/run.ts:772-778` mode 무관) 쓰지 않는다.
- 쓰기 경로 유무: 없음. 읽기 전용이다. 파일 쓰기 0건, 잠금 없음.
- 재finalize 시 동작: 영향 없음. 쓰는 상태가 없어 유실이 없고 `SIDECAR_KEEP` (`packages/local/src/services/procedureWriter.ts:241-247`) 추가가 필요 없다.
- 재분석 시 동작: `procedure.json`·`report.json`·`approvals.json`을 다시 읽는 집계라 저장 상태가 없어 엉뚱한 노드에 체크가 남는 문제가 없다.
- "미완료" 정의 (판정 확정): 대상은 절차서의 leaf 노드 전체다 (기존 `RemainingList` 셈은 폐기). 완료는 최신 live run `runs/<runId>/report.json`의 `results[]`에서 결과가 `pass`인 leaf다. 미완료는 그 밖의 leaf(`fail`, `skip`, 미도달) + 현재 승인 hash가 무효인 노드다 (승인 판정은 `packages/local/src/services/approvals.ts:612` `approvalPins` + `packages/local/src/app/app.ts:2914` `hasCurrentApproval`의 approvalHash 일치 기준을 재사용). 진행률은 완료 leaf 수 / 전체 leaf 수다. live run이 0회면 "실행 기록 없음"(`progress` null)으로 두고 0%로 표시하지 않는다.
- 이름 (판정 확정): App `listProcedureProgress()`, UI `GET /api/procedures/progress`. 신규 `pf_*` 없음. MCP 도구는 21개 그대로다 (`packages/local/src/server.ts:58-80` `TOOL_NAMES`).

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
- 정렬이 절차서 이름순이다.
- 원본 파일의 바이트가 바뀌지 않는다 (`procedure.json`, `approvals.json`, run 기록).

## §4 범위 밖
- M11-2 (병렬 실행).
- events 로그 회전.
- remember.
- 안 b와 안 c의 구현.

## §5 확정(M11-1-spec2 판정)
1. "미완료" 정의 확정: 대상은 절차서의 leaf 노드 전체 (기존 `RemainingList` 셈 폐기). 완료는 최신 live run `runs/<runId>/report.json`의 `results[]`에서 `pass`인 leaf. 미완료는 그 밖의 leaf(`fail`, `skip`, 미도달) + 현재 승인 hash 무효 노드. 진행률은 완료/전체. live run 0회면 "실행 기록 없음"(`progress` null).
2. 이름 확정: App `listProcedureProgress()`, UI `GET /api/procedures/progress`. 신규 `pf_*` 없음, MCP 21개 그대로, 정렬은 절차서 이름순.