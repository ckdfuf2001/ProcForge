# M13-0-spec2 — 취소 run의 기록 정확성 (M13-0 판정 반영)

## §0 현황 (단계 0 실측, 파일:행)

- 취소 경로 순서 (코드 원문 위치):
  1. 자식 kill + 플래그: `cancelRun` (`packages/local/src/app/run-control.ts:117`), `writeCancelFlag` (`:122`) 후 등록된 자식마다 `killProcessTree` (`:126-130`). 호출자는 `uiRunCancel` (`packages/local/src/app/app.ts:3553`, 호출 `:3572`).
  2. `markCancelled` (`app.ts:4522`): `status: "cancelled"` 기록 + `finishRun` (`:4547`). 호출 지점: uiRunCancel의 대기 분기 (`:3575-3577`), driveRun의 취소 플래그 확인 (`:4311`, `:4316`, `:4361`), 재개 경로의 취소 확인 (`:4576-4578`).
  3. 노드 결과 기록: 스크립트 취소는 `close`에서 `reject("취소됨", {code:"cancelled"})` (`packages/local/src/runner/script-run.ts:257-260`). 이 reject는 runSession 메인 루프의 catch (`packages/local/src/runner/run.ts:575-587`)에 걸려 노드가 `status: "fail"`로 기록된다. 이것이 결함이다. M13-1 (`f1674a0`)에서 `isCancelReject` 공용 판정과 catch 3곳 수정으로 고쳤다.
  4. `finishRun` (`app.ts:4547`)과 `finalRunStatus` (`run.ts:236-244`, `cancel.json` 있으면 `"cancelled"`).
- 실측 (단계 0, 임시 테스트 1회, 실측 후 삭제): 시작 직후 취소 1회 — 취소 시점 `children.json`은 비어 있었고(`[]`), 취소 응답은 `cancelled:true`·`killed:[]`·`failed:[]`, 최종 상태는 `cancelled`였다. 그러나 노드 `1.1`은 `status: "fail"`(`detail`은 "취소됨")로 기록됐다. run은 cancelled, 중단 노드는 fail — 불일치(결함).
- 잔재 `pf-cancel-e2e-ROL7dH`(os.tmpdir())는 단계 0에서 경로·mtime 확인 후 삭제했다.

## §1 기대 동작

- 사용자가 취소했으면 run과 **중단된 노드**를 `cancelled`로 기록한다. 즉 `runSession` 메인 루프 catch (`run.ts:575-587`)에서 `code === "cancelled"`인 reject는 노드 `status: "cancelled"` (detail은 기존 메시지 "취소됨" 유지)로 기록한다. 판정은 `isCancelReject` (`types.ts:79-85`) 공용 함수 하나로 수행한다.
- 취소된 run과 노드는 교훈 집계(`aggregate`)와 진행률에서 실패로 세지 않는다. 정정: `AGG_MODES` (`lessons-agg.ts:10`)는 mode(`live`) 필터이며 상태 필터가 아니다. cancelled 제외는 fail 집계 조건 (`lessons-agg.ts:83`, `rn.status === "fail"`만 셈)에서 수행한다. 평균은 현행대로 `done` run의 `pass` 노드만으로 계산한다 (`:85`). 진행률은 `pass`만 완료로 센다 (`procedure-progress.ts:225`) — cancelled는 미완료로 둔다.
- 이미 끝난 형제 노드의 기록은 바꾸지 않는다. waiting 중 취소는 현행(`markCancelled`)을 유지한다.
- map/until 자식 항목이 취소되면 해당 map/until 노드를 `cancelled`로 기록한다 (`fail`이 아니다).
- 취소 뒤 실행하지 않은 노드는 기록을 추가하지 않는다 (`results[]`에 없음).
- JUnit 변환 (`run.ts:157-166`)에서 `cancelled`는 실패가 아닌 skipped로 매핑한다.
- UI에서는 cancelled 노드를 "취소됨"으로 표시한다 (`RunPanel.tsx:391`).

## §2 불변 조건

- 취소하지 않은 run의 기록은 바뀌지 않는다 (정규화 비교: runId·at·durationMs 제외).
- `cancel.json`이 있으면 최종 상태는 `cancelled`다 (`run.ts:236-244` 현행 유지).
- MCP 도구 21개와 events 스키마(`{v:1, ts, ...}`)는 그대로 둔다. MCP 도구 21개 (`server.ts:58-80`)는 노드 상태를 직접 다루지 않으므로 변경 없다. 읽는 쪽은 모르는 status를 실패로 세지 않는다 (`aggregate`는 `status === "fail"`만 셈, `lessons-agg.ts:83`; 진행률은 `pass`만 완료로 셈, `procedure-progress.ts:225`).
- `NodeResultStatus` 사용처 전체: 정의 `packages/local/src/runner/types.ts:52-62` (상태 필드 `:66`, 판정 함수 `isCancelReject` `:79-85`); 기록·집계 `packages/local/src/runner/run.ts:157-166` (toJUnit), `:575-587` (catch), `:662-670` (summary), `:695` (run_end nodes), `:751-763` (승인 병합); 누적 `packages/local/src/app/app.ts:4724-4737` (pass/failed 판정), `:4800` (미완료 필터); 집계 `packages/local/src/services/lessons-agg.ts:83,85`; 진행률 `packages/local/src/services/procedure-progress.ts:221,225`; 상태 `packages/local/src/services/run-state.ts:27` (string); UI `packages/ui/src/api.ts:185,196`, `packages/ui/src/RunPanel.tsx:23,301,378-391`; 공유 `packages/shared/src/report.ts:84` (selfVerdict, 노드 상태와 무관).

## §3 테스트 후보

- 실행 중 취소: run_end `cancelled` + 중단 노드 `cancelled` + `cancel.json` 존재 (sleep 노드, 3회 반복).
- 시작 직후 취소: 같은 단언 3회 (노드 미시작이어도 `fail`이 남지 않는다).
- 취소 없는 정상 run은 기존대로 `done`/`fail`이 그대로다 (정규화 비교 회귀: runId·at·durationMs 제외).
- 교훈 집계의 실패 수가 0 (취소 run).
- 주입 검증: catch 분기를 되돌리면 중단 노드가 다시 `fail`이 되는지 1회 확인한다.

## §4 범위 밖 (각 1줄)

- Basic auth 1.18.18 미검증은 별도 건으로 둔다.
- m75 잔재(단독 재현 불가, L3 첫 diff 감시)는 별도 건으로 둔다.

## §5 판정 확정 (M13-0 판정 반영)

1. 중단 노드를 `cancelled`로 기록한다 (타입에 값 추가 허용).
2. detail 문구("취소됨")는 현행 유지한다.
3. waiting 중 취소는 현행(`markCancelled`)대로 둔다.
