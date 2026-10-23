# M8-1-0 — leaf 자기 재검증 (needs_reverify) 사양

상태: **사양 확정 · 구현 전**
관련: M8-1(신호 문구·짝 유지), M8-ui-2(이벤트 detail), DECISIONS `[M8-1-0]`

## 배경

확정된 leaf에 의견(제약)을 추가해도 노드가 `leaf`로 남아 다시 검증되지 않는다.
M7 dogfood(d290)에서 1.3에 `llm_rubric` 3건이 추가됐지만 leaf로 남았다.
즉 "확정 당시의 hash"와 "현재 hash"가 달라졌는데도 확정 상태가 유지된다.

## 목표

확정 이후 leaf의 hash가 바뀌는 쓰기가 생기면 그 노드를 **재검증 대상**으로
표시하고, `pf_next`가 그 노드를 다시 내준다. 재검증은 새 attempt로만 확정할 수
있으며, 재확정 결과는 기존 stale 전파 규칙을 그대로 따른다.

## 범위

### -1. 이 사양 문서
구현 전에 이 문서를 커밋하고 DEV-GUIDE §8 M8-1 행에서 링크한다.

### 0. 현행 보고
leaf에서 `pfAdvise` / `pf_edit_args` / `uiEditArgs` / `uiEditNode` 를 호출했을 때
상태·hash·stale·이벤트가 어떻게 바뀌는지 표로 정리한다.
표가 아래 설계와 모순되면(예: 이미 leaf를 다시 여는 경로) 멈추고 보고한다.

### 1. shared
- `NodeStatus`에 `needs_reverify` 추가. 프로토콜 `v2 → v3`.
- `isResolved`는 `needs_reverify`를 false로 둔다.
- 노드 DTO에
  `reverifySince?: { revision, causeNodeId, cause: "advise" | "edit_args" | "edit_node" }`
  추가.

### 2. core
- leaf 자신의 hash가 바뀌는 쓰기는 **모두 단일 함수**를 거쳐 `needs_reverify`로
  전이하고 이벤트를 남긴다 (`pfAdvise`, `pfEditArgs`, `pfEditNode`).
- 잠긴(locked) leaf에 대한 쓰기는 거절한다.
- hash가 바뀌지 않는 순수 메모(제약을 만들지 않는 조언 등)는 전이하지 않는다.
- 전이와 재확정은 모두 `change()`를 거쳐 `detail.nodesAfter`를 기록한다.
  → `assertReplayMatchesStore`가 자동 검증한다. 별도 저장 경로를 만들지 않는다.

### 3. pfNext
- `needs_reverify` 노드를 ready로 취급해 `probing`으로 전환하고 반환한다.
- `retriesLeft`는 기본값으로 리셋한다. attempt 이력은 유지한다.

### 4. pf_confirm_leaf
- `reverifySince.revision` 이후의 attempt만 허용한다.
- 옛 golden attempt면 `bad_request`와 함께
  "재검증 필요: 새 pf_report 후 confirm" 힌트를 준다.

### 5. finalize
- `needs_reverify` 노드가 하나라도 있으면 거절한다.
- 재확정 후 finalize할 때는 approvals에서 해당 노드 hash 갱신과 재승인이
  필요하다고 안내한다.
- 재확정으로 hash가 바뀌면 기존 `propagateStale`로 하류에 전파한다.
  바뀌지 않으면 전파하지 않는다.

### 6. previewEdit / UI
- `previewEdit`는 대상이 leaf이면 `selfReverify: true`를 반환한다.
- UI 트리에 `needs_reverify` 상태색·라벨·필터를 추가한다(상태색 의미는 고정).
- 분해 타임라인(`getDecompositionHistory`)에서 "의견 → 재검증 → 재확정"을
  해당 노드 아래 이벤트로 표시한다.

### 7. 테스트 (3 client 모드)
(a) leaf에 advise → needs_reverify → pf_next가 그 노드 반환 → 옛 attempt로
confirm 거절 → 새 report로 재확정 → done
(b) 재확정으로 hash가 바뀌면 하류만 stale, 안 바뀌면 전파 없음
(c) needs_reverify가 있으면 finalize 거절
(d) locked leaf 거절
(e) 순수 메모는 상태 불변
(f) E2E: 사유 패널에서 leaf에 의견 → 재검증 배지 → 가짜 모델의 새 report·confirm
→ 타임라인에 이벤트 3개

### 8. docs
- DECISIONS `[M8-1-0]` 1행.
- `docs/M5.8-opencode-e2e.md`의 하류 stale 항목에 "자기 재검증은 M8-1-0" 주석 1행.
- **마이그레이션 없음**: 기존 leaf를 자동으로 전이시키지 않는다(d290 1.3 포함).

## 완료 보고

- 항목별 커밋표
- CI run 번호·`head_sha` 일치·7잡 green
- 스크린샷 4장: 입력 화면 / 3단 전체 / 라운드 클릭 / 재검증 표시
