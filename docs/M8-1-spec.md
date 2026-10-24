# M8-1 — 계속 신호 문구 + 짝 유지 사양

상태: **구현 완료 (2026-10-24) · 실측 대기**
관련: M7-1(신호 B/A/C), M7-ui4(토큰·설정), M8-1-0(자기 재검증), DECISIONS `[M8-1]`

## 목표

사람이 UI에서 의견을 남기면 OpenCode 모델이 **새 PF 세션을 만들지 않고**
같은 세션에서 `pf_next`로 이어서 진행하게 한다. 지금은 신호 문구가 "계속"
한 마디라서 모델이 새 세션(`pf_start`)을 새로 파는 일이 반복된다.
모델이 보는 도구 이름은 OpenCode의 MCP 등록 키에 따라 달라지므로
문구는 **서버 설정**으로 접두어를 받고, 모르면 접두어 없이 phrasing 한다.

## 0. 현행 보고 (2026-10-24)

| 항목 | 현행 | 근거 |
| --- | --- | --- |
| `signalOnly` 입력값 | `{ sessionId, openCodeSessionId?, text? }` | `packages/local/src/app/app.ts:1403` |
| 신호 text 출처 | `input.text ?? cfg.text ?? "계속"` (cfg = 서버 설정 `this.signal`) | app.ts:1412, 1433 |
| `cfg.text` 출처 | 서버 설정(`AppDeps.signal.text`)만. UI 서버는 `link`/`baseUrl`/`mode`/`serverVersion`/`timeoutMs` 를 400 으로 막음 | app.ts:1461-1482, ui-server.ts:660 |
| B(전송) text 생성 | app.ts:1433 → `sendContinue` → `POST /session/:id/message {parts:[{type:"text",text}]}` (mode a 면 `POST /tui/append-prompt`) | opencode-link.ts:287, 292 |
| C(copyText) 생성 | **두 곳** — app.ts:1412 (미전송 분기)와 opencode-link.ts:260 (sendContinue 실패 분기). 둘 다 `${text}\nOpenCode에서 '계속'이라고 입력하세요.` | app.ts:1412, opencode-link.ts:20, 260 |
| 짝 검사 | PF 세션의 최신 짝(`latestPairingSessionId`) → 그 ocId 의 **현재** 짝이 다른 PF 세션이면 "다른 세션과 짝" | app.ts:1448, 1421-1424 |
| 짝 세션 생존 확인 | **없음** (OpenCode 서버에 세션이 살아 있는지 조회하지 않는다) | — |
| 모델이 보는 도구 이름 | OpenCode 의 MCP 등록 키로 결정된다. `packages/local/src/server.ts:149` 의 MCP 서버 이름은 `procforge-local` 이지만, 모델이 보는 도구 이름은 opencode.json 의 `mcp` 키(예: `procforge` → `procforge_pf_next`)다. ProcForge 는 이 키를 모른다(사용자 설정) | opencode-link.ts:96, 167 |
| 도구 호출 감지 | 접두어 무관 — `tool` 문자열에 `pf_` 가 들어가는지만 본다 | opencode-link.ts:167 `isPfToolPart` |

**해석**: B 와 C 의 문구가 두 함수에서 각각 조립되고 "계속" 이 양쪽에 하드코딩
되어 있다(하나로 모을 지점이 없다). 짝 검사는 "PF→oc 방향"만 보고
"oc→PF 방향"은 현재 짝 map 만 본다. oc 세션이 서버에서 사라진 경우는
구분하지 못한다(전송 시도 → 404 → "전송 실패").

## a. 신호 문구

- **문구 함수 하나**: `signalText({ sessionId, nodeId, toolPrefix })`.
  ```
  ProcForge 세션 <sid>의 노드 <nid>에 사람 의견이 추가됐습니다.
  새 세션을 만들지 말고(pf_start 금지) <prefix>pf_next({sessionId:"<sid>"})로 이어서 진행하세요.
  ```
- B(전송 text) 와 C(copyText) 는 **같은 함수**의 같은 문자열을 쓴다.
  (C 는 "계속이라고 입력하세요" 같은 덧붙임이 아니라 그 문구 그대로다 —
   붙여넣은 문구를 모델이 그대로 읽는다.)
