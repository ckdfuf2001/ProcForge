# M2/M2.5 수동 검증 (OpenCode + ProcForge local MCP)

## 0. 도구 구성 (M2.5)

등록 도구 15개 (결정적 순서):
`pf_start`, `pf_next`, `pf_report`, `pf_split`, `pf_confirm_leaf`, `pf_retry`,
`pf_ask_human`, `pf_approve`, `pf_advise`, `pf_tree`, `pf_get_node`, `pf_lock`,
`pf_reopen`, `pf_refresh_catalog`, `pf_test`.
`pf_finalize`/`pf_test`는 M5/M3까지 미등록. 구 `pf_resolve`는 위 4개로 분리됨.
프롬프트 `procforge_decompose` 1개 등록.

환경변수: `PROCFORGE_READ_ONLY=1`이면 읽기 3종(`pf_next`, `pf_tree`, `pf_get_node`)만 등록.
`PROCFORGE_SESSION_TTL_DAYS`(기본 30), `PROCFORGE_DIR`, `PROCFORGE_PROJECT_ROOT`.

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

1. OpenCode 대화창에서 MCP 목록에 `procforge`와 위 13개 도구가 보이는지 확인.
2. `procforge_decompose` 프롬프트 확인: OpenCode는 MCP prompts를 지원한다
   (공식 문서 "MCP prompts become commands", 클라이언트 `listPrompts`/`getPrompt` 보유).
   프롬프트가 노출되지 않는 클라이언트에서도 `pf_start` 응답 instruction에 동일 전문이 포함되므로 무방.
3. `pf_start({ request: "월간보고서 초안", params: { month: "2026-09" } })` 호출
   → `sessionId`(UUID)와 루프 안내 + sandbox 안내 instruction 반환.
   - `toolCatalog` 생략 시 opencode.json의 mcp 서버들을 자동 수집 (실패 서버는 `warnings`).
   - 수집 결과는 `.procforge/cache/catalog.json`에 10분 캐시. 강제 갱신은 `pf_refresh_catalog`.
4. `pf_next({ sessionId })` → 노드 요약 + instruction 수신.
5. 노드가 크면 `pf_split({ sessionId, nodeId, children: [...] })`.
6. leaf 실행 후 `pf_report({ ..., selfVerdict: "pass", selfReason: "..." })`
   → `probing` 유지 + `pf_confirm_leaf` 요구 instruction 확인.
7. `pf_confirm_leaf({ sessionId, nodeId, tool, argSpecs })` → `leaf` 확정 + `golden` 기록.
8. 모든 노드 leaf 후 `pf_next` → `{ done: true }`.
9. `.procforge/sessions/<sid>/` 아래 `session.json`, `nodes/*.json`,
   `fixtures/<nodeId>/<attemptId>/` 파일 존재 확인. `pf_tree` 기본 조회로 상태별 개수 확인.
10. 에러 확인: 없는 세션 id로 호출 → `isError` + `code=session_not_found` + 다음 행동 hint.

## 4. MCP Inspector 점검

```powershell
npx @modelcontextprotocol/inspector node packages/local/dist/main.js <projectRoot>
```

브라우저에서 Tools 탭: 13개 도구 목록·입력 스키마·annotations 확인.
`pf_start` → `pf_next` → `pf_split` 순으로 호출해 structuredContent 응답 확인.
Prompts 탭: `procforge_decompose` 조회. Errors 탭에 스택 노출이 없는지 확인.

## 5. runner 사용 (M3)

```powershell
# 녹화 (실제 도구 호출)
node packages/local/dist/cli.js test --session <sid> --mode record
# 회귀 (LLM·외부 서버 없이 녹화본만)
node packages/local/dist/cli.js test --session <sid> --mode replay --junit report.xml
# 서브트리 / 변경분만
node packages/local/dist/cli.js test --session <sid> --node 1.2 --mode replay
node packages/local/dist/cli.js test --session <sid> --mode replay --changed
# golden 갱신 (의도적 변경 후에만)
node packages/local/dist/cli.js test --session <sid> --mode record --update-golden
```

`--update-golden` 없이는 golden/cassette를 절대 수정하지 않는다.
MCP에서는 `pf_test` 도구로 동일 실행 (요약 + report 경로 반환).

## 6. 문제 해결

- MCP 연결 실패: `node packages/local/dist/main.js <projectRoot>`를 직접 실행해 stdio 응답 확인.
- 카탈로그 수집 실패: `warnings` 필드에 서버별 사유 기록. `enabled: false` 서버는 건너뜀.
- 외부 부작용 노드: `pf_report` 대신 `pf_resolve(ask_human)` 후 사람 승인 절차.
