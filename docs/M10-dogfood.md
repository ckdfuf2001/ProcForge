# M10-dogfood (실측 1회, 사람이 직접 진행)

M10 1차를 닫기 위한 실측 기록지다. 이 문서대로 1회 끝까지 돌리고,
결과 칸을 채워서 판정을 받는다. 자동화(E2E)가 아니라 사람이 한다.

## 0. 준비 (절차서 2개 만들기)

새 폴더에서 진행한다 (기존 `.procforge/`와 섞지 않는다). 아래를 그대로 복사해
실행하면 절차서 2개(`dog-a`, `dog-b`)가 생긴다. `dog-b`에는 script 노드와
60초 sleep 단계가 들어 있다 (S4에서 실행 중에 재finalize를 시도할 시간을 번다).

```powershell
$PF = "$PWD\.procforge"
$env:PROOF_OPENCODE_URL="http://127.0.0.1:4096"
$env:PROOF_OPENCODE_MODE="b"
$env:PROOF_OPENCODE_TOOL_PREFIX="proof"
New-Item -ItemType Directory -Force "$PF\procedures\dog-a" | Out-Null
New-Item -ItemType Directory -Force "$PF\procedures\dog-b" | Out-Null
Set-Content "$PF\procedures\dog-a\procedure.json" @'
{"format":"procforge-procedure","version":1,"name":"dog-a","sourceSession":"s","createdAt":"2026-11-07T00:00:00.000Z","params":{},"toolCatalog":[],"tree":{"rootId":"1","nodes":[]},"nodes":[{"id":"1","parentId":null,"goal":"월간보고서 완성","depth":0,"children":["1.1"],"dependsOn":[],"sideEffect":"none","constraints":[]},{"id":"1.1","parentId":"1","goal":"데이터 수집","depth":1,"children":[],"dependsOn":[],"sideEffect":"none","constraints":[]}]}
'@
Set-Content "$PF\procedures\dog-b\procedure.json" @'
{"format":"procforge-procedure","version":1,"name":"dog-b","sourceSession":"s","createdAt":"2026-11-07T00:00:00.000Z","params":{},"toolCatalog":[],"tree":{"rootId":"1","nodes":[]},"nodes":[{"id":"1","parentId":null,"goal":"야간 집계","depth":0,"children":["1.1"],"dependsOn":[],"sideEffect":"none","constraints":[]},{"id":"1.1","parentId":"1","goal":"60초 대기 후 집계","depth":1,"children":[],"dependsOn":[],"sideEffect":"external","tool":{"server":"t","name":"sh","schemaHash":"h"},"args":{"script":{"kind":"script","file":"wait60.py","runtime":"python"}},"constraints":[]}]}
'@
Set-Content "wait60.py" "import time, json`ntime.sleep(60)`nprint(json.dumps({`"done`": true}))"
```

`wait60.py`는 프로젝트 루트(위 명령을 실행한 폴더)에 둔다.

`dog-b`의 1.1(script 노드)에 승인 항목을 미리 만든다
(기준 2가 "목록 1개 이상"으로 통과하려면 필요하다).

```powershell
node <REPO>\packages\local\dist\cli.js approve dog-b --node 1.1
```

`<REPO>`는 Proof 체크아웃 경로다. 성공하면 `approved: 1.1 ...` 1줄이 찍힌다.

OpenCode 1.18.18을 serve 모드로 띄운다: `opencode serve --port 4096`.
모델은 명시 저비용 모델을 쓴다 (예: `opencode-go/crouton-alpha-free`).
업데이트 직후라면 OpenCode와 `proof ui`를 모두 재시작한다
(구 버전 프로세스가 남으면 잠금이 서로 갈린다).

## 1. S1. 재분석 요청 (버튼 또는 curl)

화면: M10 확인 탭 → 불러온 메모리에서 절차서를 고르고(`dog-b` 검색),
재분석 요청문에 아래를 그대로 적고 [재분석 요청]을 누른다.
(`dog-b`의 1.1은 script 노드라서, goal이 바뀌면 기준 2의 목록에 들어간다.)

```text
1.1의 goal을 "60초 대기 후 집계 (야간)"으로 바꿔라
```

또는 `curl` 한 줄 (토큰은 `proof ui`가 출력한 URL의 `#t=` 뒤 문자열):

