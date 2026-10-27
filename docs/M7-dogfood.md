# M7 dogfood 기록 (M5.8(a) 통합)

- 목적: 실제 OpenCode(build 모드) + 실제 UI + 실제 dist MCP로 **사람 1회 실사용**을
  기록하고, 같은 세션에서 **M5.8(a)** 를 함께 닫는다.
- 대상: M7 완료 기준(8절) — 분해 → UI 의견 1건 → 그 부분만 재실행 → finalize →
  무인 run exit 0. M5.8(a) — TUI+dist MCP 분해(1.1만 leaf가 아니라 1.2·1.3·finalize까지).
- 원칙: 증거는 **읽기 전용**으로 수집한다(events.jsonl·calls.jsonl·run state).
  사람/모델/UI 구분은 `actor`와 `connectionId`로만 증명한다(추정 금지).

## 0. 세션 정보

| 항목 | 값 |
|---|---|
| 날짜(UTC) | 2026-10-19 ~ 2026-10-20 (분해 10-19 22:18Z, UI 재개·무인 10-20 16:45Z~16:58Z) |
| 요청 | HN 오늘(UTC) 글 제목·날짜·요약을 CSV로 매일 누적. Show HN/Ask HN 글은 제외하고, 적재 후 행 수 검사 |
| 분해 세션 id | `d290a93d-dd9d-42d6-9e37-5a6ceb90a282` (rev29, 최종) |
| params | `date=2026-10-19` (분해·UI run) / 무인 `date=@today:utc` → `2026-10-20` |
| 절차서 이름 | `hn-daily-dogfood-20261019` (UI run) → `hn-daily-dogfood-20261020` (UI 의견 반영 후 finalize) |
| run id (UI) | `acbe77fb-e976-48e0-bea3-2408ae99d46a` (session `f70c4687-2750-4fa8-8fe2-d7434e26be49`) |
| run id (무인) | `791fac8b-0f94-483e-9c0c-3dfe61bf62b3` (exit 0, session `47bf4d7c-003e-4020-8afc-50dd2b559789`) |

## 1. 환경

| 항목 | 기대값 | 실제값 |
|---|---|---|
| opencode 버전 | `opencode --version` | `opencode --version` 실패(bun remap 오류) — MCP `initialize` clientInfo `opencode 1.18.18`로 대체 |
| 모델 | (세션에서 사용한 모델명) | 미확인: `opencode.json` 없음, events/calls에 모델명 미기록 |
| 에이전트 | `build` | build (실행 요청 기준. 세션 기록에 별도 명시 없음 — 미확인) |
| `PROCFORGE_DIR` | 저장소 1곳으로 고정 | 빈 값(미설정) → 기본 `.procforge` = `D:\opencode\opencode-exe\workspace\repos\ProcForge\.procforge` |
| `PROCFORGE_OPENCODE_URL` | `http://127.0.0.1:<port>` | 빈 값(미설정) — 페어링/신호 degraded 원인 |
| `PROCFORGE_OPENCODE_MODE` | `b` | 빈 값(미설정) |
| UI 주소 | `http://127.0.0.1:<port>/#t=<token>` | `http://127.0.0.1:56748/#t=<redacted>` (토큰은 문서에 남기지 않음, PID 24508 — 기록 후 종료) |
| UI 상단 "저장소" 표시 | `PROCFORGE_DIR`와 동일 | `D:\opencode\opencode-exe\workspace\repos\ProcForge\.procforge` (m7-01) |

```
# 수집 예 (PowerShell)
opencode --version   # 실패: bun remap 오류
echo $env:PROCFORGE_DIR; echo $env:PROCFORGE_OPENCODE_URL; echo $env:PROCFORGE_OPENCODE_MODE
# → 모두 빈 값
```

## 2. 단계 체크 (1~9)