- **의견 본문은 넣지 않는다.** 모델은 `pf_next` 로 읽는다.
- 길이 상한 500자(넘으면 자른다).
- `signalOnly` 가 `nodeId` 를 받는다. `uiAdviseAndSignal` 이 전달한다.
- 도구 이름 접두어는 **서버 설정**에서 받는다(`signal.toolPrefix`).
  모르면 접두어 없이 "ProcForge의 pf_next 도구" 로 쓴다.
- 클라이언트가 신호 문구를 정할 수 없다(`link.text` → 400).

## b. 짝 유효성 (전송 전, 순서대로)

1. `GET /session/:ocId` 로 생존 확인 → 없으면 **미전송**, C "짝 세션 없음".
2. 역방향: 그 ocId 의 **최신 짝**이 다른 PF 세션이면 **미전송**, C "다른 세션과 짝".
3. 양방향 최신이 일치할 때만 전송.

문구 우선순위: `미설정 주소 → 짝 없음 → 짝 세션 없음 → 다른 세션과 짝 → 전송 실패`.
(기존 "전송 실패" 앞쪽에 두 분기를 끼워 넣는다.)

## c. UI 경고

- 의견 저장 전 `previewEdit` 가 `selfReverify:true` 이고 그 세션에 **확정 절차서**가
  있으면 확인창:
  `이 노드는 절차서 <name>에 포함됩니다. 재확정 전까지 무인 실행이 exit 1로 멈춥니다.`
- `uiRun` 결과와 실행 화면에 `needs_reverify` 수를 표시한다.
  (무인 실행은 재검증 대기 노드가 있으면 exit 1 — M8-1-0 `[M8-1-0-i]`.)

## d. 타임라인 보정

1. 라운드의 **부모 노드**에 달린 이벤트(advise 등)를 그 라운드의 `parentEvents`
   로 표시한다. (그 분해를 만든 계기가 부모에 붙은 의견이다.)
2. **ID 재사용**: 같은 노드를 두 번 분해해 자식 id 가 재사용되면, 생성 구간은
   `(id, 생성 revision)` 단위로 계산한다.

## e. 테스트

- 가짜 OpenCode 로 짝 분기 ①②③ 각각.
- B 전송 text == C copyText.
- text 에 sid·nid·"pf_start 금지" 가 있고 **의견 본문은 없다**.
- c 의 확인창 E2E.
- d 의 (1)(2).

## f. docs

- DECISIONS `[M8-1]` 행 추가.

## 완료 기준 (실측)

> 새 PF 세션 실측에서 UI 의견 → 모델이 **같은 세션에** `pf_next` 호출,
> calls.jsonl 에 신호 이후 `pfStart` 0건, 해당 노드만 재확정.

**실측은 사장님 수행 대기로 남긴다**(이 저장소에서는 자동 검증 불가 —
가짜 OpenCode 로는 실모델 호출을 대신할 수 없다).

## 항목별 커밋표 (2026-10-24)

| 커밋 | 내용 |
| --- | --- |
| `65a5cbd` | [M8-1-spec] 이 사양 문서 + DEV-GUIDE §8 링크 |
| `700e412` | [M8-1-a] signalText() 하나 — B 전송 == C 복사, nodeId, 접두어, 500자 |
| `84e9021` | [M8-1-b] 짝 유효성 ①②③(생존·역방향·양방향) + 문구 우선순위 |
| `782338c` | [M8-1-c] UI 확인창(확정 절차서 leaf) + needs_reverify 표시 |
| `1a047cf` | [M8-1-d] parentEvents + 세대별 이벤트(id 재사용) |
| `18e1802` | [M8-1-e] e2e: 가짜 OpenCode 생존 확인 경로 + C 문구 정합 |

## 검증

- 로컬: shared 76 / core 124 / local 487(+2 skip) 통과, E2E 16건 통과
  (`m8-1-signal.spec.ts` 확인창 1건 포함).
- 남은 것: **실측**(사장님 수행 대기) — 완료 기준은 위 실측 문단과 같다.
