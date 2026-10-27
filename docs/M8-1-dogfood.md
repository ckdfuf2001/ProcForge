# M8-1 dogfood — "계속" 신호 + 짝 유지 실측

상태: **[~] 진행 중 (close2 보정: 아래 3건 남음)**
사양: docs/M8-1-spec.md · 결정: DECISIONS `[M8-1]`

실측 1회 완료 (2026-10-27, PF `e167df9c`, OC `ses_e8217…`). `[x]`로 못 가는 사유 3줄:
1. 출력 스키마 — advice `id`·`revision`이 요약 스키마에 없어 MCP -32602 3건. 단일 원천으로 고침(a).
2. 재확정 미실측 — 끝까지 간 재확정 흐름을 실서버에서 아직 못 봄.
3. 판정 보정 — 전송 판정-모델 완료 분리·백그라운드 감시(b), 실측 필요.

## 완료 기준 (실측)

> 새 PF 세션 실측에서 **모델이 같은 세션에** `pf_next` 호출,
> 신호 이후 `pf_start` 0건(세션·호출 양쪽), **해당 노드만** 재확정.

## 1. 환경 (기록란 채우기)

| 항목 | 값 | 기록 |
| --- | --- | --- |
| 별도 저장소 | `PROCFORGE_DIR = D:\pf-m8-dogfood` (기존 저장소와 섞이지 않게 **새 폴더**). opencode.json 과 UI 터미널 **둘 다** 같은 값 | `D:\pf-m8-dogfood` 사용. `D:\pf-m8-dogfood2`를 만들었으나 MCP·UI가 구 폴더로 떠 있어 구 폴더로 진행. `pairings.json`이 구 폴더에 없어 짝 상태는 비어 있었음(새 폴더와 동등) |
| OpenCode 서버 기동 | `opencode serve --port <N>` (예: `opencode serve --port 4096`) — 기동 후 `opencode --version` | 명령: |
| OpenCode 주소 | `PROCFORGE_OPENCODE_URL = http://127.0.0.1:<N>` — **`procforge ui` 를 띄우는 터미널**에 설정 | 주소: |
| 신호 모드 | `PROCFORGE_OPENCODE_MODE = b` — **`procforge ui` 터미널**에 설정 | |
| 도구 접두어 | `PROCFORGE_OPENCODE_TOOL_PREFIX = procforge` — **`procforge ui` 터미널**에 설정, OpenCode 의 MCP 등록 키와 같게 | |

**왜 URL/MODE/TOOL_PREFIX 를 opencode.json 에 두지 않나**: 이 값들은 신호를
보내는 쪽(UI 프로세스) 설정이다. MCP 환경에 넣으면 모델이 도구 호출 중에 이
설정을 읽고 스스로 신호를 보낼 수 있다(모델 자기 신호 방지).

**opencode.json** (OpenCode가 MCP 서버를 띄울 때 읽는다. 저장소 경로만 고정한다.
저장소가 어긋나면 모델이 다른 저장소의 세션을 이어가게 된다):

```json
{
  "mcp": {
    "procforge": {
      "type": "local",
      "command": ["node", "<저장소>\\packages\\local\\dist\\main.js"],
      "environment": {
        "PROCFORGE_DIR": "D:\\pf-m8-dogfood"
      }
    }
  }
}
```

도구 이름은 이 키 접두어를 따른다: `procforge_pf_start`, `procforge_pf_next`, …

## 2. 단계 (순서대로)

1. **세션은 OpenCode 터미널에서 모델이 만든다** — 사람이 PF UI에서 세션을
   만들지 않는다. UI는 **보기·의견 전용**이다. 모델에게 아래 예시 요청 문구를
   그대로 준다(2단계 이상 분해를 유도하는 문구):

   > Hacker News 오늘자 상위 글을 수집해서 CSV로 정리하고, 제목 키워드별로
   > 요약 초안을 만들어줘. 수집·정리·요약 단계로 나눠 진행하고, 정리 단계가
   > 작업을 두 가지 이상 포함하면 한 번 더 나눠서, 각 분해의 사유(10자 이상)를
   > 기록해줘.

   기대: 모델이 `pf_start` → `procforge_pf_split`(사유 필수)으로 **2단계
   이상** 분해. PF UI의 왼쪽 타임라인에 R1·R2 가 뜬다.
2. 왼쪽 타임라인에서 R1 클릭 → 가운데 트리, 오른쪽 "분해 사유" 확인.
3. **status=leaf 노드** 하나를 상세로 열어 "사람 조언"을 입력하고
   **"의견 등록 + 계속 신호"**.
   - 신호 결과: `delivered:true`(B) 또는 신호 실패 문구(C 모드).
   - 노란 배지가 뜨면 판정 사유다: "모델이 새 세션을 시작함(pf_start)" 또는
     "모델이 다른 세션을 이어감(<id>)" — 3절 증거로 남긴다.