| # | 단계 | 기대값 | 실제값 | 스크린샷 | [x] |
|---|---|---|---|---|---|
| 1 | 빌드 + UI 기동 (`pnpm -w build` → `procforge ui --open`) | UI가 뜨고 저장소 경로 표시 | L3(`scripts/dev-verify.mjs`, 빌드 포함) green — head `56ad2c5`, CI `39330988892`(7잡). UI는 `node packages/local/dist/cli.js ui --port 0` → 56748, 상단 저장소 표시 정상 | `docs/dogfood/m7-01-ui.png` | [x] |
| 2 | 환경 고정 확인 (0·1절 표) | `PROCFORGE_DIR`/`PROCFORGE_OPENCODE_URL`/`MODE=b` 일치 | 3개 모두 빈 값 → 기대 불일치(**degraded**). 기본 `.procforge`로만 동작 | — | [x] |
| 3 | OpenCode build 세션 페어링 | 세션 목록에 연결·`connectionId` 표시, `actor=host` | 세션 목록에서 host 연결 1(connectionId `70fb3b7f-72cc-4fa6-b579-6df50805cd22`, clientName `opencode 1.18.18`) 관측. 단 `/api/pairings` → `{pairs:{},history:[]}`, 짝 0 — URL 미설정으로 attach 미성립(**degraded**). m7-01은 UI 재기동 시점(연결 0·짝 0). 재개 11회는 겹침 없이 순차(7절) | `docs/dogfood/m7-01-ui.png` | [x] |
| 4 | 분해 요청 → 트리 | `1` split → `1.1`/`1.2`/`1.3`, 상태·dependsOn 표시 | root `1` split, `1.1`/`1.2`/`1.3` leaf. dependsOn: `1.2→1.1`, `1.3→1.2`. 최종 rev29 | `docs/dogfood/m7-03-stale-preview.png`(하단 트리) | [x] |
| 5 | UI에서 1.2(또는 1.3) 의견 + stale 미리보기 | 미리보기 목록과 저장 후 stale 전파(3절) | 1.2 목표 편집 → **"이 변경으로 다시 실행될 노드 1개: 1.3"** (`wouldStale=["1.3"]`). 409 문구 "다른 곳에서 이 노드가 변경되었습니다. 저장하면 409가 납니다 (초안 유지)" 확인 | `docs/dogfood/m7-03-stale-preview.png` | [x] |
| 6 | "의견 등록 + 계속 신호" | 신호 B 실제 도착(모델이 이어서 재보고), `delivered:true`(C 문구 없음) | UI 1.3 의견 "CSV 적재 후 행 수 검사에서 이번 UTC 날짜 행만 세고, 신규 건수와 총 행 수를 요약에 남긴다." 저장(events seq20 `actor=ui`, `pfAdvise`, hash `983ace24→14c9876a`). 신호는 실패: "저장은 끝났습니다. 신호 실패: OpenCode 주소 미설정. 전송하지 않음" + 폴백 문구 → **delivered=false(degraded)** | `docs/dogfood/m7-04-advise-degraded.png` | [x] |
| 7 | 모델 재보고 → leaf | 해당 노드만 leaf, **1.1 hash 불변** | UI 의견 후 1.3에 붙은 `llm_rubric`을 결정적 `csv_rows`로 교체(`pf_edit_node`) → reopen→report(pass)→confirm_leaf. 1.1 노드 hash `1ab5bc08235ada24` **불변**(finalize/run과 동일), 1.3 `95d6392df32c9569` | — | [x] |
| 8 | finalize → 실행 탭 | 절차서 등록, 승인 대기 → 화면 승인 → `done` (취소→재실행은 선택, 4절) | `hn-daily-dogfood-20261019` finalize 후 UI 실행 `acbe77fb`: calls에 `pf_run_start`(actor=ui, connectionId `ui-ae580365-...`, clientName `procforge-ui`) → 상태 `done`, 1.1/1.2/1.3 pass. sideEffect=none이라 승인 게이트 미발동(승인 대기 없음). `hn-daily-dogfood-20261020`은 UI 의견 후 MCP(host) finalize | — | [x] |
| 9 | 무인 실행 + 결과 | `procforge run <절차서> --param date=@today:utc --out .procforge/out/hn-daily-2 --unattended` exit **0**, delivered 결과(5·6절) | exit **0**, pass=3 fail=0 unverified=0 skipped=1 blocked=0. 2026-10-20 **703행**, Show/Ask **0** (5·6절) | — | [x] |

## 3. stale 미리보기 결과와 해석

- 원인 노드(편집한 노드): **1.2** (UI 목표 편집 미리보기. 실제 저장 전파는 host `pfAdvise(1.2)` seq9)
- `wouldStale` 목록: **["1.3"]**
- **1.3 포함 여부**: **포함**
- 해석:
  - 1.3이 **포함되면**: dependsOn/전파가 의도대로 걸린 것. 저장 후 1.3만 open/stale이면 정상.
  - 1.3이 **빠지면**: split 때 `dependsOn`을 안 건 구조적 한계. 사후 dependsOn 편집은
    M7 범위 밖이므로 **M8 후보**로 적는다(추측으로 "전파됨"이라 쓰지 않는다).
  - 이번 건: dependsOn `1.3→1.2`가 있어 전파가 정상. UI 미리보기는 저장하지 않았고(초안 유지 확인),
    실제 전파는 seq9 `pfAdvise(1.2)`의 nodeIds `["1.2","1.3"]`로 확인. 1.3은 stale 후 재보고됐다.
- 저장 후 실제 상태(노드별 hash/status):
  - `1.1` leaf, hash `1ab5bc08235ada24` (불변)
  - `1.2` leaf, hash `bf8c3b1d418bddd7`
  - `1.3` leaf, hash `95d6392df32c9569` (UI advise 후 `open`→report pass→leaf)
  - 409/초안 보존: UI 문구 "다른 곳에서 이 노드가 변경되었습니다. 저장하면 409가 납니다 (초안 유지)"
    (실제 409 응답·초안 복원 E2E는 (c)(e)가 커버)

## 4. 실행 화면 결과

| 확인 | 기대값 | 실제값 |
|---|---|---|
| 승인 대기 표시 | `승인 대기: 노드 <id>` + 승인 화면 열기 | **발동 없음** — 절차서 3노드 모두 `sideEffect=none`. UI 실행 `acbe77fb`는 `pf_run_start`(actor=ui) 직후 실행 |
| 화면 승인 | approvalHash 일치, 스크립트 sha256·diff 표시 | 해당 없음(승인 게이트 미발동). 승인 화면은 M7-close-b 테스트/E2E (e)가 커버 |
| 승인 후 | 상태 `done`, 노드별 `pass` | 상태 `done`, `1.1`·`1.2`·`1.3` pass |
| (선택) 다른 실행 취소 | 상태 `cancelled`, `재실행` 버튼 활성 — E2E (e)가 커버 | 미수행(E2E (e) 커버) |
| 실패 노드(있으면) | "이 노드 열기"로 상세 이동 | 없음(UI run). 무인 1·2차 실패는 5절 참고 |

