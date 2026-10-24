# M8-1 dogfood — "계속" 신호 + 짝 유지 실측 (사장님 수행 대기)

상태: **양식 준비 완료 · 실측 대기 (사장님 수행)**
사양: docs/M8-1-spec.md · 결정: DECISIONS `[M8-1]`

## 완료 기준 (실측)

> 새 PF 세션 실측에서 UI 의견 → 모델이 **같은 세션에** `pf_next` 호출,
> calls.jsonl 에 신호 이후 `pf_start` 0건, 해당 노드만 재확정.

## 1. 환경

| 항목 | 값 (기록란) |
| --- | --- |
| 별도 저장소(P QuickStart) | `$env:PROCFORGE_DIR = "D:\pf-m8-dogfood"` (기존 저장소와 섞이지 않게 새 폴더) |
| OpenCode 주소 | `PROCFORGE_OPENCODE_URL = http://127.0.0.1:<port>` |
| 신호 모드 | `PROCFORGE_OPENCODE_MODE = b` (기본) |
| 도구 접두어 | `PROCFORGE_OPENCODE_TOOL_PREFIX = procforge` ← opencode.json 의 `mcp` 키와 같게 |
| opencode.json | `{ "mcp": { "procforge": { "type": "local", "command": ["node", "<procforge-local dist/main.js 경로>"] } } }` — 키가 곧 도구 이름 접두어다(`procforge_pf_next`) |
| UI 서버 | `procforge ui` (출력된 토큰으로 브라우저 진입) |

기동 확인: PF UI 하단 프록시/연결 표시가 `실시간: open` 인지.

## 2. 단계 (순서대로, 각 칸에 결과 기록)

1. PF UI 새 세션 생성 → 루트에 대해 **pf_split 2단계 이상** (각 사유 10~1000자).
   - 라운드 R1(`rev1`), 필요하면 그 안에서 R2 한 번 더.
2. 왼쪽 타임라인에서 R1 클릭 → 가운데 트리·오른쪽 "분해 사유" 확인.
3. leaf 노드(예: `1.3`) 상세 → "사람 조언" 입력 → **"의견 등록 + 계속 신호"**.
   - 신호 결과: `delivered:true` (B) 또는 신호 실패 문구(C 모드).
   - `pf_start` 로 새 세션을 파면 노란 배지 "모델이 새 세션을 시작함(pf_start)".
4. OpenCode 쪽에서 모델이 **새로 `pf_start` 를 부르지 않고** `pf_next` 로 이어서
   하는지 확인 (3절 증거 명령).
5. 모델의 재보고·재확정 → `1.3` 이 `needs_reverify` 대기 → 배지 → 새 attempt로
   재확정 → 타임라인 순서 확인 (의견 → 재검증 → 재확정).

## 3. 증거 명령 (PowerShell)

신호를 보낸 시각(ISO, 예: `2026-10-24T21:30:00Z`)을 `$sig` 로 두고:

```powershell
$pf  = "D:\pf-m8-dogfood\.procforge"
$sid = "<PF세션 UUID>"
$sig = "<신호를 보낸 시각 ISO>"

# (1) 신호 이후 호출 method 별 개수 — pf_start 0건이어야 한다
Get-Content "$pf\sessions\$sid\calls.jsonl" | ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object { $_.at -gt $sig } | Group-Object tool |
  Select-Object Name, Count | Sort-Object Name

# (2) pf_start 개수만 확인 (0이어야 한다)
(Get-Content "$pf\sessions\$sid\calls.jsonl" | ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object { $_.at -gt $sig -and $_.tool -match "pf_start" }).Count   # → 0

# (3) 의견 → 재검증 → 재확정 순서 (해당 노드 events)
Get-Content "$pf\sessions\$sid\events.jsonl" | ForEach-Object { $_ | ConvertFrom-Json } |
  Where-Object { $_.method -in @("pfAdvise","pfReport","pfResolve","pfNext") } |
  Select-Object seq, method, summary | Format-Table
```

판정: (1)에 `pf_next`/`pf_report` 만 있고 `pf_start` 가 없으면, (3)에서
advise → report → resolve(leaf) 순서가 보이면 통과.

## 4. 스크린샷 칸 (4개 — 실측 때 채운다)

| # | 무엇을 | 칸 |
| --- | --- | --- |
| 1 | 타임라인 R1/R2 (라운드 분리·세대) | ![타임라인](타임라인-R1-R2.png) |
| 2 | 사유 패널 + 의견 폼 | ![사유](사유-패널-의견.png) |
| 3 | 신호 결과 (delivered 배지 또는 경고 배지) | ![신호](신호-결과.png) |
| 4 | 재확정 후 타임라인 (의견→재검증→재확정) | ![재확정](재확정-후-타임라인.png) |
