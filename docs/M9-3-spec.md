# M9-3-spec — 교훈 집계 (메모리 4층)

> 상태: 확정 (판정자 [M9-3-spec-fix]).
> M9-2 §5 판정 4 (B 확정)의 구체화. 반려된 초안(`a5a2445`)을 판정 5건으로 재작성.

## §0 현황 5항목 (위치 / 사실 / 빈틈)

### 1. lessons.md 생산자 없음 — 보존만 있음
- 위치: `packages/local/src/services/procedureWriter.ts:241-247`
  (SIDECAR_KEEP에 `lessons.md` 포함), `:329-332` (재finalize 시 보존 복사).
- 사실: lessons.md를 쓰는 생산 코드는 없다 (사용자 수기).
  `m11-sidecar.test.ts:47-52`는 수기 작성 후 재finalize 바이트동일만 검증한다.
- 빈틈: 자동 구획과 수기 구획의 구분이 없어 집계가 갱신할 자리가 없음
  (§2c에서 정의).

### 2. history/는 적용 전 판본 보관 — 교훈 텍스트 아님
- 위치: `packages/local/src/app/app.ts:4111-4115`
  (`history/<stamp>-<hash12>.json`에 적용 전 procedure.json 원문).
- 사실: 재사용 메모리(판본 복원용). 교훈 문장 저장소가 아니다.
- 빈틈: 없음 (M9-3 집계 입력이 아님 — 판본과 교훈을 혼동하지 않는다).

### 3. 재승인 빈틈 확정 — approvals.json은 덮어쓴다
- 위치: `packages/local/src/services/approvals.ts:566-576`
  (`saveApproval`: 같은 nodeId면 교체, 이력 남지 않음).
- 사실: M11-pre-0에서 확정된 유일한 빈틈. 재승인 횟수는 어디에도 기록되지 않는다.
- 빈틈: `approve` 줄로 별도 기록한다 (§2a).

### 4. 소비자·재료 현황
- 유사분석: `packages/local/src/services/similar.ts:65-122`
  (`listProceduresWithLatest`: goals + latest + metrics만 반환, lessons 미참조).
- 재료: M9-2-spec §0-5 (events.jsonl, cassettes, attempts, node hash).
  attempt에 node hash가 기록되지 않아 조인 시 재계산 필요.
- 집계 저장소·쿼리 코드: 없음.
- 범위: M9-3 집계는 사실 기록(`events.ndjson`) + `lessons.md`를 대상으로 한다.
  문장 요약·자동 추출은 범위 밖 (M10 불변: Proof가 직접 LLM을 호출하지 않음,
  `docs/M10-spec.md:27-31`).

### 5. latest/metrics 인덱스 현행
- 위치: `packages/local/src/services/procedure-latest.ts:11-30`
  (종료 상태일 때만 `runs/by-procedure/<name>/latest.json` 원자 갱신),
  `similar.ts:43-63` (metricsSummary: 파일 수·행 합, 순위 미사용).
- 사실: 집계가 참조할 절차서별 최신 실행 포인터는 이미 있다.
- 빈틈: lessons용 인덱스는 만들지 않는다 (읽을 때 계산, §5 판정 2).

## §1 목표
- 실행 사실(run 종료·승인·승인리셋)을 절차서별로 append-only로 쌓고,
  읽을 때 집계(노드별 실패 수·평균 소요 시간·재승인 수)한다.
- `lessons.md`는 자동 구획(집계 숫자만)과 수기 구획(바이트 보존)으로 나눈다.
- 유사분석 응답에 `lessons` 최대 5줄과 `stats`를 넣는다 (순위·MCP 표면 불변).
- 범위 밖: 문장 요약·자동 추출, history/ 판본의 교훈 전용화, MCP 표면 변경,
  파일 크기 회전·상한 (커지면 별도 판정 — 본 사양 범위 밖).

## §2a 사실 기록 `events.ndjson` 줄 형식

- 위치: `runs/by-procedure/<name>/events.ndjson` (새 파일, 이 이름과
  `procedures/<name>/history/`가 겹치지 않게 한다).
- 공통 필드: `{v:1, ts, kind, procedure}`. kind는 다음 3가지뿐이다.
  - `run_end`: `runId, status, mode, nodes:[{nodeId, status, durationMs}]`
    (`mode`는 `RunReport.mode`, `runner/types.ts:76` — replay도 이 지점을
    지나므로 집계는 live만 대상으로 한다, §2b).
    쓰는 위치: `packages/local/src/runner/run.ts:663`
    (report.json 기록 지점 — run 종료, 모드 분기 없음).
    근거: `proof test`는 `runProcedureTest` →
    `runSession({mode: ?? "replay"})` (`procedure-run.ts:83-88`,
    기본값 `run.ts:230`), drive는 `mode: "live"` (`app.ts:4563`).
  - `approve`: `nodeId, hash12` (hash12 = 승인 노드 hash 앞 12자,
    `cli-main.ts:249` 관례). 쓰는 위치:
    `packages/local/src/services/approvals.ts:566` (`saveApproval` —
    `commitApproval`도 이 길로만 적는다, `:584-595`).
  - `approval_reset`: `nodeIds, cause` (`cause`는 `"apply"` 하나로 고정 —
    goal이 바뀌어 stale이 되는 것은 검사 시점의 판정이지 이벤트가 아니다).
    쓰는 위치: `packages/local/src/app/app.ts:4126`
    (`applyDraft`의 `changedNodes.filter` — `approvalReset` 확정 지점).