```powershell
$TOKEN = "<토큰>"
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:<포트>/api/drafts" -Headers @{"x-procforge-token"=$TOKEN; "content-type"="application/json"} -Body '{"procedure":"dog-b","request":"1.1의 goal을 \"60초 대기 후 집계 (야간)\"으로 바꿔라"}'
```

도구 비활성은 코드가 보장한다 (`tools: {"*": false}`로 전송).
사람이 확인할 방법은 가짜가 아니라 실서버 응답의 tool part 개수다.
재분석 세션의 메시지를 받아 tool part가 0건인지 본다
(판정 기준 1의 hash 확인과 함께 S1 증거로 적는다).

`POST /api/drafts`는 202를 즉시 돌려주고 백그라운드에서 완성한다.
메모리 패널에 "초안 대기 중"이 떴다가 "초안 준비됨"으로 바뀌면,
재분석 diff 패널에 diff가 보인다. 실패하면 원문 메시지가 표시된다.

## 2. S2. 초안 적용 (hash·목록 확인)

적용 전에 원본 hash를 잰다.

```powershell
Get-FileHash .procforge\procedures\dog-b\procedure.json
```

재분석 diff 패널에서 항목을 확인하고 [적용]을 누른다.
적용 뒤에 같은 명령으로 hash를 다시 잰다 (바뀌어 있어야 한다).

적용 결과의 "다음 실행 때 승인 필요" 목록을 적는다.
이 목록이 비어 있으면 통과가 아니다. 요청문에 script 노드의 goal·arg
변경을 넣었으므로, 해당 노드가 정확히 1개 이상 들어 있어야 통과다
(목록과 재승인 요구 노드가 일치하는지가 기준 2다).

## 3. S3. 가이드 2단계 순차 실행 (재시작 포함)

1. M10 확인 탭 → 순차 자동 실행에 `dog-a`, `dog-b`를 단계로 쌓고
   [가이드 시작]을 누른다. guideId를 적어 둔다.
2. 1단계를 [확인 후 실행]으로 끝까지 돌린다.
3. `proof ui`를 재시작하고 같은 guideId를 열어 2단계(`dog-b`, 약 60초)를
   [확인 후 실행]한다.
4. 2단계가 `done`이 되면 끝이다.

## 4. S4. 실행 중 재finalize 거부

2단계(`dog-b`)가 도는 동안 그 절차서의 재finalize를 시도한다.
재finalize 경로는 MCP `pf_finalize`뿐이다 (UI 버튼·CLI·HTTP 경로 없음).
OpenCode 대화창에서 `pf_finalize`를 절차서 `dog-b`로 호출한다.

- 실행 중이면 거부된다. MCP 응답의 에러 코드가 `conflict`인지 확인한다.
- 끝난 뒤 `procedures/dog-b/state.json`이 그대로 있는지 본다
  (없던 파일이면 생기지 않은 채 그대로, 있던 파일이면 바이트 동일).
- `curl`로는 할 수 없다 (해당 HTTP 경로가 없다).

## 5. 통과 기준 5개

| # | 기준 |
|---|---|
| 1 | 재분석 응답은 초안으로만 들어가고, S2 적용 전 원본 `procedure.json`의 hash와 S1 직후 hash가 같음 |
| 2 | 적용 후 재승인을 요구하는 노드가 `approvalReset` 목록과 정확히 일치하고, 목록이 1개 이상임 |
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

`scripts/tmp-delta.mjs`는 저장소 루트 기준 상대 경로로 실행한다
(`C:\...\ProcForge`에서 `node scripts/...`).

## 7. 결과 기입 칸 (비워 둠)

- 일시:
- OpenCode 버전·모델·비용 합계:
- S1 초안 draftId·status·원본 hash(S2 전/후):
- S1 tool part 0건 확인 결과:
- S2 바뀐 노드·approvalReset·일치 여부(1개 이상):
- S3 guideId·1단계 runId·재시작 후 2단계 runId·최종 상태:
- S4 재finalize 경로·응답 코드·state.json 보존 여부:
- tmp-delta diff:
- `.locks/` 잔재:
- 통과/실패 (기준 5개별):
