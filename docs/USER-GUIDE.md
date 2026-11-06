# Proof 사용자 가이드

모델과 대화로 절차서(반복 작업 묶음)를 만들고, 다시 실행하는 방법입니다.
개발·테스트 얘기는 나오지 않습니다.

## 1. 설치·빌드

준비물: Node 20 이상, pnpm.

```powershell
pnpm install
pnpm -r build
proof --version
```

`--version`이 버전을 찍으면 준비 끝입니다.

## 2. OpenCode 등록

프로젝트 루트의 `opencode.json`에 Proof MCP를 등록합니다.
`<REPO>`는 Proof 체크아웃 경로, `<저장소 경로>`는 `.procforge/`를 둘 곳입니다.

```json
{
  "mcp": {
    "proof": {
      "type": "local",
      "command": ["node", "<REPO>/packages/local/dist/main.js", "."],
      "enabled": true,
      "environment": {
        "PROOF_DIR": "<저장소 경로>",
        "PROCFORGE_DIR": "<저장소 경로>"
      }
    }
  }
}
```

- `PROOF_DIR`와 `PROCFORGE_DIR`는 같은 값을 씁니다.
- 등록·수정 뒤에는 OpenCode를 재시작합니다 (MCP는 시작할 때 연결됩니다).

## 3. 첫 절차서 만들기

OpenCode 대화창에서 프롬프트 `procforge_decompose`를 실행하고 요청을 입력합니다
(예: "a.pptx를 9월 월간보고서로 완성해라"). 이후 흐름은 이렇습니다.

1. 모델이 요청을 작은 단계 트리로 나눕니다 (`pf_split`).
2. 각 단계를 실행하고 결과를 보고합니다 (`pf_next` → 실행 → `pf_report`).
3. 실행 가능한 말단 단계는 확정합니다 (`pf_confirm_leaf`).
4. 전부 끝나면 `pf_finalize`로 절차서를 만듭니다
   (`procedures/<이름>/procedure.json`).

모델이 쓰는 도구 21종: `pf_start`, `pf_next`, `pf_report`, `pf_split`,
`pf_confirm_leaf`, `pf_retry`, `pf_ask_human`, `pf_approve`, `pf_advise`,
`pf_tree`, `pf_get_node`, `pf_lock`, `pf_reopen`, `pf_edit_args`,
`pf_edit_node`, `pf_refresh_catalog`, `pf_test`, `pf_finalize`,
`pf_run_start`, `pf_run_next`, `pf_run_supply`.

## 4. 다시 실행

확정된 절차서는 대화 없이 CLI로 다시 실행합니다.

```powershell
proof test procedures/<이름> --param month=2026-09
proof run procedures/<이름> --param month=2026-09 --out out/2026-09
```

- `test`는 검증(녹화 내용과 같은지 확인), `run`은 실제 실행입니다.
- `--out <dir>`을 주면 산출물이 그 폴더에 복사됩니다.
- 무인 실행(승인된 것만 자동 진행)은 `--unattended`를 붙입니다.
  외부 영향 단계는 사전 승인(`proof approve`)이 없으면 멈춥니다.
- 저장소를 바꾸려면 `--state <dir>`, 덮어쓰기는 `--force`를 씁니다.

## 5. 웹 UI

```powershell
proof ui
```

출력된 주소+토큰으로 브라우저에서 엽니다.

- 세션 목록에서 진행 상황을 보고, 노드에 의견을 답니다.
- 실행 화면에서 절차서를 실행·취소합니다.
- 의견을 남기면 모델이 같은 세션에서 이어서 다시 실행합니다
  (새 세션을 파지 마세요).

## 6. 누적형 절차서

매일·매달 쌓는 CSV처럼 "지난 실행 결과를 다음 실행이 이어받는" 절차서는
`procedure.json`에 선언합니다 (finalize가 만들지 않으므로 수동 추가,
추가 후 승인을 다시 받습니다).

```jsonc
// procedures/monthly-2026-09/procedure.json
"accumulate": [{ "path": "sales.csv", "node": "1.3" }]
// 노드 1.3의 args 옆:
// "stateWrites": [{ "key": "lastId", "from": "$1.3.lastId" }]
```

- `accumulate`는 산출 파일이 실행 사이에 보존됩니다 (`.procforge/state/`).
- `stateWrites`는 작은 상태값을 저장하고 `${state.lastId}`로 읽습니다.
- 재확정해도 `state.json`·`approvals.json`·`approved/`는 유지됩니다.
  실행 중인 절차서를 확정하면 거부됩니다 (끝나고 다시 확정하세요).

## 7. 실행 기록 보기

실행 한 번마다 `.procforge/runs/<runId>/` 아래에 남습니다.

- `report.json`: 노드별 결과(pass/fail/…)와 소요 시간, 전체 집계.
- `metrics.json`: 노드 산출 CSV의 행 수.
- `runs/by-procedure/<이름>/latest.json`: 그 절차서의 최근 실행 1건.
- `--out` 복사본은 지정한 폴더에 남습니다.

## 8. 주의사항·문제 해결

- OpenCode에 도구가 안 보이면: OpenCode 재시작 → `opencode.json` 경로·오타 확인.
- "카탈로그(schemaHash) 불일치"로 중단되면: 도구 사양이 바뀐 것이니 절차서를
  다시 확정(finalize)하거나 재녹화(`test --mode record`)하세요.
- 실행이 겹치면(`conflict`): 같은 절차서가 이미 돌고 있습니다. 끝나고 다시 하세요.
- 임시 폴더가 쌓이면(`%TEMP%/pf-*`): 저장소 안의 정리 스크립트로 확인합니다.
  먼저 개수만 보고, 지울 때는 `--apply`를 붙입니다.

```powershell
node scripts/tmp-clean.mjs
node scripts/tmp-clean.mjs --apply
```

2일 넘은 `pf-*` 폴더만 지우고, 실행 중인 폴더는 건드리지 않습니다.