노드별 run 결과(그대로):

| 노드 | status |
|---|---|
| 1 | skipped (split) |
| 1.1 | pass |
| 1.2 | pass |
| 1.3 | pass |

## 5. 무인 실행

| 항목 | 값 |
|---|---|
| 명령 | `$env:NODE_ENV="development"; node packages/local/dist/cli.js run procedures/hn-daily-dogfood-20261020 --param date=@today:utc --out .procforge/out/hn-daily-dogfood-20261020 --unattended --force` |
| exit code | **0** |
| 요약(pass/fail/unverified/skipped/blocked) | pass=3 / fail=0 / unverified=0 / skipped=1 / blocked=0 (suspended=0) |
| 산출물 경로 | `.procforge/out/hn-daily-dogfood-20261020` |

실행 중 확인한 것(정직 기록):
- **exit 3** (run `d05b4c7b-5a4b-4344-a900-124e2f7a8c10`): 무인 승인 게이트.
  `1.1` fail — `failedConstraints=["approval"]`, detail
  `approval: 무인 실행 미승인 script (opencode/read). procedures/<name>/approvals.json에 tool·인자 등록 필요`.
  `1.2`/`1.3`은 `blocked by 1.1`. **stale·제약 검증 실패가 아니다.**
  → `procforge approve procedures/hn-daily-dogfood-20261020 --node 1.1|1.2|1.3 --allow-wildcard date|input`로
  `approvals.json` 생성 후 통과(1.1은 `date`, 1.2·1.3은 `date`·`input`).
- **exit 2** (`7786857f-fd50-47a8-95b1-42526ee79c74`): run 결과는 **pass=3**(1.1·1.2·1.3).
  실패는 **산출물 복사 단계 하나**: `copyRunFsToOut`의
  `bad_request: 출력 파일이 이미 있음: daily.csv (--force를 쓰면 덮어쓰기)`.
  근거: `packages/local/src/app/app.ts:3279`가 `a.force`를 `copyRunFsToOut`에만 넘기고,
  검사는 `packages/local/src/services/runner.ts:57-58` 한 곳뿐이다.
- **`--force`가 끈 검사**: 위 "대상 파일 존재" 검사 **하나뿐**. `runProcedureTest`에는 force가
  전달되지 않아 승인(`approval`)·stale·제약 검증은 그대로 수행됐다 → **승인 원칙 우회 없음(무해)**.
  (finalize의 `--force`도 명령 파일 존재 검사만 건너뛰고 감사 경고는 그대로 낸다 —
  `packages/local/src/services/procedureWriter.ts:203`.)
- run 로그: `.procforge/runs/791fac8b-0f94-483e-9c0c-3dfe61bf62b3/report.json`
  (직전 pass=3/exit 2 run: `7786857f-fd50-47a8-95b1-42526ee79c74`)

### 5.1 누적 시작점 재현 (M7 결함 후보)

- 시작점은 `--out`이 아니라 **finalize golden fixture**다.
  `packages/local/src/runner/run.ts:277-285`가 `setupRunFs`에 `projectRoot`·`params`만 넘기고
  outDir는 넘기지 않는다. `packages/local/src/runner/workdir.ts:31-38`가 `n.golden.fixtures`를
  `sessions/<sourceSession>/fixtures-manifest.json`의 원본 경로로 run fs에 복사한다.
  1.3은 `fixtures/1.3/80a990bc-…/0-daily.csv → daily.csv`(859행, 2026-10-19)로 시작한다.
  `packages/local/src/app/app.ts:3279`의 `copyRunFsToOut`은 실행 **후** out으로 복사만 한다.
- 재현(원본 out은 건드리지 않고 사본 사용): D1 out
  `.procforge/out/hn-daily-dogfood-20261020/daily.csv` = **1562행**(10-19 859 + 10-20 703)을
  `.procforge/out/m7-loss-test`로 복사 → D2
  `run procedures/hn-daily-dogfood-20261020 --param date=2026-10-21 --out .procforge/out/m7-loss-test --unattended --force`
  (run `5607ee83-fc6c-461f-82eb-f22df4f34258`, exit 0, pass=3).
- 결과: D2 run fs·out의 `daily.csv` 모두 **859행(10-19만)**, **D1의 10-20 703행 = 0**.
  D2의 10-21 신규가 0(실행 시점 UTC 2026-10-20T17:28Z, 아직 미래)이라 D1 신규 703행이 사라졌다.
- 원인: 픽스처가 finalize 시점(859행)에 고정되어 이후 실행의 산출물을 반영하지 않는다.
  `--force`는 out 덮어쓰기를 허용할 뿐이지만, out을 시작점으로 쓰지 않으므로 누적이 끊긴다.
- 수정안 비교:

| 안 | 방법 | 장점 | 단점 |
|---|---|---|---|
| A | `--out` 기존본을 run fs 시작점으로 | 절차서 무변경 | out은 출력물이라 입력 오염·재현성 상실, 실행마다 out 경로가 달라지면 누적 불가, 동시성/보안 검증 필요 |
| B | 절차서에 accumulate 입력 선언(`inout`) + 통과 후 원자적 write-back | 입력이 명시적·절차서에 이식, 스케줄러/out 경로와 무관, 승인 해시에 포함 | runner write-back·잠금·실패 시 미기록 구현 필요 |

