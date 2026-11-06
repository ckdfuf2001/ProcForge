# M9-2-spec 초안 — 실행 기록 재사용 메모리 (읽기 조사 기반)

> 구현 착수 조건: 승인됨 (판정자, 3c79890).
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

### M9-2-1 재finalize 안전
- 배경 (소실 확정, 코드 판독): `packages/local/src/services/procedureWriter.ts:21-44`
  (swapDir, 디렉터리 전체 교체) + `:188-289` (빌드물만).
  ① 절차서 폴더 `state.json`은 누적 KV 상태 (`procedure-state.ts:9`,
  `run.ts:755` 저장·`run.ts:292-297` 로드)이나 빌드물에 없어 swap 후 소멸.
  ② `.run.lock` 검사가 `app.finalize` 경로에 없어 실행 중 재finalize 허용
  (acquire는 `run.ts:319-335`만). Windows rename 경합 시 finalize `io_error`
  실패 또는 실행 중 run이 `.old` 쪽을 계속 붙잡음.
  ③ approvals 소실 시 `loadApprovals`→`[]` (`approvals.ts:225`) → 무인 실행
  external 전부 거부 (`run.ts:298-301`) — fail-closed, 수동 재승인 비용만 발생.
- 구현: finalize 시작 시 `.run.lock` 검사(살아 있는 run 보유 시 거부) +
  swap 직전 state.json·approvals.json·approved/ 복사(.run.lock 제외) +
  hash 불일치 항목 무효 유지.
- 테스트(`m92-refinalize.test.ts`): ① state.json 동일 ② 미변경 노드 approvals
  유효 ③ args 변경 노드 승인 무효+무인 거부 ④ lock 보유 중 거부·무손상
  ⑤ stale lock이면 허용.
### M9-2-2 metrics.json (`runs/<runId>/metrics.json`)
- `{ runId, procedure, at, nodes: [{ nodeId, files: [{ path, rows }] }] }`.
  산출 CSV만 `csv_rows` 계산 함수 재사용. 계산 실패는 rows 생략+사유, run 무영향.
  report.json·JUnit 불변.
- 테스트: ① 2회 실행 2회차 rows > 1회차 ② CSV 없는 노드는 files 빈 배열.
### M9-2-3 절차서별 latest 인덱스
- `.procforge/runs/by-procedure/<name>/latest.json` = `{ runId, status, at }`.
  종료 상태(done/failed/cancelled)일 때만 원자 갱신.
- 테스트: ① 2회 실행 후 latest=2회차 runId ② 취소 run도 기록.
### M9-2-4 문서
- DEV-GUIDE accumulate·stateWrites 수동 선언 절(monthly 예시 1개) +
  PROCEDURE-FORMAT metrics.json·latest.json 형식 (procedure.json 불변) +
  DECISIONS [M9-2] 판정 5건 + §8 M9-2 [x] (CI 확인 후 별도 docs 커밋).

## §5 판정 기록 (판정자 확정)
1. 행 수 기록 위치 — **B 확정** (`metrics.json` 별도).
2. `accumulate`·`stateWrites` finalize 지원 — **B 확정** (수동 선언 + 문서).
3. 3층 비교 리포트 형식 — **A 확정**, 기록까지만 (기존 report.json 재사용).
4. 4층(교훈 집계) 범위 — **B 확정** (M9-3 후보).
5. guard 회귀 소속 — 해당 없음 (`613a935`로 이미 커밋됨).
