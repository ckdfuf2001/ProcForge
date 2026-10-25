# M8-1 dogfood — "계속" 신호 + 짝 유지 실측 (사장님 수행 대기)

상태: **양식 완료 · 명령 검증(임시 저장소+가짜 OpenCode) · 실측 대기 (사장님 수행)**
사양: docs/M8-1-spec.md · 결정: DECISIONS `[M8-1]`

## 완료 기준 (실측)

> 새 PF 세션 실측에서 **모델이 같은 세션에** `pf_next` 호출,
> 신호 이후 `pf_start` 0건(세션·호출 양쪽), **해당 노드만** 재확정.

## 1. 환경 (기록란 채우기)

| 항목 | 값 | 기록 |
| --- | --- | --- |
| 별도 저장소 | `$env:PROCFORGE_DIR = "D:\pf-m8-dogfood"` (기존 저장소와 섞이지 않게 **새 폴더**) | |
| OpenCode 서버 기동 | 기동 명령 예: `opencode serve` — 기동 후 `opencode --version` | 명령: |
| OpenCode 포트/주소 | `PROCFORGE_OPENCODE_URL = http://127.0.0.1:<포트>` | 포트: |
| 신호 모드 | `PROCFORGE_OPENCODE_MODE = b` | |
| 도구 접두어 | `PROCFORGE_OPENCODE_TOOL_PREFIX = procforge` — **OpenCode 의 MCP 등록 키와 같게** | |

**opencode.json** (OpenCode가 읽는 설정. `mcp.<키>.environment` 로 **같은
PROCFORGE_DIR 경로**를 그대로 넘긴다 — 저장소가 어긋나면 모델이 다른
저장소의 세션을 이어가게 된다):

```json
{
  "mcp": {
    "procforge": {
      "type": "local",
      "command": ["node", "<저장소>\\packages\\local\\dist\\main.js"],
      "environment": {
        "PROCFORGE_DIR": "D:\\pf-m8-dogfood",
        "PROCFORGE_OPENCODE_URL": "http://127.0.0.1:<OpenCode포트>",
        "PROCFORGE_OPENCODE_MODE": "b",
        "PROCFORGE_OPENCODE_TOOL_PREFIX": "procforge"
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

   > 지난달 지출 내역을 정리해서 월간보고서 초안을 만들어줘.
   > 수집·분석·초안작성으로 단계를 나눠 진행하고, BinY 단계를 또 한 번
   > 나눌 만하면 나눠서, 각 분해의 사유(10자 이상)를 기록해줘.

   기대: 모델이 `pf_start` → `procforge_pf_split`(사유 필수)으로 **2단계
   이상** 분해. PF UI의 왼쪽 타임라인에 R1·R2 가 뜬다.
2. 왼쪽 타임라인에서 R1 클릭 → 가운데 트리, 오른쪽 "분해 사유" 확인.
3. **status=leaf 노드** 하나를 상세로 열어 "사람 조언"을 입력하고
   **"의견 등록 + 계속 신호"**.
   - 신호 결과: `delivered:true`(B) 또는 신호 실패 문구(C 모드).
   - 노란 배지가 뜨면 판정 사유다: "모델이 새 세션을 시작함(pf_start)" 또는
     "모델이 다른 세션을 이어함(<id>)" — 3절 증거로 남긴다.
4. 모델이 **새로 `pf_start` 를 부르지 않고** 같은 세션의 `pf_next` 로
   이어서 진행하는지 3절 (4)로 확인.
5. 모델의 재보고·재확정: 대상 leaf가 `needs_reverify` 배지 → 새 attempt로
   재보고 → 재확정. 3절 (5)로 **`pfAdvise(의견) → [pfNext|pfReport](재검증
   전환) → pfReport(실행) → pfResolve(leaf …)(재확정)` 순서**를 판정한다
   (아 3절 (5)-대안: 화면 분해 라운드 → "라운드 이후 이벤트" 또는
   `decomposition-history` API).
6. 3절 (6) 전후 비교 — **대상 노드 외 변화 0**.

## 3. 증거 명령 (PowerShell)

`.procforge` 폴더 = `$env:PROCFORGE_DIR` 아래. 먼저 **calls.jsonl 실제 1줄**을
확인해 필드 이름을 맞춘다(아래는 `at`·`tool` 필드를 쓴다; 다르면 이 단계에서 정정):

```powershell
$pf = $env:PROCFORGE_DIR          # 예: D:\pf-m8-dogfood
Get-ChildItem "$pf\sessions" -Directory | ForEach-Object {
  $f = Join-Path $_.FullName "calls.jsonl"; if (Test-Path $f) { Get-Content $f -TotalCount 1 }
} | Select-Object -First 1        # ← 실제 1줄 (필드 이름 확인)
```

신호를 보낸 시각을 `$sig`(ISO)로 두고:

```powershell
$pf  = $env:PROCFORGE_DIR
$sid = "<PF세션 UUID>"            # 모델이 pf_start 로 만든 세션
$nid = "<의견을 준 leaf 노드 id>"  # 예: 1.2.1 (status=leaf 였던 노드)
$sig = "<신호를 보낸 시각 ISO>"

