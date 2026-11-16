# M12-0-spec — events 로그 회전 사양 초안 (구현 없음, 조사 + 권장안 없음)

M11-2까지 2차 범위를 닫고, 보류였던 events 회전을 조사한다.

## §0 현황 (단계 0 확인, 파일:행)

- 쓰기 경로는 1곳뿐: `packages/local/src/services/events-log.ts:20` `appendEvent` (주석 `:7` "이 파일의 appendEvent가 유일한 쓰기 경로"). append-only이며 회전이 없다 (`appendFileSync`, `:29`). 경로는 `eventsLogPath` (`events-log.ts:10-11`): `runs/by-procedure/<name>/events.ndjson`. 1줄 형식은 `{v:1, ts, ...}` (`:28`).
- 읽는 쪽은 2곳이며 둘 다 파일 전체를 읽는다: `lessons-agg.ts:46` `readFileSync(...)` 후 `:56` 줄 단위 순회, `procedure-progress.ts:49` `readFileSync(...)` 후 `:54` 줄 단위 순회. 스트리밍·뒤에서 읽기가 아니다.
- 실파일: 이 PC에 `events.ndjson`은 0건이다 (검색: repo 전체, `F:/pf-dogfood*`·`F:/pf-m8-*` 7곳, `F:/pf-tmp`, workspace, home·Documents·Desktop). `by-procedure` 디렉터리는 3곳에 있으나 `latest.json`만 있고(M9-3 이전 실행분), 가장 비슷한 실파일은 run `log.ndjson` 226B ×6 (`F:/pf-dogfood2/3`)이다.
- run당 바이트 실측 ([M12-1] 단계 0, 가짜 서버 live run 1회·노드 2개): `events.ndjson` 260B, 1줄, 종류별 `{"run_end":1}`. 즉 승인 없는 run은 약 260B/회이며, 1 MiB ≈ live run 약 4000회분이다 (1,000회분을 넘으므로 상한 재판정 불필요).

## §1 회전 방식 2안

### 안 (a) 크기 기준 (채택)
- 바뀌는 곳: `appendEvent` 쓰기 전 `statSync` 크기 확인. 상한 이상이면 회전 후 append.
- 상한: 1 MiB(1,048,576B) 잠정 (상수 1개, 새 env 없음; 테스트는 내부 함수 인자로 주입).
- 회전 형태: rename 1세대 보존 (`events.ndjson` → `events.ndjson.1`, 기존 `.1`은 덮어씀) 후 새로 쓰기. 앞부분 잘라내기는 원자적이지 않아 후보에서 뺀다.
- rename 실패 시: 회전을 건너뛰고 append를 계속하며 stderr에 `[procforge:warn]` 1줄을 남긴다 (읽기·다른 프로세스 잠금으로 EPERM/EBUSY가 날 수 있다).
- 위험: 읽는 쪽이 회전된 파일을 모르면 집계 범위가 달라진다 — 이어 읽기(§2)로 해결한다. 진행률은 `liveRunIdsFromEvents`가 runId를 못 찾으면 runs 스캔으로 보완하므로(`procedure-progress.ts` 폴백) 참조 끊김에 강하다.

### 안 (b) run 수 기준 (보류)
- (a)가 stat 1회로 가볍고 승인 이벤트 귀속 문제를 피할 수 있어 (b)는 보류한다 (run당 바이트 실측으로 (a) 상한 근거 확보).

## §2 불변 조건
- 보존 구간(현재 파일 + `.1`) 안에서 진행률(`listProcedureProgress`)과 교훈 집계(`aggregate`) 결과가 회전 전후에 같다. 교훈 통계는 전역이 아니라 "보존 구간 기준"이며, 구간 밖 오래된 줄은 집계에서 빠진다. 진행률은 최신 live run 하나만 쓰므로 영향이 적다.
- `results[]` 순서·승인 hash·MCP 도구 21개에는 영향을 주지 않는다.
- 회전은 `appendEvent` 호출 1회를 막거나 실패하게 하지 않는다 (rename 실패해도 append는 계속하고 stderr warn 1줄 — `events-log.ts` 쓰기 불변 유지).

## §3 테스트 후보
- 상한 초과 append 후에도 `aggregate` 결과가 회전 전과 같다 (후보 run 수/크기 경계값 포함).
- 회전된 파일이 있어도 최신 live run 진행률이 그대로 나온다.
- 깨진 줄·빈 파일·없는 파일에서도 읽기가 멈추지 않는다 (현행 관대 읽기 유지).
- 동시 append 중 회전이 일어나도 줄이 찢어지지 않는다.
- rename 실패 주입 시에도 append가 성공하고 warn이 1건 남는다.

## §4 범위 밖 (각 1줄)
- `runs/<runId>/report.json`·로그(`log.ndjson`) 회전은 다루지 않는다 (본 사양은 `by-procedure/events.ndjson`만).
- Basic auth 1.18.18 미검증과 m75 잔재 감시는 별도 건으로 유지한다.

## §5 판정 반영 (조건부 채택 확정)
1. 방식은 (a) 크기 기준 — stat 1회로 판정해 쓰기 경로가 가볍다.
2. 상한은 1 MiB(1,048,576B) 잠정 (run당 ~260B 실측 → 약 4000회분, 1,000회분 이상).
3. 형태는 rename 1세대 보존 + 읽는 2곳의 이어 읽기(`.1` 먼저, 현재 파일 나중). rename 실패 시 회전 건너뜀 + append 계속 + warn 1줄.
