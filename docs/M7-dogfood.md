# M7 dogfood 기록 (M5.8(a) 통합)

- 목적: 실제 OpenCode(build 모드) + 실제 UI + 실제 dist MCP로 **사람 1회 실사용**을
  기록하고, 같은 세션에서 **M5.8(a)** 를 함께 닫는다.
- 대상: M7 완료 기준(8절) — 분해 → UI 의견 1건 → 그 부분만 재실행 → finalize →
  무인 run exit 0. M5.8(a) — TUI+dist MCP 분해(1.1만 leaf가 아니라 1.2·1.3·finalize까지).
- 이 문서는 **양식**이다. 세션 중 `실제값`/`스크린샷` 칸을 채우고 판정을 [x]로 바꾼다.
  채우지 않은 칸은 "미확인"이 아니라 "아직 기록 전"이다.
- 원칙: 증거는 **읽기 전용**으로 수집한다(events.jsonl·calls.jsonl·run state).
  사람/모델/UI 구분은 `actor`와 `connectionId`로만 증명한다(추정 금지).

## 0. 세션 정보

| 항목 | 값 |
|---|---|
| 날짜(UTC) | |
| 요청 | 예: HN 오늘(UTC) 글 제목·날짜·요약 CSV 누적 + 행 수 검사 |
| 분해 세션 id | |
| params | 예: `date=YYYY-MM-DD` |
| 절차서 이름 | |
| run id (UI) | |
| run id (무인) | |

## 1. 환경

| 항목 | 기대값 | 실제값 |
|---|---|---|
| opencode 버전 | `opencode --version` | |
| 모델 | (세션에서 사용한 모델명) | |
| 에이전트 | `build` | |
| `PROCFORGE_DIR` | 저장소 1곳으로 고정 | |
| `OPENCODE_URL` | `http://127.0.0.1:<port>` | |
| `PROCFORGE_OPENCODE_MODE` | `b` | |
| UI 주소 | `http://127.0.0.1:<port>/#t=<token>` | |
| UI 상단 "저장소" 표시 | `PROCFORGE_DIR`와 동일 | |

```
# 수집 예 (PowerShell)
opencode --version
echo $env:PROCFORGE_DIR; echo $env:OPENCODE_URL; echo $env:PROCFORGE_OPENCODE_MODE
```

## 2. 단계 체크 (1~9)

각 단계: 기대값과 실제값을 적고, 스크린샷 경로(예: `docs/dogfood/m7-01-ui.png`)를 남긴다.

| # | 단계 | 기대값 | 실제값 | 스크린샷 | [x] |
|---|---|---|---|---|---|
| 1 | 빌드 + UI 기동 (`pnpm -w build` → `procforge ui --open`) | UI가 뜨고 저장소 경로 표시 | | | |
| 2 | 환경 고정 확인 (0·1절 표) | `PROCFORGE_DIR`/`OPENCODE_URL`/`MODE=b` 일치 | | | |
| 3 | OpenCode build 세션 페어링 | 세션 목록에 연결·`connectionId` 표시, `actor=host` | | | |
| 4 | 분해 요청 → 트리 | `1` split → `1.1`/`1.2`/`1.3`, 상태·dependsOn 표시 | | | |
| 5 | UI에서 1.2(또는 1.3) 의견 + stale 미리보기 | 미리보기 목록과 저장 후 stale 전파(3절) | | | |
| 6 | "의견 등록 + 계속 신호" | 신호 B 실제 도착(모델이 이어서 재보고) | | | |
| 7 | 모델 재보고 → leaf | 해당 노드만 leaf, 나머지 hash 불변 | | | |
| 8 | finalize → 실행 탭 | 절차서 등록, 승인 대기 → 화면 승인 → `done`, 취소 → 재실행 활성(4절) | | | |
| 9 | 무인 실행 + 결과 | `run <절차서> --unattended` exit **0**, delivered 결과(5·6절) | | | |

## 3. stale 미리보기 결과와 해석

