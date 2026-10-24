# M8-1-0 — leaf 자기 재검증 (needs_reverify) 사양

상태: **구현 완료 (2026-10-24)**
관련: M8-1(신호 문구·짝 유지), M8-ui-2(이벤트 detail), DECISIONS `[M8-1-0]`

## 결정 (2026-10-24)

항목 0 보고에서 `pf_edit_args`(항상 leaf→open)와 `pf_edit_node`의 goal 변경
(leaf→open)이라는 기존 재개 경로 2개를 확인했다. 아래와 같이 통일한다.

- **세 경로 모두 `needs_reverify`로 통일**: `pfAdvise`, `pfEditArgs`,
  `pfEditNode`가 leaf의 hash를 바꾸면 `needs_reverify`로 전이한다.
  기존 `leaf→open` 단언은 `open→needs_reverify`로 수정하고 커밋 메시지에
  `파일:테스트명 — open→needs_reverify`로 나열한다. 테스트는 삭제하지 않는다.
- **hash 불변이면 전이 없음** (`edit_args` 포함). leaf는 leaf로 남는다.
- `needs_reverify`/`probing`에서도 `pf_split`을 허용한다(reason 필수,
  `causeAdvice` 자동 연결). 현재 막혀 있으면 이번 범위에서 연다.
- **stale leaf 직접 수정**: `needs_reverify`가 우선한다. 재확정 시
  `staleSince`도 함께 지운다. 테스트 1건 추가.
- **split/open 노드 수정 동작은 바꾸지 않는다.**
- `status === "open"`을 참조하는 코드는 grep으로 찾아 보고한다.

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

## 구현 결과 (2026-10-24)

| 항목 | 결과 | 근거 |
| --- | --- | --- |
| 1 shared | `needs_reverify` 상태·`reverifySince`·`previewEdit.selfReverify`·프로토콜 v3 | `packages/shared/src/{schema,dto,core-client,wire}.ts` |
| 2 core | `withLeafReverify()` 단일 경로(advise/edit_args/edit_node) + 잠금 거절 | `packages/core/src/service.ts` |
| 3 pfNext | `needs_reverify` → ready → `probing`(retries 리셋, attempt 유지) | `pfNext()` |
| 4 pfConfirmLeaf | `reverifySince.revision` 이후 attempt만 허용, 재확정 시 `staleSince` 삭제 | `pfResolve()` 가드 |
| 5 finalize | `needs_reverify` 있으면 거절 + "재승인 필요" 경고(승인 hash 비교) | `packages/local/src/app/app.ts` |
| 6 previewEdit/UI | `selfReverify` 반환 + 상태색·라벨·필터 + 타임라인 이벤트 | `packages/ui/src/*` |
| 7 테스트 | core 8건(`m8-reverify.test.ts`)·local 6건 반영·E2E 1건 | `packages/local/test-e2e/m8-1-reverify.spec.ts` |
| 8 docs | DECISIONS `[M8-1-0]` 7행 + M5.8 주석 | `docs/DECISIONS.md` |

### 알아둘 점

- `causeAdviseIds`(이벤트 상세 키)는 코드베이스 전체가 `causeAdviseIds` 철자를 쓴다.
  분해 원인이 된 조언 id 목록은 이 키에 담긴다(별칭 없음).
- 기존 단언 변경(leaf→open ⇒ needs_reverify)은 커밋 메시지에
  `파일:테스트명 — open→needs_reverify` 형식으로 적었다. 테스트 삭제는 없다.

### 항목별 커밋표

| 커밋 | 내용 |
| --- | --- |
| `d2b0681` | [M8-1-0-spec] 사양 문서 + DEV-GUIDE 링크 |
| `1101783` | [M8-1-0-1] shared: needs_reverify 상태·reverifySince·분해 이벤트 DTO·wire v3 |
| `3551555` | [M8-1-0-2] core: 자기 재검증 전이·가드·pfNext·타임라인 이벤트 |
| `d020418` | [M8-1-0-3] core: 재검증 시나리오 테스트 8건 |
| `e716e5a` | [M8-1-0-4] local: finalize 거절·재승인 경고·러너 재실행 대상 |
| `f126f64` | [M8-1-0-5] local: 기존 leaf→open 단언을 needs_reverify로 변경 |
| `f492787` | [M8-1-0-6] ui: 상태색·라벨·필터 + 타임라인 이벤트 표시 |
| `163581d` | [M8-1-0-7] e2e: leaf 의견→재검증 배지→재확정→타임라인 |
| `161e231` | [M8-1-0-8] docs: DECISIONS [M8-1-0] + M5.8 주석 + 사양 상태 |
| `4ecd750` | [M8-1-0-9] docs: UI 스크린샷 4장 |

### 검증

- 로컬: shared 76 / core 116 / local 477(+2 skip) 통과, E2E 15건 통과
  (신규 `m8-1-reverify.spec.ts` 1건 포함).
- CI: run `40073225619` (head_sha `161e231`) 7잡 green —
  build-test 4(inprocess/loopback × ubuntu/windows) + remote-mode 2 + e2e 1.
- 스크린샷: `docs/ui-shots/m8-1-0-1-token.png` · `m8-1-0-2-rounds.png` ·
  `m8-1-0-3-round-selected.png`(라운드 클릭 → 의견/실행/재확정 3이벤트) ·
  `m8-1-0-4-reverify.png`(재검증 배지·안내·필터).
