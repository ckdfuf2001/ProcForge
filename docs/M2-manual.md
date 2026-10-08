# M2 수동 검증 (OpenCode + ProcForge local MCP)

## 1. 빌드

```powershell
pnpm install
pnpm -r build
```

## 2. OpenCode에 local MCP 등록

프로젝트 루트 `opencode.json` (없으면 생성)에 추가:

```json
{
  "mcp": {
    "procforge": {
      "type": "local",
      "command": ["node", "D:/opencode/opencode-exe/workspace/repos/ProcForge/packages/local/dist/main.js", "."],
      "enabled": true
    }
  }
}
```

- `command` 세 번째 인자(`.`)는 프로젝트 루트다. 생략 시 `PROCFORGE_PROJECT_ROOT` 환경변수, 그것도 없으면 cwd.
- `.procforge/` 저장 위치 변경: `PROCFORGE_DIR` 환경변수.
- 전역 등록은 `%USERPROFILE%/.config/opencode/opencode.json`에 동일 항목 추가.

주의: 수정 후 OpenCode 재시작 (MCP 서버는 시작 시 연결).

## 3. 확인 절차

1. OpenCode 대화창에서 MCP 목록에 `procforge`와 도구
   `pf_start/pf_next/pf_report/pf_resolve/pf_advise/pf_tree/pf_lock/pf_reopen`이 보이는지 확인.
2. `pf_start({ request: "월간보고서 초안", params: { month: "2026-09" } })` 호출
   → `sessionId`와 sandbox 안내 instruction 반환.
   - `toolCatalog` 생략 시 opencode.json의 mcp 서버들을 자동 수집 (연결 실패 서버는 `warnings`에 기록).
3. `pf_next({ sessionId })` → 노드 + instruction 수신.
4. 노드가 크면 `pf_resolve({ sessionId, nodeId, decision: "split", children: [...] })`.
5. leaf 실행 후 `pf_report({ ..., selfVerdict: "pass", selfReason: "..." })`
   → `probing` 유지 + `pf_resolve(leaf)` 요구 instruction 확인.
6. `pf_resolve({ decision: "leaf", tool, argSpecs })` → `leaf` 확정 + `golden` 기록.
7. 모든 노드 leaf 후 `pf_next` → `{ done: true }`.
8. `.procforge/sessions/<sid>/` 아래 `session.json`, `nodes/*.json`,
   `fixtures/<nodeId>/<attemptId>/` 파일 존재 확인.
9. `pf_finalize`/`pf_test`는 `unimplemented` (M5/M3) 반환 확인.

## 4. 문제 해결

- MCP 연결 실패: `node packages/local/dist/main.js <projectRoot>`를 직접 실행해 stdio 응답 확인.
- 카탈로그 수집 실패: `warnings` 필드에 서버별 사유 기록. `enabled: false` 서버는 건너뜀.
- 외부 부작용 노드: `pf_report` 대신 `pf_resolve(ask_human)` 후 사람 승인 절차.