- 원인 노드(편집한 노드): 
- `wouldStale` 목록: 
- **1.3 포함 여부**: 
- 해석:
  - 1.3이 **포함되면**: dependsOn/전파가 의도대로 걸린 것. 저장 후 1.3만 open/stale이면 정상.
  - 1.3이 **빠지면**: split 때 `dependsOn`을 안 건 구조적 한계. 사후 dependsOn 편집은
    M7 범위 밖이므로 **M8 후보**로 적는다(추측으로 "전파됨"이라 쓰지 않는다).
- 저장 후 실제 상태(노드별 hash/status): 

## 4. 실행 화면 결과

| 확인 | 기대값 | 실제값 |
|---|---|---|
| 승인 대기 표시 | `승인 대기: 노드 <id>` + 승인 화면 열기 | |
| 화면 승인 | approvalHash 일치, 스크립트 sha256·diff 표시 | |
| 승인 후 | 상태 `done`, 노드별 `pass` | |
| 다른 실행 취소 | 상태 `cancelled`, `재실행` 버튼 활성 | |
| 실패 노드(있으면) | "이 노드 열기"로 상세 이동 | |

노드별 run 결과(그대로):

| 노드 | status |
|---|---|
| | |

## 5. 무인 실행

| 항목 | 값 |
|---|---|
| 명령 | `procforge run <절차서> --unattended` |
| exit code | |
| 요약(pass/fail/unverified/skipped/blocked) | |
| 산출물 경로 | |

## 6. HN 제목 잔존 수 (이번 날짜 행만)

- CSV 경로: 
- 이번 날짜(UTC) 행 수: 
- 그중 제목이 남아 있는 행 수: 
- 중복/공백 행: 
- 판정: (예: "이번 날짜 행 N건 전부 제목 존재, 중복 0" — 개수로만)

## 7. 증명 표 (사람/모델/UI 구분)

`events.jsonl`·`calls.jsonl`·pairings에서 수집한다. **connectionId가 다르면 다른 주체**다.

| connectionId | clientName | actor | 호출 수 | 대표 tool |
|---|---|---|---|---|
| | | | | |

- 사람(UI): `actor=ui` — 예: `pf_edit_args`, `pf_advise_and_signal`, `pf_run_approve`
- 모델(OpenCode): `actor=host` — 예: `pf_next`, `pf_report`, `pf_confirm_leaf`
- 모델(러너/무인): `actor=runner` — 예: 실행 단계 report
- 합계 호출 수와 세션 id를 함께 적는다.

```
# 수집 예 (PowerShell, 읽기 전용)
Get-Content "$env:PROCFORGE_DIR\sessions\<sid>\events.jsonl" |
  ConvertFrom-Json | Group-Object actor | Select-Object Name,Count
Get-Content "$env:PROCFORGE_DIR\sessions\<sid>\calls.jsonl" |
  ConvertFrom-Json | Group-Object actor | Select-Object Name,Count
```

## 8. 판정

| 기준 | 판정 | 근거 |
|---|---|---|
| M5.8(a) TUI+dist MCP 분해 (1.2·1.3·finalize 포함) | [ ] | 2절 4·8단계, 7절 |
| M7 dogfood (UI 의견 1건 → 부분 재실행 → finalize → 무인 exit 0) | [ ] | 2절 5~9단계, 5절 |
| 데이터 유실 0 (409·초안 보존) | [ ] | 3절 |
| 무인 실행 exit 0 | [ ] | 5절 |

- 종합: (통과/보류 + 사유 1~3줄)
- M8 후보(이번 dogfood에서 발견한 것만): 

## 9. 증거 링크

- 스크린샷: `docs/dogfood/…`
- run 로그: `<PROCFORGE_DIR>/runs/<runId>/log.ndjson`, `state.json`
- 세션 이벤트: `<PROCFORGE_DIR>/sessions/<sid>/events.jsonl`, `calls.jsonl`
- CI(코드 head): run URL