- 권고: **B**. A는 임시 편의용으로만.

### 5.2 accumulate(B) 구현·검증 (M7-close-i, `7f6fd95`)

- 구현: `procedure.json`의 `accumulate:[{path,node}]` 선언을 `AccumulateSpecSchema`로 검증하고,
  기본 `.procforge/state/<procedure>/`에 파일을 보존한다. `--state`로 루트를 바꿀 수 있다.
- run 시작 시 절차서 `.run.lock`을 잡은 뒤 상태 파일을 run fs로 overlay하고, runId별
  `runs/<runId>/accumulate.json` marker로 UI의 단계별 `runSession` 재호출에서도 seed를 1회만 한다.
  상태 파일이 없으면 fixture가 있어도 `startSha=null`로 시작한다(fixture hash를 시작점으로 쓰면
  첫 write-back이 충돌하므로).
- write-back은 **전체 실행 가능 leaf(`tool` 보유)가 pass**이고 `--node`/`--changed` 부분 실행이
  아닐 때만 수행한다. 시작 sha와 현재 상태 sha를 모두 precheck하고, 다르면 conflict로 상태를
  건드리지 않는다. 성공 시 `${dest}.bak` 1세대 백업 후 temp+rename, 실패 시 report를 fail로 바꾼다.
- resume 시 `setupRunFs`가 누적 대상 파일을 fixture로 덮어쓰지 않도록 `preservePaths`를 적용했다.
- 승인: 누적 선언을 `approvalHash`에 포함해 변경 시 stale이 된다. 선언이 없는 기존 절차서의
  approvalHash는 바뀌지 않는다.
- 절차서 선언: `hn-daily-dogfood-20261020`에 `{"path":"daily.csv","node":"1.3"}` 추가 후
  1.1/1.2/1.3 approvals를 재생성했다(새 hash `7d6acc6a…`, `09bc7556…`, `49d8c501…`).
- 마이그레이션: 기존 `.procforge/out/hn-daily-dogfood-20261020/daily.csv`
  (헤더+**1562행**: 10-19 859 + 10-20 703)을
  `.procforge/state/hn-daily-dogfood-20261020/daily.csv`로 1회 복사했다.
- 검증 0(마이그레이션 canonical): run `227eb898-8dea-4eec-aad1-187c5459ed24`(10-21)
  → **1562행 유지**, write-back 전후 sha256 동일(`B6F8E2DC…`). canonical 상태를 실제로 읽었다.
- 검증 1(기존 10-19 상태에서 10-20 추가): 10-19 859행 상태에서 10-20 run
  `7b2b4820-7e2a-46cb-b0e4-1f6fdd80bf11` → **1692행**(859+833, 중복 0). 이어서 10-21 run
  `102534eb-c9cb-4fcd-b1ca-08ebdd0bca18` → **1692행 유지**(UTC 10-21 신규 0). 로그는
  `누적 상태 로드: daily.csv`, marker `startSha`는 직전 상태 hash였고, 예전처럼 fixture 859행으로
  되돌아가지 않았다.
- 검증 2(빈 상태에서 2회): run `ef9d9379-7aea-44b0-9e08-7a2d8ff9303a`(10-19) → 859행,
  run `829354cd-ffd4-4f2d-8091-5a10cdf61553`(10-20) → **1688행**(859+829, 중복 objectID 0).
  D1은 `초기화: daily.csv (누적 상태 없음 — fixture 사용)`, D2는 `누적 상태 로드: daily.csv`.
- 테스트: `packages/local/test/m7-accumulate.test.ts` **6건 pass** — D1→D2→D3, 실패 상태 불변,
  `--node` 부분 실행 미커밋, replay fixture 고정, 시작 sha conflict, approvalHash stale.
  전체 `pnpm -w test`는 **80 files / 466 tests pass(2 skipped)**, `pnpm -w build`·`pnpm -w lint` pass.
- CI: `7f6fd95` push 후 run `39517399038`, 7/7 success(head_sha 일치).
- 판정: **5.1 누적 유실 결함 해소**. 남은 M7/M5.8(a) 마감 조건은 6.1 신호 B 실사용 확인 하나다.

## 6. Show HN / Ask HN 잔존 수 (이번 UTC 날짜 행만)

- CSV 경로: `.procforge/out/hn-daily-dogfood-20261020/daily.csv` (파일명 `daily.csv`)
- 이번 날짜(UTC) 행 수: **703** (2026-10-20)
- 그중 **`Show HN` 또는 `Ask HN` 글이 남아 있는 행 수**: **0**
- 중복/공백 행: 중복 objectID **0**, 공백 행 **0**. 누적 총 **1562행**(10-19 859 + 10-20 703).
  10-19 859행은 finalize golden seed(전날 산출)이고, 이번 실행이 append한 신규는 703행이다.
  1.2 `filtered.json`도 703건으로 일치.

```powershell
# 이번 UTC 날짜 행만 대상으로 Show HN|Ask HN 잔존을 센다 (읽기 전용)
$date = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
$csv  = ".procforge/out/hn-daily-dogfood-20261020/daily.csv"
$rows = Import-Csv -LiteralPath $csv | Where-Object { $_.date -eq $date }
"이번 날짜 행 수 = $($rows.Count)"                     # 703
"Show/Ask HN 잔존 = $(@($rows | Where-Object { $_.title -match 'Show HN|Ask HN' }).Count)"  # 0
```

