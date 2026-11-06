# M9-2-spec 초안 — 실행 기록 재사용 메모리 (읽기 조사 기반)

> 구현 착수 조건: 판정자 승인 (§5 판정 필요 목록을 먼저 확정).
> 본 문서는 코드 읽기만으로 작성 (M9-2-0 항목 1~6). 테스트 실행 없음.

## §0 조사 6항목 (위치 / 사실 / 빈틈)

### 1. 누적 유실 결함 (M7 1,562행→859행, golden 시작 + --out 무시)
- 위치: `packages/local/src/runner/run.ts:304-315` (setupRunFs + preservePaths),
  `run.ts:346-360` (잠금 후 상태 overlay), `packages/local/src/runner/workdir.ts:44`
  (preserve면 fixture 덮어쓰기 skip), `packages/local/src/services/accumulate.ts`
  (seed/marker/write-back/conflict), `packages/local/test/m7-accumulate.test.ts` 6건.
- 사실: 결함(5.1)은 B안(accumulate)으로 해소되고 5.2에서 검증됨
  (1562행 유지, 859→1692, 빈 상태 859→1688, `docs/M7-dogfood.md:147-180`).
  `--out`은 시작점이 아니라 실행 후 복사 전용으로 유지
  (`app.ts:3673-3678` copyRunFsToOut) — A안(안을 시작점으로)은 미채택.
  accumulate 미선언 절차서는 여전히 fixture 시작 (설계상 정상).
- 빈틈: `--out` 복사본 + accumulate 통합 경로의 회귀 테스트가 없음
  (m7-accumulate는 run fs·state만 보고 outDir을 거치지 않음). 단계 3에서 1건 추가.
  `finalize`가 `accumulate` 선언을 생성하지 않아 수동 추가 필요 (항목 4와 연결).

### 2. runs/\<runId\>/ 파일·필드, 노드별 결과·소요시간·행 수
- 위치: `run-state.ts` (state.json), `services/run-log.ts:6-19`
  (log.ndjson `{seq,at,level,nodeId,message}`), `run.ts:639-654`
  (report.json: RunReport), `run.ts:732-756` (state 저장 조건),
  `app/run-control.ts:68-132` (children.json/cancel.json),
  `services/accumulate.ts:109-142` (accumulate.json marker),
  `runner/types.ts:62-90` (NodeResult/RunReport).
- 사실: 디렉터리 = `state.json` (RunState: status/pending/done/results/procedure/
  params/supplied/approved/waiting) + `log.ndjson` + `report.json`
  (`results[] {nodeId,status,failedConstraints,detail,durationMs}`,
  `summary`, `nodeHashes`) + `children.json`/`cancel.json` + `fs/` + `scripts/`.
  노드별 결과는 report.json results[], 소요시간은 results[].durationMs +
  report.at. 행 수는 저장 안 됨 — `csv_rows` 제약이 실행 시 fsDir 파일을
  직접 세어 판정 (`checker.ts:72-116`). 즉 행 수의 사후 획득처가 없음.
- 빈틈: 행 수·산출물 요약을 실행 종료 시점에 어딘가 기록해야 다음 실행이
  참조할 수 있음 (§2 1층·§5 판정 1).

### 3. finalize 후 절차서 ID·hash, 재finalize 시 ID 유지 여부
- 위치: `core/src/service.ts:2229-2286` (doc 조립 — id/hash 필드 없음),
  `app.ts:2402-2416` (writeProcedure 호출),
  `services/procedureWriter.ts:21-44` (swapDir 원자 교체), `:188-289` (빌드물).
- 사실: 식별자 = 디렉터리명(name)이며 doc에 id/hash 필드 자체가 없음.
  재finalize는 같은 `procedures/<name>/`에 tmp 빌드 후 원자 교체하므로
  이름(ID)은 유지, `sourceSession`·`createdAt`은 재생성(갱신)됨.
- 빈틈: swapDir이 디렉터리 전체 교체라 `approvals.json`·`approved/`·
  `.run.lock`·`state.json`(procedure-state.ts:9)이 함께 소실됨. 재finalize 후
  무인 실행은 approvals 재생성이 필요. `.procforge/state` (누적 본체)는
  procedures 밖이라 유지됨.

### 4. 다음 실행이 이어받을 파일과 procedure 스키마 선언 자리
- 위치: `services/procedure-state.ts` (procedures/\<name\>/state.json,
  성공 종료 시만 원자 저장), `run.ts:285-297` (`${state.}`·stateWrites 감지 시
  로드), `run.ts:732-755` (stateWrites 기록), `shared/src/procedure.ts:83`
  (`accumulate` 스키마), `procedure.ts:129-189` (import 시 golden/attempt 재조립).
