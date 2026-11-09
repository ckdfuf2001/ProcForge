# M10-dogfood (실측 1회, 사람이 직접 진행)

M10 1차를 닫기 위한 실측 기록지다. 이 문서대로 1회 끝까지 돌리고,
결과 칸을 채워서 판정을 받는다. 자동화(E2E)가 아니라 사람이 한다.
명령은 전부 그대로 복사해 쓸 수 있다. 자리표시자는 `<...>`로만 둔다.

## 0. 준비 (절차서 2개 + 승인 시드)

새 폴더에서 진행한다 (기존 `.procforge/`와 섞지 않는다).
`Set-Content`는 한글 JSON을 ANSI로 깨뜨리므로 쓰지 않는다.
아래는 BOM 없는 UTF-8로 쓴다 (`[IO.File]::WriteAllText`).

```powershell
$PF = "$PWD\.procforge"
$env:PROOF_OPENCODE_URL="http://127.0.0.1:4096"
$env:PROOF_OPENCODE_MODE="b"
$env:PROOF_OPENCODE_TOOL_PREFIX="proof"
$utf8 = New-Object Text.UTF8Encoding $false
New-Item -ItemType Directory -Force "$PF\procedures\dog-a" | Out-Null
New-Item -ItemType Directory -Force "$PF\procedures\dog-b\scripts" | Out-Null
[IO.File]::WriteAllText("$PF\procedures\dog-a\procedure.json", '{"format":"procforge-procedure","version":1,"name":"dog-a","sourceSession":"s","createdAt":"2026-11-07T00:00:00.000Z","params":{},"toolCatalog":[],"tree":{"rootId":"1","nodes":[]},"nodes":[{"id":"1","parentId":null,"goal":"월간보고서 완성","depth":0,"children":["1.1"],"dependsOn":[],"sideEffect":"none","constraints":[]},{"id":"1.1","parentId":null,"goal":"데이터 수집","depth":1,"children":[],"dependsOn":[],"sideEffect":"none","constraints":[]}]}', $utf8)
[IO.File]::WriteAllText("$PF\procedures\dog-b\procedure.json", '{"format":"procforge-procedure","version":1,"name":"dog-b","sourceSession":"s","createdAt":"2026-11-07T00:00:00.000Z","params":{},"toolCatalog":[],"tree":{"rootId":"1","nodes":[]},"nodes":[{"id":"1","parentId":null,"goal":"야간 집계","depth":0,"children":["1.1"],"dependsOn":[],"sideEffect":"none","constraints":[]},{"id":"1.1","parentId":null,"goal":"60초 대기 후 집계","depth":1,"children":[],"dependsOn":[],"sideEffect":"external","tool":{"server":"t","name":"sh","schemaHash":"h"},"args":{"script":{"kind":"script","file":"scripts/wait60.py","runtime":"python"}},"constraints":[]}]}', $utf8)
[IO.File]::WriteAllText("$PWD\wait60.py", "import time, json`ntime.sleep(60)`nprint(json.dumps({`"done`": true}))", $utf8)
Copy-Item "$PWD\wait60.py" "$PF\procedures\dog-b\scripts\wait60.py"
```

OpenCode 1.18.18을 serve 모드로 띄운다: `opencode serve --port 4096`.
모델은 명시 저비용 모델을 쓴다 (예: `opencode-go/crouton-alpha-free`).
업데이트 직후라면 OpenCode와 `proof ui`를 모두 재시작한다
(구 버전 프로세스가 남으면 잠금이 서로 갈린다).

같은 셸(또는 새 셸, 같은 폴더)에서 UI를 띄운다:

```powershell
node <REPO>\packages\local\dist\cli.js ui
```

`ui: http://127.0.0.1:<포트>/#t=<토큰>` 1줄이 찍히면 브라우저로 연다.
`<포트>`와 `<토큰>`은 이 줄에서 읽는다 (아래 명령은 프로젝트 폴더 셸에서 실행한다).

`dog-b`의 1.1(script 노드)에 승인 항목을 미리 만든다
(기준 2 "목록 1개 이상"을 만족하려면 항목이 있어야 한다).

```powershell
node <REPO>\packages\local\dist\cli.js approve dog-b --node 1.1
```

