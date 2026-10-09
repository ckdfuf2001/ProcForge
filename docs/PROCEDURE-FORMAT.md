# procedure.json 공개 포맷 (v1)

절차서 재실행 입력의 단일 원천. `procforge test procedures/<name>` 및
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
