# M12-0-spec — events 로그 회전 사양 초안 (구현 없음, 조사 + 권장안 없음)

M11-2까지 2차 범위를 닫고, 보류였던 events 회전을 조사한다.

## §0 현황 (단계 0 확인, 파일:행)

- 쓰기 경로는 1곳뿐: `packages/local/src/services/events-log.ts:20` `appendEvent` (주석 `:7` "이 파일의 appendEvent가 유일한 쓰기 경로"). append-only이며 회전이 없다 (`appendFileSync`, `:29`). 경로는 `eventsLogPath` (`events-log.ts:10-11`): `runs/by-procedure/<name>/events.ndjson`. 1줄 형식은 `{v:1, ts, ...}` (`:28`).
- 읽는 쪽은 2곳이며 둘 다 파일 전체를 읽는다: `lessons-agg.ts:46` `readFileSync(...)` 후 `:56` 줄 단위 순회, `procedure-progress.ts:49` `readFileSync(...)` 후 `:54` 줄 단위 순회. 스트리밍·뒤에서 읽기가 아니다.
- 실파일: 이 PC에 `events.ndjson`은 0건이다 (검색: repo 전체, `F:/pf-dogfood*`·`F:/pf-m8-*` 7곳, `F:/pf-tmp`, workspace, home·Documents·Desktop). `by-procedure` 디렉터리는 3곳에 있으나 `latest.json`만 있고(M9-3 이전 실행분), 가장 비슷한 실파일은 run `log.ndjson` 226B ×6 (`F:/pf-dogfood2/3`)이다. 즉 회전 상한을 정할 실측 데이터가 아직 없다.

## §1 회전 방식 2안

### 안 (a) 크기 기준
- 바뀌는 곳: `appendEvent` 쓰기 전 `statSync` 크기 확인. 상한 초과 시 회전 후 append.
- 상한: 바이트 (후보치 예: 1MB — 판정 사항).
- 회전 형태 후보: (a-1) rename (`events.ndjson` → `events.ndjson.1`, 기존 `.1`은 삭제·덮어쓰기) 후 새로 쓰기. (a-2) 앞부분 줄 잘라내기(같은 파일 유지, 앞 N줄 삭제).
- 위험: 읽는 쪽이 회전된 파일을 모른다 — 집계 대상 범위를 정해야 한다(최신 파일만 vs 전부). rename은 원자적이라 읽기 중단이 없으나 구 파일 정리가 필요하고, 잘라내기는 읽기와 쓰기가 겹치면 찢어진 줄이 생길 수 있다. 진행률은 `liveRunIdsFromEvents`가 runId를 못 찾으면 runs 스캔으로 보완하므로(`procedure-progress.ts` 폴백) 참조 끊김에 강하다.

### 안 (b) run 수 기준
- 바뀌는 곳: `appendEvent` + 집계 2곳. `run_end` 개수를 세어 상한 초과분을 앞에서 자른다.
- 상한: run_end 개수 (후보치 예: 최근 50개 run — 판정 사항).
- 위험: `run_end`가 아닌 이벤트(승인·승인 리셋)의 귀속 판단이 필요하다 (경계 run에 딸린 승인 이벤트를 같이 남길지). run 수 세기는 매 append마다 파일을 읽어야 해서 쓰기 경로가 무거워진다 (크기 확인은 stat 1회).

## §2 불변 조건
- 회전 전후에 진행률(`listProcedureProgress`)과 교훈 집계(`aggregate`) 결과가 같아야 한다.
- `results[]` 순서·승인 hash·MCP 도구 21개에는 영향을 주지 않는다.
- 회전은 `appendEvent` 호출 1회를 막거나 실패하게 하지 않는다 (실패 시 stderr 1줄 후 계속 — `events-log.ts:30-37` 현행 유지).

## §3 테스트 후보
- 상한 초과 append 후에도 `aggregate` 결과가 회전 전과 같다 (후보 run 수/크기 경계값 포함).
- 회전된 파일이 있어도 최신 live run 진행률이 그대로 나온다.
- 깨진 줄·빈 파일·없는 파일에서도 읽기가 멈추지 않는다 (현행 관대 읽기 유지).
- 동시 append 중 회전이 일어나도 줄이 찢어지지 않는다.

## §4 범위 밖 (각 1줄)
- `runs/<runId>/report.json`·로그(`log.ndjson`) 회전은 다루지 않는다 (본 사양은 `by-procedure/events.ndjson`만).
- Basic auth 1.18.18 미검증과 m75 잔재 감시는 별도 건으로 유지한다.

## §5 판정 요청 (최대 3개)
1. 회전 방식을 (a) 크기 기준과 (b) run 수 기준 중 어느 것으로 할지 정해 주세요.
2. 상한 값을 정해 주세요 ((a) 바이트 수 또는 (b) run 수, 후보치는 §1 참조).
3. 회전 형태를 정해 주세요 (rename 후 새로 쓰기 vs 앞부분 잘라내기; (a) 선택 시).