`<REPO>`는 Proof 체크아웃 경로다. 성공하면 아래 1줄이 찍힌다
(hash 앞 12자는 환경마다 다르다).

```text
approved: 1.1 (hash ab6e201fb165…) → <저장소>\procedures\dog-b\approvals.json
pattern: {}
```

S1 전에 원본 hash를 잰다 (S1이 원본을 안 건드리는지 대조용).

```powershell
Get-FileHash .procforge\procedures\dog-b\procedure.json
```

## 1. S1. 재분석 요청 (버튼 또는 curl)

화면: M10 확인 탭 → 불러온 메모리에서 절차서를 고르고(`dog-b` 검색),
재분석 요청문에 아래를 그대로 적고 [재분석 요청]을 누른다.
(`dog-b` 1.1은 script 노드라서, goal이 바뀌면 기준 2의 목록에 들어간다.)

```text
1.1의 goal을 "야간 집계 (60초 대기)"으로 바꿔라
```

또는 `curl` 한 줄 (토큰은 `proof ui`가 출력한 URL의 `#t=` 뒤 문자열).
본문은 UTF-8 바이트로 보낸다 (`-Headers`의 content-type 문자열이 아니라
`-ContentType`을 쓴다).

```powershell
$TOKEN = "<토큰>"
$BODY = '{"procedure":"dog-b","request":"1.1의 goal을 \"야간 집계 (60초 대기)\"으로 바꿔라"}'
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:<포트>/api/drafts" -Headers @{"x-procforge-token"=$TOKEN} -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($BODY))
```

도구 비활성은 코드가 보장한다 (`tools: {"*": false}`로 전송).
사람이 확인하는 방법은 재분석 세션의 메시지를 받아 tool part가 0건인지 본다.
draft 조회 응답의 `openCodeSessionId`를 `<SES>`에 넣어 실행한다.

```powershell
node -e "const b='http://127.0.0.1:4096',s='<SES>';(async()=>{const m=await(await fetch(b+'/session/'+s+'/message')).json();const arr=Array.isArray(m)?m:(m.data??[]);let n=0;for(const x of arr){if(x?.info?.role==='assistant')for(const p of (x.parts??[]))if(p.type!=='text')n++;}console.log('tool_parts='+n)})()"
```

`POST /api/drafts`는 202를 즉시 돌려주고 백그라운드에서 완성한다.
메모리 패널에 "초안 대기 중"이 떴다가 "초안 준비됨"으로 바뀌면,
재분석 diff 패널에 diff가 보인다. 실패하면 원문 메시지가 표시된다.

## 2. S2. 초안 적용 (hash·목록 확인)

적용 전에 현재 hash를 잰다 (S1 직후와 같아야 한다 — 같지 않으면
S1이 원본을 건드린 것이므로 중단하고 보고한다).

```powershell
Get-FileHash .procforge\procedures\dog-b\procedure.json
```

재분석 diff 패널에서 항목을 확인하고 [적용]을 누른다.
적용 뒤에 hash를 다시 잰다 (바뀌어 있어야 한다).

적용 결과의 "다음 실행 때 승인 필요" 목록을 적는다.
목록이 비어 있으면 실패다 — script 노드의 goal을 바꾼 요청이므로
`1.1`이 정확히 1개 들어 있어야 통과다 (목록 == 재승인 요구 노드).

## 3. S3. 가이드 2단계 순차 실행 (재시작 포함)

1. M10 확인 탭 → 순차 자동 실행에 `dog-a`, `dog-b`를 단계로 쌓고
   [가이드 시작]을 누른다. guideId를 적어 둔다.
2. 1단계를 [확인 후 실행]으로 끝까지 돌린다 (`done`).
3. `proof ui`를 재시작하고 같은 guideId를 열어 2단계를 [확인 후 실행]한다.
   2단계는 약 60초 돈다 (S4는 이 사이에 한다).
4. 2단계가 `done`이 되면 끝이다.

## 4. S4. 실행 중 재finalize 거부

2단계(`dog-b`)가 도는 동안 그 절차서의 재finalize를 시도한다.
재finalize 경로는 MCP `pf_finalize`뿐이다 (UI 버튼·CLI·HTTP 경로 없음).
OpenCode 대화창에서 `pf_finalize`를 절차서 `dog-b`로 호출한다.

