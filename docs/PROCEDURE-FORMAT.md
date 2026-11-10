# procedure.json 공개 포맷 (v1)

절차서 재실행 입력의 단일 원천. `proof test procedures/<name>` 및
`pf_test({procedure})`가 이 파일만으로 replay한다.

```jsonc
{
  "format": "procforge-procedure",   // 고정
  "version": 1,                      // 포맷 버전 (파서는 같은 major만 허용)
  "name": "monthly-2026-09",         // [A-Za-z0-9_-]+
  "sourceSession": "<uuid>",         // 원본 세션 id (추적용)
  "createdAt": "<iso>",
  "params": {
    "<name>": { "type": "string", "default": "...", "description": "..." }
  },
  "toolCatalog": [
    { "server": "...", "name": "...", "inputSchema": {}, "schemaHash": "..." }
  ],
  "nodes": [
    {
      "id": "1.2",                   // \d+(\.\d+)*
      "parentId": "1",               // 루트는 null
      "goal": "...",
      "depth": 1,
      "dependsOn": ["1.1"],
      "children": [],
      "tool": { "server": "...", "name": "...", "schemaHash": "..." }, // leaf만
      "args": { "<arg>": { "kind": "fixed", "value": ... }
              | { "kind": "var", "ref": "${params.x}" | "$1.1.output.y" }
              | { "kind": "generated", "instruction": "...", "inputs": [], "constraints": [] } },
      "sideEffect": "none",
      "constraints": [ { "id": "...", "kind": "...", "spec": {}, "source": "auto|human" } ],
      "golden": {
        "fixtures": ["fixtures/1.2/<uuid>/0-report.md"],
        "output": "<resultSummary>",
        "attemptId": "<uuid>",       // goldenArgs 출처 (선택)
        "ignore": ["<json-path>", "..."]  // 출력 비교 제외 경로
      },
      "goldenArgs": { "<arg>": "실행값" }  // generated 인자 해결용
    }
  ]
}
```

규칙:
- `tests/fixtures/`, `tests/cassettes/`, `tests/fixtures-manifest.json`은
  세션 저장소와 동일 상대 구조. fixture 경로는 `golden.fixtures`와 일치해야 한다.
- `schemaHash`가 카탈로그와 다르면 실행 전 경고 후 중단 (재녹화 필요).
- params 재바인딩: import 시 `params` 기본값을 `--param k=v`로 덮어쓴다.
  `var` 참조는 새 값으로, `fixed`는 그대로 (finalize 경고 참조).
- procedure.json 형식은 불변. 아래 2종은 실행 기록물이며 별도 파일이다.

## runs/&lt;runId&gt;/metrics.json (M9-2-2)
실행 종료 시 노드 산출 CSV 행 수. 계산 실패는 해당 파일만 rows 생략+사유,
run 결과에 영향 없음.
```jsonc
{ "runId": "<uuid>", "procedure": "<name>", "at": "<iso>",
  "nodes": [{ "nodeId": "1.1", "files": [{ "path": "data.csv", "rows": 859 }] }] }
```

## runs/by-procedure/&lt;name&gt;/latest.json (M9-2-3)
절차서별 최근 종료 실행 1건. 종료 상태(done/failed/cancelled)일 때만 원자 갱신.
```jsonc
{ "runId": "<uuid>", "status": "done|failed|cancelled", "at": "<iso>" }
```

## procedures/&lt;name&gt;/lessons.md (M9-3)
교훈 1줄 목록. 수기 구획(`- `로 시작하는 줄, 앞에서부터 최대 5개,
500자 초과분 절단)과 자동 구획(`<!-- proof:auto -->`부터
`<!-- /proof:auto -->`까지 — 집계 숫자만, Proof가 다시 씀)으로 나뉜다.
자동 구획 밖은 바이트 단위로 보존된다. 파일이 없어도 정상이다.