# (4-a) 저장소 전체 calls.jsonl 의 pf_start = 0 (신호 이후)
(Get-ChildItem "$pf\sessions" -Directory | ForEach-Object {
  $f = Join-Path $_.FullName "calls.jsonl"; if (Test-Path $f) { Get-Content $f }
} | ForEach-Object { try { $_ | ConvertFrom-Json } catch { $null } } |
  Where-Object { $_ -and $_.at -gt $sig -and $_.tool -match "pf_start" } |
  Measure-Object).Count                                    # → 0

# (4-b) 신호 시각 이후 createdAt 인 세션 수 = 0 (모델이 새 세션을 안 만든다)
(Get-ChildItem "$pf\sessions" -Directory | ForEach-Object {
  $f = Join-Path $_.FullName "session.json"; if (Test-Path $f) {
    $s = Get-Content $f | ConvertFrom-Json; if ($s.createdAt -gt $sig) { $s.id }
  }
} | Measure-Object).Count                                  # → 0

# (4-c) 신호 이후 이 세션에서 무엇을 불렀는지
Get-Content (Join-Path $pf "sessions\$sid\calls.jsonl") |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object { $_.at -gt $sig } |
  Select-Object at, tool, actor | Format-Table -AutoSize
#  기대: tool 이 pf_next / pf_report 뿐 (OpenCode 접두어 procforge_ 는
#  클라이언트 쪽 이름이라 기록에는 붙지 않는다), actor 가 모델 연결(actor "host").

# (5) 순서 판정 — 대상 nodeId 로 거르고 실제 method 이름으로 본다
Get-Content (Join-Path $pf "sessions\$sid\events.jsonl") |
  ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object { $_.nodeIds -contains $nid } |
  Select-Object seq, method, summary | Format-Table -AutoSize

# (5-대안) 화면: 분해 라운드 → 라운드 클릭 → "라운드 이후 이벤트"
#   또는 API: GET http://127.0.0.1:<UI포트>/api/sessions/<sid>/decomposition-history
#   각 라운드 events 의 kinds = advise → reverify → report → confirm 순서.

# (6) 전후 비교 — 대상 노드 외 변화 0
function NodeTable {
  Get-ChildItem (Join-Path $pf "sessions\$sid\nodes") -Filter *.json | ForEach-Object {
    $n = Get-Content $_.FullName | ConvertFrom-Json
    [pscustomobject]@{ id = $n.id; status = $n.status; hash = $n.hash }
  } | Sort-Object id | Format-Table -AutoSize
}
NodeTable | Export-Csv (Join-Path $env:TEMP "node-before.csv") -NoTypeInformation
# … (재확정 후 다시)
NodeTable | Export-Csv (Join-Path $env:TEMP "node-after.csv") -NoTypeInformation
$diff = Compare-Object (Import-Csv (Join-Path $env:TEMP "node-before.csv")) `
                       (Import-Csv (Join-Path $env:TEMP "node-after.csv")) `
                       -Property id, status, hash
$diff | Format-Table -AutoSize
#  판정: 바뀐 행은 대상 노드($nid: needs_reverify → leaf 복귀, 새 hash)와
#  stale가 풀리거나 다시 열린 의존 하류뿐 — 대상 외 다른 노드는 변화 0.
```

## 4. 스크린샷 칸 (4개 — 실측 때 채운다)

| # | 무엇을 | 칸 |
| --- | --- | --- |
| 1 | 타임라인 R1/R2 (라운드 분리·세대) | ![타임라인](타임라인-R1-R2.png) |
| 2 | 사유 패널 + 의견 폼 | ![사유](사유-패널-의견.png) |
| 3 | 신호 결과 (delivered 배지 또는 경고 배지) | ![신호](신호-결과.png) |
| 4 | 재확정 후 타임라인 (의견→재검증→재확정) | ![재확정](재확정-후-타임라인.png) |
