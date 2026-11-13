# M11-spec — 재분석 프롬프트에 lessons 포함 (첫 범위)

> 상태: 확정 (판정자 [M11-spec] — §5 판정 반영).
> M11-0 조사(권장 1순위)의 사양화. 구현은 [M11-1-impl]에서 진행.

## §0 현황 (단계 0 실측·조사)
- 재분석 프롬프트는 `promptText` 한 덩어리다 (`nodeList`는 `:403`,
  `promptText` 본문은 `:404-411`):
  고정 안내문 + `요청: ${input.request}` + `절차서 노드:\n${nodeList}` +
  허용 op 3종 + `형식: {"ops":[...]}`. lessons는 어디에도 들어가지 않는다.
- 지금 길이는 dog-a(노드 1개) 기준 **379자**다 (fake OpenCode로 prompt_async
  본문을 받아 실측). 상한(`REDRAFT_PROMPT_MAX_CHARS = 20000`,
  `redraft.ts:71` · 초과 시 failed 저장 `:412-420`)과는 거리가 멀다.
- 삽입 가능 지점: `runRedraft(input)`는 절차서 이름을 안다
  (`input.procedure`, `redraft.ts:297` + `procforgeDir` `:296`).
  `nodeList` 직전(`:403` 앞)에서
  `readManualLessons(join(procforgeDir, "procedures", procedure, "lessons.md"))`
  (`services/lessons-agg.ts:131`)를 부르면 된다.
- 가이드 영향 없음: `runRedraft`는 `createRedraft` (`app.ts:3718`)와
  `requestRedraft` 백그라운드 (`app.ts:3859`, 호출원 `ui-server.ts:857`
  `POST /api/drafts`뿐)에서만 호출된다. `advanceGuide`·`driveRun`·
  `pollGuideRun` 경로는 호출하지 않는다 (rg 전수 확인).

## §1 동작
- `lessons.md`의 수기 줄 최대 5개를 `readManualLessons`으로 읽어
  (M9-3-2 파서 재사용), 요청문 뒤·노드 목록 앞에 `참고 교훈:` 구획으로 넣는다.
  예: `참고 교훈:\n- 밤 집계를 먼저 한다.\n- …\n` + 기존 `절차서 노드:` 이후.
- 줄당 상한은 파서와 같은 500자를 그대로 쓴다. 잘린 줄(`truncated:true`)은
  끝에 `…`을 붙여 넣는다 (파서와 한 곳에서만 관리).
- 구획을 넣었을 때 프롬프트 전체가 `REDRAFT_PROMPT_MAX_CHARS`를 넘으면,
  교훈을 뒤쪽 줄부터 하나씩 빼서 한도 안에 맞춘다.
  교훈 때문에 재분석이 실패하는 일은 없다.
- 파일이 없거나 줄이 0개면 구획을 아예 생략한다 (빈 머리글도 넣지 않는다).
- 자동 구획(`proof:auto`)은 넣지 않는다 (수기만).
- 읽기 실패(권한·깨진 인코딩 등)는 교훈 0줄로 처리한다.
  stderr에 `[procforge:warn]` 1줄만 남기고 재분석은 계속한다.

## §2 불변 조건
- 프롬프트에 들어가는 교훈은 승인 hash, 절차서 hash, golden 어디에도
  영향을 주지 않는다 (읽기 전용 참조 — 판정·저장 경로를 건드리지 않음).
- `draft.json` 최상위에 사용한 교훈 줄 수를 `lessonsUsed:n`으로 기록한다
  (재현용, 판정에는 쓰지 않음. `model`은 모델 정보만 담는다).

## §3 테스트 계획 (3모드)
1. lessons가 있으면 `prompt_async` 본문에 구획과 그 줄들이 들어간다.
2. lessons가 없으면 본문에 `참고 교훈` 문자열이 0건이다.
3. 자동 구획 줄은 들어가지 않는다.
4. `draft.json`의 `lessonsUsed`가 실제 줄 수와 같다.
5. 교훈을 넣어 한도를 넘기면 줄을 빼서 맞추고, `lessonsUsed`가 실제 넣은 줄 수와 같다.
6. 교훈이 있어도 없어도 원본 `procedure.json`의 hash와 `approvals.json` 바이트가 변하지 않는다 (§2 불변 조건 검증).

## §4 범위 밖
- M11-1 (To-Do 운영): 범위 정의부터 (M10-spec §1 이름만).
- M11-2 (병렬 실행): 범위 정의 + drive 하트비트·절차서당 1개와 충돌 검토.
- 128개 상한: provider 도구 수 제한 대응 (분할 전송·경고 방안).
- events 로그 회전: 인덱스 없음·회전 없음 유지 (M9-3-spec §1 범위 밖).

## §5a 확정(M11-spec)
1. 줄당 상한: 수기 500자를 그대로 쓴다. 잘린 줄(`truncated:true`)은 끝에 `…`을 붙인다. 한도 초과 시 교훈을 뒤쪽 줄부터 하나씩 뺀다.
2. M10-4 가이드 영향: 없음. 가이드 실행 경로는 재분석 프롬프트를 거치지 않는다.
3. `lessonsUsed` 위치: `draft.json` 최상위 (`model`은 모델 정보 전용).

## §5b 확정(M11-spec2)
1. remember: Proof는 remember를 쓰지 않으므로 추가 실측 없이 닫는다.
2. 128개 상한: 안 a(문서)를 채택한다. 안 b는 MCP 표면 증가로 보류한다.
3. M11-1: 다음 배치에서 사양 초안을 단독으로 쓴다. 128 방안과 묶지 않는다.

## §6 Basic auth 버전 명시
- 검증 버전: OpenCode 1.18.32 (무인증 401·오답 401·정답 200 확인,
  `docs/M10-0-opencode-api.md` §8·실측표 #6).
- 1.18.18은 미검증으로 둔다 (npx 등으로 별도 포트 실측이 가능해지면 그때 1회 실측).
- USER-GUIDE §2에 "동작 확인 버전: OpenCode 1.18.32 (Basic auth 포함,
  1.18.18은 미검증)." 1줄을 둔다.

## §7 128개 상한 대응 후보 (최대 3안)
- 전제: Proof MCP가 노출하는 도구는 21개다
  (`packages/local/src/server.ts:58-80` `TOOL_NAMES`,
  `APP_METHODS` 1:1 대응 검증 `packages/local/test/app-tools.test.ts:9`).
  단독 사용에는 여유가 있고, 다른 MCP와 합쳐질 때만 128 상한에 걸릴 수 있다.
- 안 a (문서, 권장): USER-GUIDE에 합계 확인법과 초과 시 대처
  (불필요한 MCP 끄기)를 적는다. 코드 변경 없음.
- 안 b (서버 옵션): 읽기 전용 2종(`pf_tree`, `pf_get_node` — 현행
  `READ_ONLY_TOOLS`, `server.ts:82`)만 노출하는 축소 모드를 둔다.
  MCP 표면 추가이므로 별도 판정 필요.
- 안 c (현상 유지): 보고가 들어올 때까지 두지 않는다. 21개라 단독 사용에는
  여유가 있다.