- 판정: **이번 날짜 703건 중 Show/Ask HN 잔존 0 — 의견 반영됨**.
  (UI 의견은 `llm_rubric`으로 붙었으나 무인 실행에서 unverified가 되므로,
  finalize 전에 결정적 `csv_rows(daily.csv ≥ 1)`로 교체하고 날짜 행 수는 6절에서 직접 확인했다. 8절 M8 후보 참고.)

### 6.1 신호 B 사람 재확인 (완료)

- 사유: 2절 6단계 신호 B가 `PROCFORGE_OPENCODE_URL` 미설정으로 degraded였다. "UI에서 고치면 모델이
  이어서 한다"는 대표 기능이 실사용으로 아직 증명되지 않았다.
- 1차 실패(2026-10-21): `http://127.0.0.1:40999` + UI 43123에서 `advise-and-signal` 실행.
  advise는 성공했지만 signal은 `delivered:false`, `버전 미확인. 전송하지 않음`.
  원인: OpenCode 1.18.18은 `/version`·`/app`이 HTML, `/config`에 `version`이 없고
  `/global/health`에만 `{"healthy":true,"version":"1.18.18"}`를 준다. `fetchServerVersion`이
  `/global/health`를 보지 않아 버전을 몰랐다.
- 2차 실패: 신호는 전송됐으나 60초 timeout(`모델 무응답/plan 모드 의심`). OpenCode 세션에는
  `procforge_pf_start(completed)`가 실제로 남아 있었다. 원인: `GET /session/:id/message`가
  `{data:parts[]}`가 아니라 `[{info,parts[]}, …]` 메시지 배열을 주어 `listParts`가 빈 배열만 봤다.
- 수정: `packages/local/src/services/opencode-link.ts`에서 `/global/health`를 1순위로 조회하고,
  `extractParts`가 두 응답 형태를 모두 평탄화한다. `m74-signal.test.ts`(HTML `/version` + health),
  `m71-link.test.ts`(메시지 배열) 회귀 추가.
- 최종 실측: 안정 서버 `http://127.0.0.1:5552` + UI 43123. 세션
  `d290a93d-dd9d-42d6-9e37-5a6ceb90a282` revision 31에 의견 등록(rev32) 후 signal
  `delivered:true`, `mode:"b"`, 8.3초. OpenCode `ses_ea0e239ebffeelVJJ5IaS1QDMD`가
  `procforge_pf_start`(completed)를 호출하고 `DONE` 응답.
- 주의: 모델이 `pf_start`로 새 ProcForge 세션 `13f9e1f4-9111-4f77-add7-b0bc026e91d5`를 만들어
  pairing이 그쪽으로 갱신됐다. 기존 `d290a93d`에 대한 “이어서” 호출 자체는 아직 증명하지 못했고,
  위 실측을 위해 `d290a93d`에 테스트 advise 3건(events seq30~32, calls 40→43)이 추가됐다.
- 테스트 의견 혼입: `d290a93d` node 1.3에 human `llm_rubric` 3건이 추가됐으나 status는 `leaf` 유지·stale 미생성. 확정 절차서 `hn-daily-dogfood-20261020` 파일은 불변(재-finalize 시 승인 해시 갱신 필요).
- `13f9e1f4` 생성 사유: 신호 문구가 `계속`뿐이라 모델이 기존 `d290a93d`를 이어갈 근거를 받지 못했고, 새 PF 세션을 시작하는 `pf_start`를 선택했다.
- 판정: **신호 B 전달·`pf_*` 호출은 통과**. 같은 세션 연속성은 M8 후보로 남긴다.
- 사용 소감(불편했던 점 한두 줄): **대기**.

## 7. 증명 표 (사람/모델/UI 구분)

핵심은 **actor가 아니라 connectionId**다. `calls.jsonl`에서 `actor,connectionId,clientName`으로 묶는다.
**connectionId가 다르면 다른 주체**고, 같은 `clientName`의 연결은 **순차적이고 시간이 겹치지 않아야** 한다
(기준 재정의 — 3번 분석 결과. 원래 "OpenCode connectionId 1개" 기준은 재개 환경에서 성립하지 않음).

| actor | connectionId | clientName | 호출 수 | 대표 tool |
|---|---|---|---|---|
| host | `70fb3b7f-72cc-4fa6-b579-6df50805cd22` | `opencode` | 25 | `pf_split`·`pf_report`·`pf_next`·`pf_confirm_leaf`·`pf_finalize` |
| host | `31f51d3a-…`, `87f8cb4d-…`, `e7eba13b-…`, `06d95a0a-…`, `1a9b4167-…`, `26b66d4f-…`, `3a200765-…`, `698dd657-…`, `850a0938-…`, `88f7a708-…`, `ff41f4d0-…` (11개) | `procforge-dogfood-resume` | 14 | `pf_reopen`·`pf_report`·`pf_confirm_leaf`·`pf_finalize` |
| ui | `ui-1f695de0-496f-459c-b07b-aa405491c41d` | `procforge-ui` | 1 | `pf_advise`(1.3) |
| ui | `ui-ae580365-693d-45b4-871d-318909b1361d` (run 세션 `f70c…`) | `procforge-ui` | 1 | `pf_run_start` |