- 쓰기 규칙: append 1줄 (줄바꿈 구분). 쓰기는 best-effort —
  실패해도 실행 결과를 바꾸지 않는다 (M9-2-2 metrics 선례).
- 실행 종료 시 1줄, approve·approval_reset 시 1줄씩만 쓴다.

## §2b 집계 정의 (읽을 때 계산, 인덱스 없음)

- 대상: `mode==="live"`인 `run_end`만 집계한다 (replay는 제외).
  상태값 근거: 노드 `status==="fail"`은 `NodeResultStatus`
  (`runner/types.ts:52-60` — `"fail"`), run `status==="done"`은
  `RunState.status` (`services/run-state.ts:39`)와 일치한다.
- 노드별 실패 수: `run_end`의 `nodes[]`에서 `status==="fail"`인 줄의
  nodeId별 개수.
- 평균 소요 시간: `status==="done"`인 `run_end`의 `nodes[]`에서
  nodeId별 `durationMs` 산술평균 (성공한 run만).
- 재승인 수: `approve` 줄에서 같은 nodeId의 바로 직전 줄과 `hash12`가 다를 때만
  1씩 센다 (같은 해시의 반복 승인은 재승인이 아니다). 첫 승인은 제외한다.
- 파일 없음·빈 파일: 빈 목록 (정상).
- 깨진 줄: 건너뛰고 건너뛴 줄 수를 센다 (집계 결과에 `skipped`로 포함).

## §2c `lessons.md` 형식 (자동 구획 + 수기 구획)

- 자동 구획: `<!-- proof:auto -->` 부터 `<!-- /proof:auto -->` 까지.
  안은 Proof만 다시 생성하고, 집계 숫자만 담고 문장 요약은 넣지 않는다.
  예: `- 노드 1.1 실패 3회, 평균 42s, 재승인 1회`.
- 구획 밖 수기 내용은 바이트 단위로 보존한다 (자동 갱신이 건드리지 않음).
- 유사분석에 넣는 `lessons` 5줄: 수기 구획에서 `- `로 시작하는 줄 중
  앞에서부터 5개. 줄마다 500자에서 잘라내고 잘랐으면 `truncated:true`를 붙인다.
  자동 구획 안의 줄은 세지 않는다.
- 생성 경로: HTTP `POST /api/procedures/:name/lessons/refresh`와 UI 버튼으로만
  하고 MCP는 바꾸지 않는다 (신규 MCP 도구 없음).
- 재finalize 보존 현행 유지 (`procedureWriter.ts:241-247`).

## §3 저장 위치·파일 형식 (`.procforge/` 아래, 불변 목록 준수)
- `runs/by-procedure/<name>/events.ndjson` — 신규 (append-only).
- `procedures/<name>/lessons.md` — 현행 유지 (구획 규약만 추가).
- `procedures/<name>/history/` — 현행 유지 (판본 보관, 교훈 아님).
- `runs/by-procedure/<name>/latest.json` — 현행 유지 (대조용).
- 불변 준수: `pf_*` 21종·`procforge_decompose`·`format`·
  `.procforge` 루트·`server.ts:618`/`app.ts:160` 건드리지 않음
  (M9-2-spec §3과 동일).

## §4 구현 커밋 분할안

### M9-3-1 events 쓰기+테스트
- 3 kind 각 1건 (run 종료 줄·approve 줄·reset 줄) + 쓰기 실패 시
  실행 결과 불변 1건. 기존 테스트 파괴 0.

### M9-3-2 집계 읽기+파서
- §2b 집계 3종 + lessons 파서 5종(정상·줄 없음·파일 없음·500자 초과·
  자동 구획 제외)에 깨진 줄 건너뛰기 1건을 더한다.

### M9-3-3 lessons 자동 구획 갱신
- 수기 보존 바이트 동일 테스트 + 재finalize 후 보존 테스트
  (m11-sidecar 확장).

### M9-3-4 유사분석 연동
- 응답에 `lessons` 최대 5줄과 `stats`(실행 수, 실패 상위 노드 3개)를 넣는다.
  순위는 바꾸지 않고, MCP 표면도 그대로 둔다.

### M9-3-5 문서
- DEV-GUIDE lessons 작성법 1절 + PROCEDURE-FORMAT lessons.md 형식 +
  DECISIONS [M9-3] 판정 기록.

## §5 판정 (판정자 [M9-3-spec-fix])
1. 범위: B를 확장한다. 사실 기록(`events.ndjson`), 읽을 때 계산하는 집계,
   `lessons.md`(자동 구획과 수기 구획)를 모두 포함한다.
2. 집계 방식: 쓰기는 `events.ndjson` append 1종만 둔다. 실행 종료 시 1줄,
   approve·approval_reset 시 1줄이다. 집계는 읽을 때 계산하고 인덱스 파일은
   만들지 않는다. 쓰기는 best-effort로, 실패해도 실행 결과를 바꾸지 않는다.
3. M10-1 연동: 유사분석 응답에 `lessons` 최대 5줄과 `stats`(실행 수,
   실패 상위 노드 3개)를 넣는다. 순위는 바꾸지 않고, MCP 표면도 그대로 둔다.
4. 줄 길이: 500자 상한이다. 넘으면 잘라내고 `truncated:true`를 붙이며,
   거부하지 않는다. 수기 파일 하나 때문에 집계 전체가 깨지면 안 되기 때문이다.
5. 파일이 없을 때: 빈 목록을 돌려주고 정상으로 처리한다. `events.ndjson`에서
   깨진 줄은 건너뛰고 건너뛴 줄 수를 센다.