- 사실: 이어받기 경로 4종 — ① `procedures/<name>/state.json`
  (stateWrites로 기록, `${state.x}` var ref로 참조, 첫 실행은
  `params.stateDefaults` JSON), ② `.procforge/state/<절차>/` (accumulate 산출물),
  ③ `params` defaults, ④ golden fixtures/output 의존 공급
  (`run.ts:401-411`, 미실행 노드는 golden 출력으로 주입).
  선언 자리: procedure.json `params[]`, 노드 args `var`+`"${state.}"`,
  노드 `stateWrites[{key,from}]`, `accumulate[{path,node}]`.
- 빈틈: `accumulate`·`stateWrites` 선언을 finalize가 만들지 않음 (수동 편집).
  state.json은 자유형 (스키마 검증 없음).

### 5. 교훈 재료 (events/calls/attempts), 노드 hash 묶음 가능 여부
- 위치: events — `.procforge/sessions/<sid>/events.jsonl`
  (`shared/src/filestore.ts:211-235`, EventEntry `shared/src/dto.ts:80-93`).
  calls — `sessions/<sid>/cassettes/<nodeId>.json`
  (`runner/recordings.ts:75`, Recording[]). attempts — 노드 `attempts[]`
  (`shared/src/schema.ts:307`, 세션 `nodes/<id>.json`에 저장,
  resultJson은 별도 파일+meta(sha/size/preview 4096자),
  `filestore.ts:204-209`).
- 사실: 노드 hash = `computeNodeHash` (`shared/src/schema.ts:423-446`,
  goal+args+constraints+dependsOn(+map/until/stateWrites), sha256 앞 16자).
  report.json `nodeHashes`, 세션별 lastPassHash (`run.ts:688-714`,
  by-session latest). golden 시도 식별 = `golden.attemptId`
  (`shared/src/procedure.ts:131`).
- 빈틈: hash 키로 attempts/cassette 집계는 구조상 가능하나, attempt에
  node hash가 기록되지 않아 조인 시점 재계산이 필요. 교훈 집계 저장소·쿼리 없음.
  resultJson 미리보기는 4096자로 잘림 (원문은 파일).

### 6. "run fs 밖 변경 감지" 감시 범위·기준, 병렬 테스트 관련성
- 위치: `runner/script-run.ts:199` (before 스냅샷) → `:275` (outsideChanges) →
  `:281` (무관 성공·실패 모두 거부). `snapshotProject` `:97-158`
  (서명 `size:mtimeMs:ctimeMs:hash`, 상한 10만 파일/해시 1MB·총 64MB·1만 개).
  제외는 최상위 `.procforge`·`node_modules`·`.git`만 (`:40`).
  호출자는 runScript 1곳뿐 (외부 경로 없음).
- 사실: 감시 범위 = `projectRoot` 서브트리. m75 테스트의 projectRoot는
  테스트별 고유 tmp(`makeTmp("pf-cancel-e2e-")` 등)라서, 병렬 테스트의 tmp
  삭제가 다른 테스트의 감시에 걸릴 구조가 아님.
- 판단: 01:39 `-` 삭제분(ledger 2026-11-06행)의 범위 내 삭제자는 테스트
  코드 경로에 없음 (`running()`은 poll만). 동일 projectRoot를 공유하는
  실행(레포 루트 dogfood + 병렬 파일 변경, projectRoot 직접 쓰기)에서만
  오탐 가능. 삭제 주체 로깅이 없어(before/after diff만) 원인 특정 불가 —
  빈틈으로 기록, 수정 금지 (판정자 지시).

## §1 목표
- 절차서 1회 작성 → 여러 번 재실행. 실행 결과(상태값·누적 산출물·행 수)를
  기록해 다음 실행이 참조한다.
- 범위: ① 행 수 등 산출물 요약의 실행 기록 (§0-2 빈틈), ② finalize 선언
  지원 또는 수동 절차 문서화 (§0-4 빈틈), ③ 재finalize sidecar 보존
  (§0-3 빈틈). 감시 범위·교훈 집계는 판단만 (코드 수정 없음).

## §2 메모리 4층 중 1~3층 데이터 모델 초안
- 1층 실행 이력: `runs/<runId>/report.json` 그대로 + 절차서별 latest 인덱스
  (by-session은 세션 기준이라 절차서 기준 인덱스가 없음 — 추가 시 판정 필요).
  행 수 요약 추가 (§5 판정 1).
- 2층 상태 이어받기: 현행 유지 (`procedures/<name>/state.json` +
  `.procforge/state/<절차>/` + `params` defaults). 선언 슬롯을 finalize가
  생성할지는 판정 필요 (§5 판정 2).