- 실행 중이면 거부된다. MCP 응답의 에러 코드가 `conflict`인지 확인한다.
- 끝난 뒤 `procedures/dog-b/state.json`이 그대로인지 본다.
  (없던 파일이면 생기지 않은 채 그대로다.)
- `curl`로는 할 수 없다 (해당 HTTP 경로가 없다).

## 5. 통과 기준 5개

| # | 기준 |
|---|---|
| 1 | 재분석 응답은 초안으로만 들어가고, 준비 직후 hash와 S1 직후 hash가 같음. tool part 0건 |
| 2 | 적용 후 재승인을 요구하는 노드가 `approvalReset` 목록과 정확히 일치하고, 목록이 1개 이상임 (`1.1`) |
| 3 | 가이드 2단계가 같은 guideId로 끝까지 진행되고, 1단계 뒤 `proof ui` 재시작에도 2단계가 이어짐 |
| 4 | 2단계 진행 중 재finalize 시도하면 `conflict`로 거부되고, 끝난 뒤 state.json이 보존됨 |
| 5 | 실행이 끝난 뒤 tmp-delta 0, `procedures/.locks/` 잔재 0, OpenCode 비용 합계 기록 |

## 6. 증거 수집 명령

```powershell
# 시작 전에 스냅샷 (끝나고 diff)
node scripts/tmp-delta.mjs snap F:\pf-tmp\dogfood.json
# 가이드 파일 (단계별 상태·runId·세션)
Get-Content .procforge\guides\<guideId>.json
# 실행 기록
Get-ChildItem .procforge\runs | Select-Object Name
# 잠금 잔재 (0건이어야 함)
Get-ChildItem .procforge\procedures\.locks -ErrorAction SilentlyContinue
# 끝나고 증가분 (0이어야 함)
node scripts/tmp-delta.mjs diff F:\pf-tmp\dogfood.json
# OpenCode 비용 합계 (세션 메시지의 cost 합, 없으면 0)
node -e "const b='http://127.0.0.1:4096';(async()=>{const s=await(await fetch(b+'/session')).json();let t=0;const ids=(Array.isArray(s)?s:(s.data??[])).map(x=>x.id??x.sessionID).filter(Boolean);for(const id of ids){try{const m=await(await fetch(b+'/session/'+id+'/message')).json();const arr=Array.isArray(m)?m:(m.data??[]);for(const x of arr){t+=Number(x?.info?.cost??x?.cost??0)}}catch{}}console.log('total_cost='+t)})()"
```

`scripts/tmp-delta.mjs`는 저장소 루트 기준 상대 경로로 실행한다.

## 7. 결과 기입 칸 (2026-11-09 실측 1회, 실행자: 에이전트 — 사용자 대행)

