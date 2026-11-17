# M13-0-spec — 취소 run의 기록 정확성 (사양만, 구현 없음)

M12-1-fix 판정의 사용자 질문에 답이 없어 기본값 (a)로 진행한다.

## §0 현황 (단계 0 실측, 파일:행)

- 취소 경로 순서 (코드 원문 위치):
  1. 자식 kill + 플래그: `cancelRun` (`packages/local/src/app/run-control.ts:117`), `writeCancelFlag` (`:122`) 후 등록된 자식마다 `killProcessTree` (`:126-130`). 호출자는 `uiRunCancel` (`packages/local/src/app/app.ts:3572`).
  2. `markCancelled` (`app.ts:4522`): `status: "cancelled"` 기록 + `finishRun`. 호출 지점: uiRunCancel의 대기 분기 (`:3577`), driveRun의 취소 플래그 확인 (`:4311, :4316, :4361`), 거부 경로 (`:4577`).
  3. 노드 결과 기록: 스크립트 취소는 `close`에서 `reject("취소됨", {code:"cancelled"})` (`packages/local/src/runner/script-run.ts:259-260`). 이 reject는 runSession 메인 루프의 catch (`packages/local/src/runner/run.ts:572-582`)에 걸려 노드가 `status: "fail"`로 기록된다.
  4. `finishRun` (`app.ts:4468`)과 `finalRunStatus` (`run.ts:236-237`, `cancel.json` 있으면 `"cancelled"`).
- 실측 (임시 테스트, 2케이스 × 3회, 실측 후 삭제): sleep 노드 실행 중 취소와 run 시작 직후 취소 모두 6회 전부 `run_end=cancelled`, `cancel.json` 존재, `state.json` `cancelled`, 최종 `cancelled`다. 단, 중단된 노드는 6회 모두 `fail`로 기록됐다 (run은 cancelled, 노드는 fail — 불일치).
- ui-wait-2 잔재(run_end `failed`, `cancel.json` 없음)는 취소 경로와 다르다: 취소됐으면 `cancelled`로 기록되므로, 해당 run은 driveRun이 취소와 무관하게 독자 실패한 것이다 (또는 driveRun이 한 스텝도 실행하지 못한 경우 — m75 잔재와 같은 조사선).

## §1 기대 동작
- 사용자가 취소했으면 run과 **중단된 노드**를 `cancelled`로 기록한다. 즉 `runSession` 메인 루프 catch (`run.ts:572-582`)에서 `code === "cancelled"`인 reject는 노드 `status: "cancelled"` (detail은 기존 메시지 유지)로 기록한다.
- 취소된 run과 노드는 교훈 집계(`aggregate`)와 진행률에서 실패로 세지 않는다 (`AGG_MODES`·pass 집계에서 제외, cancelled는 별도 상태로 둔다).
- 이미 끝난 형제 노드의 기록은 바꾸지 않는다. waiting 중 취소는 현행(`markCancelled`)을 유지한다.

## §2 불변 조건
- 취소하지 않은 run의 기록은 바뀌지 않는다.
- `cancel.json`이 있으면 최종 상태는 `cancelled`다 (`run.ts:236-237` 현행 유지).
- MCP 도구 21개와 events 스키마(`{v:1, ts, ...}`)는 그대로 둔다.

## §3 테스트 후보
- 실행 중 취소: run_end `cancelled` + 중단 노드 `cancelled` + `cancel.json` 존재 (sleep 노드, 3회 반복).
- 시작 직후 취소: 같은 단언 3회 (노드 미시작이어도 `fail`이 남지 않는다).
- 취소 없는 정상 run은 기존대로 `done`/`fail`이 그대로다 (회귀).
- 주입 검증: catch 분기를 되돌리면 중단 노드가 다시 `fail`이 되는지 1회 확인한다.

## §4 범위 밖 (각 1줄)
- Basic auth 1.18.18 미검증은 별도 건으로 둔다.
- m75 잔재(단독 재현 불가, L3 첫 diff 감시)는 별도 건으로 둔다.

## §5 판정 요청 (최대 3개)
1. 중단 노드를 `cancelled`로 기록하는 §1 안을 채택하는지 판정해 주세요.
2. detail 문구("취소됨")는 현행 유지를 제안합니다. 바꿀 문구가 있으면 알려 주세요.
3. waiting 중 취소의 현행 유지를 확정해 주세요.