코드에서 확인한 actor 값(실제 `calls.jsonl`에 찍히는 것):
- `ui` — UI 직접 호출(어댑터 경유). `clientName=procforge-ui`, `connectionId=ui-<rand>`.
  예: `pf_edit_args`·`pf_edit_node`·`pf_run_start`·`pf_run_cancel`·`pf_run_approve`·`pf_advise`.
- `host` — OpenCode(MCP stdio) 경로의 **기본값**. 모델이 `actor`를 넘기지 않으면 `host`.
  `connectionId`는 MCP 연결마다 부여되는 값. 예: `pf_next`·`pf_report`·`pf_confirm_leaf`·`pf_split`·`pf_resolve`.
- (현재 코드에서 `runner`로 기록되는 `calls.jsonl` 행은 없다 — 무인 러너는 호출 로그를 남기지 않는다.
  그래서 이 표는 **분해 세션**의 `ui`·`host` 행만 나오는 게 정상이다.)

```
# 수집 예 (PowerShell, 읽기 전용) — actor가 아니라 actor·connectionId·clientName으로 묶는다
$sid = "d290a93d-dd9d-42d6-9e37-5a6ceb90a282"
Get-Content ".procforge\sessions\$sid\calls.jsonl" |
  ConvertFrom-Json |
  Group-Object actor,connectionId,clientName |
  Select-Object Name,Count | Sort-Object Count -Descending
```

- OpenCode 쪽 connectionId: 기대 **1**, 실제 **12**(원 `70fb…` + 재개 11개). UI는 별도 `ui-…` 1개.
  세션 `calls.jsonl` 기준 연결 13개 / 호출 40건. 아래는 connectionId별 첫·마지막 호출(UTC)과 호출 수.

| # | connectionId | clientName | 첫 호출 (UTC) | 마지막 호출 (UTC) | 호출 수 |
|---|---|---|---|---|---|
| 1 | `70fb3b7f-72cc-4fa6-b579-6df50805cd22` | `opencode` | 2026-10-19T22:18:14 | 2026-10-19T22:26:06 | 25 |
| 2 | `ui-1f695de0-496f-459c-b07b-aa405491c41d` | `procforge-ui` | 2026-10-20T16:45:51 | 2026-10-20T16:45:51 | 1 |
| 3 | `26b66d4f-97cb-4054-8344-e6ed66dbf936` | `procforge-dogfood-resume` | 2026-10-20T16:48:03 | 2026-10-20T16:48:03 | 1 |
| 4 | `ff41f4d0-bed5-41cc-84db-09fc29ab84a3` | `procforge-dogfood-resume` | 2026-10-20T16:48:12 | 2026-10-20T16:48:12 | 1 |
| 5 | `e7eba13b-f646-421f-973c-b6638fd1091c` | `procforge-dogfood-resume` | 2026-10-20T16:48:22 | 2026-10-20T16:48:23 | 2 |
| 6 | `3a200765-8016-4bc6-99a8-fb134ebc3370` | `procforge-dogfood-resume` | 2026-10-20T16:49:00 | 2026-10-20T16:49:00 | 1 |
| 7 | `698dd657-a7d5-49a0-b5c4-0ea7da2153d4` | `procforge-dogfood-resume` | 2026-10-20T16:49:52 | 2026-10-20T16:49:52 | 1 |
| 8 | `88f7a708-db49-47fe-836a-060177130d01` | `procforge-dogfood-resume` | 2026-10-20T16:50:03 | 2026-10-20T16:50:03 | 1 |
| 9 | `06d95a0a-9773-4661-b676-4f548c4f3838` | `procforge-dogfood-resume` | 2026-10-20T16:51:41 | 2026-10-20T16:51:41 | 1 |
| 10 | `850a0938-1605-4c10-8a97-d0133d1b3f81` | `procforge-dogfood-resume` | 2026-10-20T16:52:59 | 2026-10-20T16:52:59 | 1 |
| 11 | `87f8cb4d-f725-4474-94f7-5bd55cfea86a` | `procforge-dogfood-resume` | 2026-10-20T16:53:14 | 2026-10-20T16:53:15 | 2 |
| 12 | `31f51d3a-061c-43cd-8100-ed3db3a7b17c` | `procforge-dogfood-resume` | 2026-10-20T16:53:26 | 2026-10-20T16:53:26 | 2 |
| 13 | `1a9b4167-1b5d-479d-b1a3-bea86f1b0626` | `procforge-dogfood-resume` | 2026-10-20T16:53:38 | 2026-10-20T16:53:38 | 1 |

- **겹침 판정: 없음.** 시간순 정렬 후 인접 구간 간격은 **9~132초**, 원 연결(1) 종료
  `22:26:06Z` → UI(2) `16:45:51Z`는 약 18시간, UI(2) → 재개(3)는 132초. 어떤 구간도
  `next.first <= prev.last`를 만족하지 않는다.
  → 세션이 둘로 갈라진 것이 아니라, **OpenCode 재개마다 MCP stdio 프로세스가 새로 떠서**
  새 connectionId를 받은 것(각 프로세스가 1~2콜 후 종료, 2콜은 한 실행에서 도구 2개 호출).