- 일시: 2026-11-09 12:30~13:30 KST (서버 로그 UTC 03:30~04:30)
- OpenCode 버전·모델·비용 합계: opencode 1.18.32 (serve, 포트 4096). 재분석 모델은 제품이 서버 `/config/providers` 첫 default로 고정 → `opencode-go/gpt-5.6-luna` 사용 (편차 D1: 요청 `opencode-go/muse-spark-1.3-contributor`와 다름. 프로젝트 `model` 지정·`disabled:true` 모두 default에 무효임을 확인. muse-spark-1.3-contributor 자체는 prompt_async로 동작 확인, 비용 0.0014). dogfood 본 비용(S1 재분석 1회) 합계 0.00068. 모델 탐색용 probe 2회(0.00281+0.00140)는 측정 외 별도.
- 준비: Set-Content 미사용(node writeFileSync, BOM 없음 3파일 확인) · approve 출력 원문: `approved: 1.1 (hash eb7cd4602b69…) → F:\pf-dogfood\.procforge\procedures\dog-b\approvals.json` / `pattern: {}` · 준비 직후 hash: C507488C5EB2B4C2D563EEB208DC74B63A854644A1057E90A19EDAC0840467BF
- S1 초안 draftId·status·원본 hash(준비 직후/S1 직후)·tool part 수: draftId `04d0e90e-8797-49e6-92ca-04086b7ad50c`, status ready(15초 내, ops 1: edit_goal 1.1→"야간 집계 (60초 대기)"). 준비 직후 hash = S1 직후 hash = C507… (불변 ✓). tool-invocation 0건 (step-start/reasoning/step-finish 마커 외 호출 없음; openCodeSessionId `ses_e418632d3ffe5ar8u1MC2gZYKo`).
- S2 바뀐 노드·approvalReset·일치 여부(1개 이상)·적용 후 hash: applied 1.1(goal), changedNodes [1.1], approvalReset [1.1] (정확히 1개, 일치 ✓). 적용 후 hash: 8195373D657D0D338D32BB72BBF9B4D0DED38A1D0249659CAC137F8F5296F053 (변경됨 ✓).
- S3 guideId·1단계 runId·재시작 후 2단계 runId·최종 상태: guideId `db097f68-58f1-4167-866f-0a945c863168`. 1단계 runId `888e55ca-…` done. `proof ui` 재시작(63245→63703) 후 동일 guideId 조회: 1단계 done 유지·2단계 pending으로 이어짐 ✓. 2단계: (a) 재승인 없이 진행 → failed, 사유 `approval: 승인 갱신 필요 (노드 1.1 해시 변경)` (run `fa021a32-…`, drive 미기동 31ms — 기록지 S2→S3 재승인 단계 누락 발견). (b) 편차 D2: `approve dog-b --node 1.1` 후 재진행. (c) 60초 수면이 스크립트 기본 타임아웃 60000ms에 걸려 failed (run `27908dd4-…`, `스크립트 타임아웃(60000ms)`). (d) 편차 D3: 1.1 script 스펙에 `timeoutMs: 120000` 추가 후 재승인. (e) 시드 `wait60.py`의 `{"done": true}`가 Python NameError로 failed (run `9bd94579-…`, `name 'true' is not defined` — 시드 자체가 깨진 파이썬). (f) 편차 D4: `True`로 수정 후 재승인 → runId `ae3307cf-…` done (약 61초). 최종 상태: `done:888e… | done:ae3307cf-…`.
- S4 재finalize 경로·응답 코드·state.json 보존 여부: MCP `pf_finalize` 직접 호출(동일 핸들러; OpenCode 대화창 대신, 경로는 MCP로 동일). 실행 중(run `ae3307cf-…`, lock 있음 확인) 호출 결과는 기대 `conflict`가 아니라 `bad_request: 검증 오류 2건: [unknown_tool] 1.1 tool t/sh not in catalog; [children_link] 1 child 1.1 parentId mismatch` — finalize가 검증(pfBuildProcedure)을 잠금 획득보다 먼저 수행하므로, 수기 시드 세션으로는 잠금 검사에 도달 불가 (제품 순서: 검증→…→잠금, applyDraft는 잠금-우선과 불일치). state.json: 없음→없음 (보존 자명). lock은 실행 중 있음→종료 후 없음 ✓ (잠금 기제 자체는 동작).
- tmp-delta diff: INCREASED_TOTAL 0 (snap `F:\pf-tmp\dogfood.json`).
- `.locks/` 잔재: 0건 (`procedures/.locks` 비어 있음).
- 통과/실패 (기준 5개별): 1 통과 (초안·hash불변·tool 0건) / 2 통과 (approvalReset [1.1]·hash 변경) / 3 조건부 통과 (편차 D2·D3·D4 후 done 달성. 기록지 그대로면 stale 실패로 불통과) / 4 실패 (conflict 관측 불가 — 시드 세션으로는 검증 단계에서 bad_request. 잠금 기제 자체는 실행 중 보유·종료 후 해제 확인) / 5 통과 (tmp 0·locks 0·비용 0.00068 기록).
- 기록지 보완 필요 (후속): ① S2→S3 사이 재승인 단계 추가. ② S3 timeoutMs 안내 또는 wait60 수면 단축 (60s 수면 vs 60000ms 기본 타임아웃 경합). ③ wait60.py `true`→`True` 수정. ④ S4는 현 시드로 conflict 재현 불가 — 기대 수정(검증-우선 순서 명시 또는 별도 유효 세션 절차) 필요. ⑤ 재분석 모델 선택 불가(서버 첫 default 고정) — 제품 개선 후보로 이관.
- 편차 목록: D1 모델(gpt-5.6-luna 사용) / D2 재승인 1회(기록지 외) / D3 timeoutMs 120000 추가 / D4 `True` 수정. D2·D3·D4는 S3 최종 done에 포함됨. D1은 S1에만 영향.
