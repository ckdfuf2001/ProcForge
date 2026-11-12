# M11-spec — 재분석 프롬프트에 lessons 포함 (첫 범위)

> 상태: 초안 (판정 요청 — §5).
> M11-0 조사(권장 1순위)의 사양화. 구현([M11-1-impl])은 §5 판정 뒤에 진행.

## §0 현황 (단계 0 실측·조사)
- 재분석 프롬프트는 `promptText` 한 덩어리다 (`services/redraft.ts:404-411`):
  고정 안내문 + `요청: ${input.request}` + `절차서 노드:\n${nodeList}` +
  허용 op 3종 + `형식: {"ops":[...]}`. lessons는 어디에도 들어가지 않는다.
- 지금 길이는 dog-a(노드 1개) 기준 **379자**다 (fake OpenCode로 prompt_async
  본문을 받아 실측). 상한(`REDRAFT_PROMPT_MAX_CHARS`, `redraft.ts:412`)과는
  거리가 멀다.
- 삽입 가능 지점: `runRedraft(input)`는 절차서 이름을 안다
  (`input.procedure`, `redraft.ts:297` + `procforgeDir` `:296`).
  프롬프트를 만드는 `nodeList` 직전(`:403` 앞)에서
  `readManualLessons(join(procforgeDir, "procedures", procedure, "lessons.md"))`
  (`services/lessons-agg.ts:131`)를 부르면 된다.

## §1 동작
- `lessons.md`의 수기 줄 최대 5개를 `readManualLessons`으로 읽어
  (M9-3-2 파서 재사용), 요청문 뒤·노드 목록 앞에 `참고 교훈:` 구획으로 넣는다.
  예: `참고 교훈:\n- 밤 집계를 먼저 한다.\n- …\n` + 기존 `절차서 노드:` 이후.
- 파일이 없거나 줄이 0개면 구획을 아예 생략한다 (빈 머리글도 넣지 않는다).
- 자동 구획(`proof:auto`)은 넣지 않는다 (수기만).

## §2 불변 조건
- 프롬프트에 들어가는 교훈은 승인 hash, 절차서 hash, golden 어디에도
  영향을 주지 않는다 (읽기 전용 참조 — 판정·저장 경로를 건드리지 않음).
- `draft.json`에는 사용한 교훈 줄 수를 `lessonsUsed:n`으로 기록한다
  (재현용, 판정에는 쓰지 않음).

## §3 테스트 계획 (3모드)
1. lessons가 있으면 `prompt_async` 본문에 구획과 그 줄들이 들어간다.
2. lessons가 없으면 본문에 `참고 교훈` 문자열이 0건이다.
3. 자동 구획 줄은 들어가지 않는다.
4. `draft.json`의 `lessonsUsed`가 실제 줄 수와 같다.

## §4 범위 밖
- M11-1 (To-Do 운영): 범위 정의부터 (M10-spec §1 이름만).
- M11-2 (병렬 실행): 범위 정의 + drive 하트비트·절차서당 1개와 충돌 검토.
- 128개 상한: provider 도구 수 제한 대응 (분할 전송·경고 방안).
- events 로그 회전: 인덱스 없음·회전 없음 유지 (M9-3-spec §1 범위 밖).

## §5 판정 요청 (최대 3개)
1. 줄당 상한: 수기 500자를 프롬프트에 그대로 넣을지, 더 짧게 자를지.
2. M10-4 가이드에 영향이 있는지 (가이드 단계 실행은 재분석과 별개인지).
3. `lessonsUsed`를 draft.json 최상위에 둘지, `model` 옆 하위 필드로 둘지.