- 3층 기준치 비교: golden(output/fixtures) + lastPassHash + accumulate state
  sha. 비교 입력은 전부 현존, 비교 리포트 형식은 판정 필요 (§5 판정 3).
- 4층: 미정. 항목 5의 교훈 집계가 후보이나 본 사양 범위 밖 — 판정 필요 (§5 판정 4).

## §3 저장 위치·파일 형식 (`.procforge/` 아래, 불변 목록 준수)
- `runs/<runId>/{state.json,log.ndjson,report.json,children.json,
  cancel.json,accumulate.json,fs/,scripts/}` — 현행 유지, 행 수 요약만 추가.
- `procedures/<name>/{procedure.json,state.json,approvals.json,approved/,
  scripts/,tests/}` — 현행 유지. 재finalize 시 sidecar 보존이 §4 대상.
- `.procforge/state/<절차>/` + `by-session/` + `sessions/<sid>/{events.jsonl,
  cassettes/,nodes/}` — 현행 유지.
- 불변 준수: `pf_*` 명칭·`procforge-local`·토큰 헤더·`.procforge` 루트·
  server.ts:618/app.ts:160 건드리지 않음.

## §4 구현 커밋 분할안

### M9-2-1 (최우선) 재finalize sidecar 소실 확정 — 코드 판독 결과 (수정 없음)
- 소실 위치: `packages/local/src/services/procedureWriter.ts:21-44` (swapDir,
  디렉터리 전체 교체) + `:188-289` (빌드물=procedure.json·PROCEDURE.md·
  SKILL.md·command.md·tests/·scripts/만).
- ① 절차서 폴더 `state.json`: 누적 KV 상태 맞음
  (`services/procedure-state.ts:9`, 성공 종료 시 원자 저장 `run.ts:755`,
  다음 실행 로드 `run.ts:292-297`). 재finalize 시 실제로 사라지는 경로임
  (빌드물에 없음 → swap 후 소멸).
- ② `.run.lock`: 실행 중 재finalize가 막히지 않음. `app.ts` 확정 경로
  (`finalize`·UI·MCP·CLI 모두 `app.finalize` 경유)에 `.run.lock` 검사 없음
  (acquire는 `run.ts:319-335` runSession만). 허용되므로 Windows에서는
  swap rename이 잠금 파일에 걸려 `io_error`로 finalize가 실패하거나,
  성공 시 실행 중 run은 `.old` 쪽을 계속 붙잡는다.
- ③ approvals: 사라지면 재승인 요구로 안전함. `loadApprovals`는 파일 없으면
  `[]` 반환 (`services/approvals.ts:225`). 무인 실행은 빈 목록=external 전부
  거부 (`run.ts:298-301` + 승인 게이트) — fail-closed. 단 수동 재승인 비용 발생.

- M9-2-1 행 수 기록: `csv_rows` 등 산출물 요약을 report에 기록.
  테스트: ① 누적 CSV 2회 실행 행 수 증가 기록 (m7-accumulate 확장).
- M9-2-2 재finalize sidecar 보존: approvals.json·state.json 유지,
  없으면 재생성 안내. 테스트: ① 재finalize 후 approvals 잔존 ② state 잔존.
- M9-2-3 절차서별 latest 인덱스: `by-procedure/<name>/latest.json`.
  테스트: ① 2회 실행 후 latest가 2회차 runId.
- M9-2-4 문서: DEV-GUIDE §8 M9-2 [x] + 본 사양 §5 판정 반영.
- (조건부, M9-2-0-guard 결과에 따라) --out 통합 회귀 1건은 M9-2-1에 포함
  가능 — 판정 필요 (§5 판정 5).

## §5 판정 필요 목록
1. 행 수 기록 위치 — A안: `report.json` results[]에 필드 추가.
   B안: `runs/<runId>/metrics.json` 별도. 추천: B안
   (report 스키마·JUnit 변환·기존 판독 코드 영향 최소).
2. `accumulate`·`stateWrites` 선언의 finalize 지원 — A안: finalize가 세션에서
   추론해 생성. B안: 수동 선언 + 문서. 추천: B안 (추론 오선언이 누적 오염으로
   직결, M7-5-a/b 수준의 검증 비용이 큼).
3. 3층 비교 리포트 형식 — A안: 기존 report.json 재사용.
   B안: `compare` 전용 출력. 추천: A안 (재사용 메모리 조회 1회로 충분).
4. 4층(교훈 집계) 범위 — A안: M9-2 포함. B안: 별도 마일스톤.
   추천: B안 (attempt 해시 미기록 등 선행 작업이 별도 커밋급).
5. guard 회귀 1건의 소속 — A안: M9-2-1에 포함. B안: M9-tmp-2-fix 후속으로
   분리 커밋. 추천: A안 (같은 accumulate 경로, 테스트 1건).