- 따라서 증명 기준을 "OpenCode connectionId 1개"에서 **"같은 `clientName`의 연결은 순차적이고
  시간이 겹치지 않는다"**로 바꾼다(이번 기록은 만족). 안정 ID는 M8 후보로 남긴다.
- 합계 호출 수: **40** (세션 `d290a93d-dd9d-42d6-9e37-5a6ceb90a282`).
  별도 run 세션 `f70c4687-…`에 `pf_run_start` 1건(ui).

## 8. 판정

| 기준 | 판정 | 근거 |
|---|---|---|
| M5.8(a) serve+웹 UI/attach + dist MCP 분해 (1.2·1.3·finalize 포함) | [x] | 2절 4·8단계, 7절. dist MCP(stdio)로 1.1~1.3 분해·finalize, UI 실행 `done`. 6.1에서 수동 pairing 후 신호 B `delivered:true`+`pf_start` 확인. 자동 attach UX는 M8 후보 |
| M7 dogfood (UI 의견 1건 → 부분 재실행 → finalize → 무인 exit 0) | [x] | 2절 5~9단계, 5절·5.2, 6.1. 누적 유실은 5.2에서 해소됐고 전체 테스트·CI green. 6.1 신호 B `delivered:true`+`pf_*` 호출 확인 |
| 누적 실행 데이터 보존 (전날 신규 행) | [x] | 5.2 — 859행 상태에 10-20 833행 추가해 1692행, 이어 10-21에도 1692행 유지(유실 0). 빈 상태 2회도 859→1688행 |
| 실행 중 취소 경쟁 (waiting 기록 직후 취소) | [x] | `e319426`, CI `39512901431` 7/7. `m75-waiting.test.ts` 회귀 포함 |
| 의견 반영 (Show/Ask HN 잔존 0) | [x] | 6절 — 703행 중 0 |
| (선택) 데이터 유실 0 (409·초안 보존) — E2E (c)(e) 커버 | [x] | 3절 UI 문구 확인 + E2E (c)(e) |
| 무인 실행 exit 0 | [x] | 5절 — `791fac8b…` exit 0 (`--force`는 출력 덮어쓰기 전용, 검사 우회 없음 확인) |

- 종합: **기능 흐름 통과, 누적 결함·취소 경쟁 수정 완료, M7/M5.8(a) 마감.** `--force`는 승인·stale·검증을
  우회하지 않았다(5절). 누적 시작점 문제는 5.2의 accumulate(B)로 해소됐고, 마이그레이션 상태·빈 상태
  2회 실행 모두 데이터 유실 0을 확인했다. 신호 B는 6.1에서 `delivered:true`+`pf_start`로 실측했고,
  그 과정에서 `/global/health` 버전 조회와 메시지 배열 `listParts` 결함을 수정했다.
  환경/도구 제약 기록: (1) 초기 `PROCFORGE_OPENCODE_URL` 미설정 → 신호 B degraded였고 6.1에서 해소,
  (2) 자동 attach/pairing 없이 수동 `pairings.json`이 필요했고, (3) MCP 재개마다 connectionId 신규
  발급(11회, **시간 겹침 없음** — 기준을 "같은 clientName 순차·비중첩"으로 재정의).
- 주의(M8-1-pair): 신호 B `delivered:true` 는 **수동 `pairings.json` 상태에서 확인**했다.
  짝 찾기로 통과한 증거가 아니다. 자동 찾기는 `docs/M8-1-spec.md` b2 에 있다.