4. 모델이 **새로 `pf_start` 를 부르지 않고** 같은 세션의 `pf_next` 로
   이어서 진행하는지 3절 (4)로 확인.
5. 모델의 재보고·재확정: 대상 leaf가 `needs_reverify` 배지 → 새 attempt로
   재보고 → 재확정. 3절 (5)로 **`pfAdvise(의견) → [pfNext|pfReport](재검증
   전환) → pfReport(실행) → pfResolve(leaf …)(재확정)` 순서**를 판정한다
   (3절 (5)-대안: 화면의 분해 라운드 → "라운드 이후 이벤트", 또는
   `decomposition-history` API로 같은 순서를 본다).
6. 3절 (6) 전후 비교 — **대상 노드 외 변화 0**.

## 3. 증거 명령 (PowerShell)

### 저장 위치 (임시 저장소 실측 원문 기준)

`$env:PROCFORGE_DIR` 바로 아래에 `sessions\<sid>\` 가 생긴다.

| 파일 | 내용 | 주요 필드 |
| --- | --- | --- |
| `sessions\<sid>\calls.jsonl` | 도구 호출 1건 = 1줄 | `at`(UTC, ms·Z), `tool`(접두어 없음: `pf_start`·`pf_next`·`pf_report`…), `sessionId`, `ok`, `actor`(모델 `host`, UI 의견 등록 `ui`), `clientName`, `clientVersion`. UI 의견 등록은 `tool: pf_advise`, `actor: ui`, `clientName: procforge-ui` 줄로 남는다 |
| `sessions\<sid>\events.jsonl` | 상태 변경 1건 = 1줄 | `seq`, `revision`, `at`, `actor`, `method`(camelCase: `pfNext`·`pfReport`·`pfResolve`·`pfAdvise`), `nodeIds`, `beforeHash`, `afterHash`, `summary` |
| `sessions\<sid>\session.json` | 세션 1개 | `id`, `createdAt`, `rootId`, `revision` |
| `sessions\<sid>\nodes\<nodeId>.json` | 노드 1개 (예: `1.1.json`) | `id`, `status`, `hash`, `attempts`, `retries` |
| `sessions\<sid>\nodes\<nodeId>\pre-snapshot.json` | 노드 직전 스냅샷 | — |

`pf_start` 는 events 에 기록되지 않는다(calls 에만 남는다). 그래서 신호 이후의
새 세션 여부는 calls 로 본다((4-a)·(4-b)).

### 명령

```powershell
$pf  = $env:PROCFORGE_DIR                # 저장소 폴더 (아래에 sessions\ 가 있다)
$sid = "<PF세션 UUID>"                   # calls.jsonl 의 sessionId
$nid = "<의견을 준 leaf 노드 id>"        # 예: 1.2.1

# $sig = "의견 등록(UI)" 시각. 손으로 적지 않고 원문 events.jsonl 에서 뽑는다:
#   nodeIds 에 $nid 가 있고 method 가 pfAdvise, actor 가 ui 인 마지막 줄의 at (UTC, Z)
$ev = Get-Content "$pf\sessions\$sid\events.jsonl" | Where-Object { $_ -match '"method":"pfAdvise"' } |
  ForEach-Object { $o = $_ | ConvertFrom-Json; if ($o.actor -eq 'ui' -and $o.nodeIds -contains $nid) { $_ } } |
  Select-Object -Last 1
$sig = if ($ev -match '"at":"([^"]+)"') { $Matches[1] }
"신호 시각: $sig"

$inv   = [Globalization.CultureInfo]::InvariantCulture
$utc   = [Globalization.DateTimeStyles]::AdjustToUniversal
$sigAt = [datetime]::Parse($sig, $inv, $utc)
# calls/events 의 at 은 ConvertFrom-Json 이 날짜로 바꾸므로 원문 줄에서 읽는다
function Get-AtUtc([string]$line) {
  if ($line -match '"at":"([^"]+)"') { [datetime]::Parse($Matches[1], $inv, $utc) }
}

# (4-a) 신호 이후 pf_start 호출 수 — 기대 0
$startCalls = Get-ChildItem "$pf\sessions" -Directory | ForEach-Object {
  $f = Join-Path $_.FullName "calls.jsonl"
  if (Test-Path $f) { Get-Content $f | Where-Object { $_ -match '"tool":"pf_start"' } }
} | Where-Object { (Get-AtUtc $_) -gt $sigAt }
"(4-a) pf_start 신호 이후: $(@($startCalls).Count)건 (기대 0)"

# (4-b) 신호 이후 생성된 세션 수 — 기대 0
$newSessions = Get-ChildItem "$pf\sessions" -Directory | Where-Object {
  $f = Join-Path $_.FullName "session.json"
  if (-not (Test-Path $f)) { return $false }
  $raw = Get-Content $f -Raw
  if ($raw -notmatch '"createdAt":\s*"([^"]+)"') { return $false }
  [datetime]::Parse($Matches[1], $inv, $utc) -gt $sigAt
}
"(4-b) 신호 이후 생성 세션: $(@($newSessions).Count)개 (기대 0)"

