# M10-3-0 화면 설계서 (구현 없음 — 설계+목업만)

- 목업: [`mockups/m10-guide.html`](mockups/m10-guide.html) (가짜 데이터, 제품 빌드 미포함).
- 범위: M10-2 재분석 초안 → M10-4 순차 자동 실행을 **사람이 단계별로 확인하는** 한 화면.
  분석 자체(분해·재분석 생성)는 기존 경로 그대로, 이 화면은 진행·확인·승인용이다.

## 1. 화면 구성 (위→아래, 좌→우)

1. **상단 진행률 바**: `확정되고 재검증 대기가 아닌 leaf 수 / leaf 수`.
   재검증 대기(`needs_reverify`) 노드도 leaf이므로 분모에 따로 더하지 않는다
   (재검증 전에는 완료로 치지 않아 분자에서만 빠진다).
   예: leaf 5개 중 3개 pass, 재검증 1개 → `3 / 5 (60%)`.
2. **에이전트 레인 4개** (가로 swimlane): 분석 / 재분석 / 실행 / 검증.
   각 레인은 현재 단계의 노드 칩을 올린다. 레인 시작·끝은 전용 이벤트가
   없어서(부족한 이벤트 ①②) 지금은 `session.status`+`message.part.updated`
   로 추정하고, 정식 이벤트는 M10-3에서 추가한다.
3. **노드 그래프** (좌측): 상태별 색상.
    open=회색, probing/running=파랑, leaf 확인 대기=노랑, pass=초록,
   fail=빨강, needs_reverify=주황, stale(부모 변경)=보라 테두리.
   노드 카드에는 id·goal 1줄·`why` 1줄을 항상 보여준다.
4. **노드 상세** (우측): 목표, **왜** (읽기 + "왜 수정" 입력),
   인자 목록, 의견 입력 + [의견 보내기], 승인 상태, [재확정]/[승인] 버튼.
   의견은 기존 `uiAdvise` 경로, 왜 수정은 `editWhy`(App, MCP 아님).
5. **불러온 메모리** 패널: `similarProcedures` 결과 상위 N건
   (이름·최종 실행 상태·metrics 요약 rows). 클릭하면 해당 절차서를 불러온다.
   메모리 로드 시점 전용 이벤트는 없다(부족한 이벤트 ③) — 폴링으로 갱신한다.
6. **남은 작업** 목록: 미완료 leaf + needs_reverify + suspended(승인 대기).
   `pf_tree` + `getBlocked` 조합으로 계산한다.
7. **실시간 로그**: `GET /api/runs/:runId/stream` (SSE, run 로그).
   세션 이벤트는 `GET /api/sessions/:id/events` 폴링 (Last-Event-ID 지원).
8. **재분석 diff**: 노드별 before/after + `reason` (M10-2 `draft.json`).
   `accept`(적용)/`reject`(폐기) 버튼. 적용은 M10-4 범위 밖(다음 단계).

## 2. 요소별 API·SSE 매핑

| 요소 | 읽기 API | 쓰기 API | SSE/폴링 |
|---|---|---|---|
| 진행률 | `GET /api/sessions/:id/tree` (leaf 집계) | - | 세션 events 폴링 |
| 레인 4개 | `GET /api/sessions/:id/tree` + `GET /api/sessions/:id/events` | - | 부족 ①② (아래) |
| 노드 그래프 | `GET /api/sessions/:id/tree` | - | 세션 events 폴링 |
| 노드 상세 | `GET /api/sessions/:id/nodes/:nid` | 의견 `POST /api/advise`(uiAdvise), 왜 수정 `editWhy`(App 직접, MCP 없음) | - |
| 불러온 메모리 | `similarProcedures`(App 직접, HTTP 미노출) | - | 부족 ③ |
| 남은 작업 | `GET /api/sessions/:id/tree`, `getBlocked` 상당 | - | 세션 events 폴링 |
| 실시간 로그 | `GET /api/runs/:id/stream` (SSE) | `POST /api/runs`, `/api/runs/:id/cancel` | run SSE |
| 재분석 diff | `draft.json` 읽기 (서버 파일 직접 아님 — App 경유 필요, M10-4에서 API화) | `prompt_async`(OpenCode, 도구 비활성) | OpenCode `/event` (서버-서버) |
| 승인 | `GET /api/sessions/:id/nodes/:nid/approval` | `POST /api/runs/:id/approve`, `pf_approve` | - |

## 3. 부족한 이벤트 (M10-3에서 추가할 것)

1. `lane.started` / `lane.finished` — 레인별 시작·끝 (지금은 추정).
2. `run.phase` — 실행 단계 전환 알림 (지금은 로그 파싱).
3. `memory.loaded` — 불러온 메모리 확정 시점 (지금은 폴링).
4. `draft.ready` — 재분석 diff 준비 완료 (지금은 파일 폴링).

## 4. 그래프 라이브러리 비교 (도입 전 package.json·LICENSE 파일 확인 필수)

| 후보 | 크기(대략) | 라이선스(도입 전 확인) | 트리 배치 | 비고 |
|---|---|---|---|---|
| d3-hierarchy + SVG 직접 렌더 | 작음 (~30KB, d3-hierarchy만) | ISC (d3 계열) | `tree()` 내장, 노드 카드 자유 배치 | **추천**: why 1줄·상태 배지를 HTML로 얹기 가장 쉬움. 줌/팬은 직접 구현 |
| ECharts tree | 중간 (~300KB tree만) | Apache-2.0 | `tree` 시리즈 내장 | 빠른 구현. 노드 카드 커스텀은 formatter로 제한적 |
| CSS 중첩 리스트 | 0 | 없음 | 들여쓰기로 표현 | 폴백안. 줌/팬 없음, 노드 50개 이상에서 불편 |

- 판정 필요: **A안 d3-hierarchy** (추천 — why 표시·OmO 커스텀이 목적에 맞음) /
  B안 ECharts (빠른 구현, 커스텀 제약) / C안 CSS 리스트 (폴백).
- 목업(`m10-guide.html`)은 라이브러리 없이 CSS 중첩 리스트로 그린 동일 레이아웃이다.