- M8 후보(이번 dogfood에서 발견한 것만):
  1. UI `pf_advise`가 만든 `llm_rubric`은 무인 실행에서 unverified → exit 1. 의견 입력 시
     "무인 검증 불가" 경고를 띄우고 결정적 제약(`numeric_match`/`csv_rows`)으로 바꾸도록 제안해야 한다
     (이번엔 사람이 수동 교체). finalize 경고만으로는 부족.
  2. finalize 직후 `approvals.json`을 따로 만들어야 무인 실행이 된다 → UI에서 "승인 필요" 흐름으로
     바로 이어지거나 finalize가 생성 명령을 안내해야 한다.
  3. 신호 대상(`PROCFORGE_OPENCODE_URL`) 미설정을 실행 전에 알 수 없다 → UI 상단에
     "신호 대상: 미설정/연결됨" 상태를 표시해야 한다(현재는 저장 후 실패 문구로만 인지).
  4. connectionId 기준 재정의: "같은 `clientName` 연결은 순차·비중첩"을 공식 기준으로 삼고,
     재개 세션용 안정 ID/attach-resume은 별도 과제로 둔다.
  5. `--out`에 기존 파일이 있으면 run은 pass인데 exit 2 — "실행 성공/복사 실패"의 exit code 구분 필요.
  6. Playwright MCP가 저장소 루트(`.playwright-mcp/`)에 로그를 써서 run fs 가드에 걸림
     (`57bd2834`, `5d74c812` 실패) → 도구 로그 경로를 run fs 밖/임시로 분리.
  7. llm_rubric이 남은 절차서의 finalize는 warning뿐 — `strict`처럼 경고를 실패로 승격하는 옵션 검토.
  8. 신호 B에서 모델이 `pf_start`로 새 세션을 만들어 기존 `d290a93d` 연속성이 끊겼다 → 신호에
     대상 세션 ID/의도를 싣거나 “이어서”용 continue API를 제공해야 한다. 자동 attach/pairing도 필요.
     (M8-1-pair 로 자동 짝 찾기 추가. 나머지는 M8 후보로 남김.)
  9. **모델 실패 표 (M8-1 실측 2026-10-27, 세션 `ses_e859…`, 모델 `opencode-go/claude-haiku-5-5`로 기록 — 세션 메타 미확인).**
     OpenCode 메시지의 tool error 파트 원문 기준. 사용성 후보 기록용이며 코드 결함이 아니다(모델 입력 오류).

     | 도구 | 오류 원문(요약) | 횟수 |
     |---|---|---|
     | pf_split | `dep_missing: unknown dependsOn $1` | 1 |
     | pf_split | `dep_missing: unknown dependsOn 2` | 2 |
     | pf_split | `dep_missing: unknown dependsOn child:2` | 1 |
     | pf_split | `split creates dependency cycle` | 1 |
     | pf_report | `artifact not found: artifacts/1.2.csv` | 2 |
     | pf_report | `artifact not found: .procforge/sandbox/<sid>/artifacts/1.2.csv` | 1 |
     | pf_report | `path escapes project root: D:\...\artifacts\1.2.csv` (절대 경로로 씀) | 1 |
     | pf_report | `unknown tool script/1.1.py` | 1 |
     | pf_report | `MCP error -32602: Session id must be UUID v4 … Required at nodeId …` | 1 |
     | pf_next | `MCP error -32602: Session id must be UUID v4 at sessionId` | 1 |

     합계 12건 (split 5 · report 6 · next 1). `bash | Tool execution aborted` 1건은 수동 중단이라 제외.

     M8 사용성 후보:
     - pf_split 도구 설명에 `dependsOn` 형식 예시(자식 id는 **형제 id 문자열**, `$n`·`child:n` 금지)를 넣는다.
     - pf_report/pf_next 설명에 `sessionId` 는 **PF 세션 UUID 원문**임을 예시로 넣는다.
     - artifact 기준 폴더(`artifacts/<노드>.<ext>`, 프로젝트 상대)를 pf_report 설명에 명시하고, 절대 경로는 거절 메시지에 힌트로 준다.

## 9. 증거 링크

- 스크린샷:
  - `docs/dogfood/m7-01-ui.png` — UI 기동·저장소 표시(세션 목록)
  - `docs/dogfood/m7-02-node12-edit.png` — 1.2 편집 패널(stale rev6, 원인 1.1)
  - `docs/dogfood/m7-03-stale-preview.png` — `wouldStale=["1.3"]` 미리보기
  - `docs/dogfood/m7-04-advise-degraded.png` — UI 의견 저장 후 신호 실패/폴백(seq20)
- run 로그:
  - UI: `.procforge/runs/acbe77fb-e976-48e0-bea3-2408ae99d46a/state.json` (`done`, pass 3)
  - 무인: `.procforge/runs/791fac8b-0f94-483e-9c0c-3dfe61bf62b3/report.json` (exit 0, pass 3)
  - 실패 기록: `7786857f-…`(pass 3, out 충돌 exit 2), `d05b4c7b-…`(approval exit 3),
    `57bd2834-…`·`5d74c812-…`(Playwright 로그로 run fs 가드 실패)
  - 누적 유실 재현: `5607ee83-fc6c-461f-82eb-f22df4f34258` (D2, exit 0/pass 3, daily.csv 859행),
    out 사본 `.procforge/out/m7-loss-test/`
  - accumulate 검증: `227eb898-…`(canonical 1562 유지), `7b2b4820-…`(859→1692),
    `102534eb-…`(1692 유지), `ef9d9379-…`(빈 상태→859), `829354cd-…`(859→1688)
- 누적 상태: `.procforge/state/hn-daily-dogfood-20261020/daily.csv` (헤더+1562행 마이그레이션,
  `.bak` 1세대), 증명용 별도 state `D:\Local\Temp\opencode\pf-m7-acc-verify*`
- 세션 이벤트: `.procforge/sessions/d290a93d-dd9d-42d6-9e37-5a6ceb90a282/events.jsonl`(seq1~32,
  seq30~32는 6.1 신호 테스트 advise), `calls.jsonl`(43건),
  `.procforge/sessions/f70c4687-…/calls.jsonl`(ui run start 1건)
- 신호 B: `http://127.0.0.1:5552` + UI 43123, `delivered:true`/`mode:"b"`, OpenCode
  `ses_ea0e239ebffeelVJJ5IaS1QDMD`의 `procforge_pf_start`(completed), 새 PF 세션
  `13f9e1f4-9111-4f77-add7-b0bc026e91d5`
- 절차서: `.procforge/procedures/hn-daily-dogfood-20261020/` (`procedure.json`에 `accumulate` 선언,
  재생성된 `approvals.json`, `scripts/1_1.py`·`1_2.py`·`1_3.py`, `tests/fixtures/`, `command.md`)
- 코드/CI:
  - 취소 수정 `e319426` — CI [39512901431](https://github.com/ckdfuf2001/ProcForge/actions/runs/39512901431) 7/7
  - accumulate `7f6fd95` — CI [39517399038](https://github.com/ckdfuf2001/ProcForge/actions/runs/39517399038) 7/7
  - 이전 docs/기능 head `56ad2c5` — CI [39330988892](https://github.com/ckdfuf2001/ProcForge/actions/runs/39330988892)