# (4-c) 이 세션의 신호 이후 모델 호출 — 기대: tool 이 pf_next / pf_report 뿐
# (UI 의견 등록 줄 tool=pf_advise, actor=ui 는 제외한다)
Get-Content "$pf\sessions\$sid\calls.jsonl" | Where-Object { (Get-AtUtc $_) -gt $sigAt } |
  ForEach-Object { $o = $_ | ConvertFrom-Json; [pscustomobject]@{ tool = $o.tool; actor = $o.actor; ok = $o.ok } } |
  Where-Object { $_.actor -ne 'ui' } | Format-Table -AutoSize

# (5) 대상 노드의 순서 — 기대: pfAdvise → pfNext 또는 pfReport → pfReport → pfResolve
Get-Content "$pf\sessions\$sid\events.jsonl" | ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object { $_.nodeIds -contains $nid } |
  Select-Object seq, method, summary | Format-Table -AutoSize

# (6) 전후 비교 — nodes\<nodeId>.json 의 id / status / hash
function Get-NodeTable {
  Get-ChildItem "$pf\sessions\$sid\nodes" -Filter *.json | ForEach-Object {
    $n = Get-Content $_.FullName -Raw | ConvertFrom-Json
    [pscustomobject]@{ id = $n.id; status = $n.status; hash = $n.hash }
  } | Sort-Object id
}
Get-NodeTable | Export-Csv "$env:TEMP\node-before.csv" -NoTypeInformation
# ... 재확정 후
Get-NodeTable | Export-Csv "$env:TEMP\node-after.csv" -NoTypeInformation
Compare-Object (Import-Csv "$env:TEMP\node-before.csv") (Import-Csv "$env:TEMP\node-after.csv") -Property id, status, hash
# 기대: 바뀐 행은 $nid 와 그 하류(stale 해제)뿐, 나머지 노드 변화 0
```

(5-대안) 화면: 분해 라운드 → 라운드 클릭 → "라운드 이후 이벤트"
또는 API `GET http://127.0.0.1:<UI포트>/api/sessions/<sid>/decomposition-history`
(각 라운드 events 의 kinds = advise → reverify → report → confirm 순서).

## 4. 스크린샷 칸 (4개 — 실측 때 채운다)

| # | 무엇을 | 칸 |
| --- | --- | --- |
| 1 | 타임라인 R1/R2 (라운드 분리·세대) | ![타임라인](타임라인-R1-R2.png) |
| 2 | 사유 패널 + 의견 폼 | ![사유](사유-패널-의견.png) |
| 3 | 신호 결과 (delivered 배지 또는 경고 배지) | ![신호](신호-결과.png) |
| 4 | 재확정 후 타임라인 (의견→재검증→재확정) | ![재확정](재확정-후-타임라인.png) |

## 5. 실측 기록 (2026-10-27, PF `e167df9c`, OC `ses_e8217…`, 대상 `1.1.2`)

- 어긴 점 3개 (그대로 둔다):
  1. `D:\pf-m8-dogfood2`를 만들었으나 쓰지 않았다. MCP(편집 전 환경)와 UI
     터미널이 구 폴더라 구 폴더로 진행했다. `pairings.json`이 구 폴더에 없어
     짝 상태는 비어 있었다.
  2. URL/MODE/PREFIX를 `opencode.json`에 잠깐 넣었다가 §1 이유로 원복했다.
  3. 모델이 32바이트 파일 읽기에서 2번 멈췄다(`bash`·`read` 무한 running).
     둘 다 abort로 끊고 살렸다.
- `delivered` 미수신 사유: 의견 등록 HTTP가 120초 타임아웃됐다.
  `sendContinue`가 POST 턴 종료까지 물고 있어서다(원인 확정).
  OC가 신호문을 받고 모델이 같은 세션으로 `pf_next`했으므로 true로 추정한다.
  → M8-1-close a에서 전송 판정-모델 완료를 분리했다.
- (6) 재판정: before에 leaf는 0개였다. 바뀐 행은 대상 4 leaf뿐이다
  (`1.1.1` probing→leaf, `1.1.2`·`1.2`·`1.3` open→leaf).
  `1`·`1.1` hash 불변이다. `1.1.2` before `80568941258e4c92` →
  after `6c49562359a75bae`, `reverifySince`·`staleSince` 없음(해제됨).
- 그 외: (4-a) 0, (4-b) 0, (4-c) `pf_next`·`pf_report`뿐(조회 3·실패 1 재시도 성공),
  (5) `pfAdvise` → `pfNext` → `pfReport` → `pfResolve`,
  `pairings.json` `source:"discovered"`·재확정 후 유지,
  `tool:pf_advise`이면서 `actor≠ui`인 줄 0건.
