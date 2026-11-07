# M10-dogfood (실측 1회, 사람이 직접 진행)

M10 1차를 닫기 위한 실측 기록지다. 이 문서대로 1회 끝까지 돌리고,
결과 칸을 채워서 판정을 받는다. 자동화(E2E)가 아니라 사람이 한다.

## 0. 환경

- 새 폴더에서 진행한다 (기존 `.procforge/`와 섞지 않는다).
- OpenCode 1.18.18을 serve 모드로 띄운다: `opencode serve --port 4096`.
- 모델은 명시 저비용 모델을 쓴다 (예: `opencode-go/crouton-alpha-free`).
  기본 모델 자동 선택에 맡기지 않는다.
- `proof ui`를 띄우는 터미널에 아래를 설정한다.

```powershell
$env:PROOF_OPENCODE_URL="http://127.0.0.1:4096"
$env:PROOF_OPENCODE_MODE="b"
$env:PROOF_OPENCODE_TOOL_PREFIX="proof"
```

- 업데이트 직후라면 OpenCode와 `proof ui`를 모두 재시작한다
  (구 버전 프로세스가 남으면 잠금이 서로 갈린다).

## 1. 시나리오 4개 (명령과 화면 순서)

### S1. 재분석 → 초안 (prompt_async, 도구 비활성)
1. 절차서가 있는 저장소에서 재분석을 요청한다 (App `createRedraft` 또는 화면).
2. OpenCode 세션에 `prompt_async`로 보내고, 메시지 `tools`를 비활성으로 둔다.
3. `drafts/<draftId>/draft.json`이 생기면 `status`가 `ready`인지 본다.

### S2. 초안 적용
1. M10 확인 탭 → 재분석 diff에 draftId를 넣고 `초안 불러오기`.
2. 항목을 확인하고 `적용`을 누른다.
3. 결과의 "바뀐 노드"와 "다음 실행 때 승인 필요"를 적는다.

### S3. 가이드 2단계 순차 실행
1. M10 확인 탭 → 순차 자동 실행에 절차서 2개를 단계로 쌓고 `가이드 시작`.
2. 1단계 `확인 후 실행` → 끝날 때까지 둔다 (guideId를 적어 둔다).
3. `proof ui`를 재시작하고 같은 guideId를 열어 2단계를 `확인 후 실행`한다.

### S4. 실행 중 재finalize 거부
1. 2단계 실행이 도는 동안 같은 절차서의 재finalize를 시도한다 (409 예상).
2. 실행이 끝난 뒤 `procedures/<이름>/state.json`이 그대로 있는지 본다.

## 2. 통과 기준 5개

| # | 기준 |
|---|---|
| 1 | 재분석 응답은 초안으로만 들어가고, 원본 `procedure.json`의 hash가 그대로임 |
| 2 | 적용 후 재승인을 요구하는 노드가 `approvalReset` 목록과 정확히 일치함 |
| 3 | 가이드 2단계가 같은 guideId로 끝까지 진행되고, 1단계 뒤 `proof ui` 재시작에도 2단계가 이어짐 |
| 4 | 2단계 진행 중 재finalize 시도하면 409로 거부되고, 끝난 뒤 state.json이 보존됨 |
| 5 | 실행이 끝난 뒤 tmp-delta 0, `procedures/.locks/` 잔재 0, OpenCode 비용 합계 기록 |

## 3. 증거 수집 명령

```powershell
# 가이드 파일 (단계별 상태·runId·세션)
Get-Content .procforge\guides\<guideId>.json
# 실행 기록
Get-ChildItem .procforge\runs | Select-Object Name
# 잠금 잔재 (0건이어야 함)
Get-ChildItem .procforge\procedures\.locks -ErrorAction SilentlyContinue
# tmp 증가분 (0이어야 함)
node scripts/tmp-delta.mjs now
```

## 4. 결과 기입 칸 (비워 둠)

- 일시:
- OpenCode 버전·모델·비용 합계:
- S1 초안 draftId·status·원본 hash(전/후):
- S2 바뀐 노드·approvalReset·일치 여부:
- S3 guideId·1단계 runId·재시작 후 2단계 runId:
- S4 재finalize 응답 코드·state.json 보존 여부:
- tmp-delta:
- `.locks/` 잔재:
- 통과/실패 (5개 기준별):
