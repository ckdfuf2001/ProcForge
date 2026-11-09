# M9-3-spec 초안 — 교훈 집계 (메모리 4층)

> 상태: 초안 (판정待ち). M9-2 §5 판정 4 (B 확정)의 구체화.
> 본 문서는 코드 읽기만으로 작성. 테스트 실행 없음.

## §0 현황 5항목 (위치 / 사실 / 빈틈)

### 1. lessons.md 생산자 없음 — 보존만 있음
- 위치: `packages/local/src/services/procedureWriter.ts:241-247`
  (SIDECAR_KEEP에 `lessons.md` 포함), `:329-332` (재finalize 시 보존 복사).
- 사실: lessons.md를 쓰는 생산 코드는 없다 (사용자 수기).
  `m11-sidecar.test.ts:47-52`는 수기 작성 후 재finalize 바이트동일만 검증한다.
  형식 규약 없음 (테스트는 `"# 교훈\n- 밤 집계를 먼저 한다.\n"` 예시일 뿐).
- 빈틈: 수집 스키마(1줄 형식·길이·run 연결)가 없어 집계가 파싱할 기준이 없음
  (§2에서 정의).

### 2. history/는 적용 전 판본 보관 — 교훈 텍스트 아님
- 위치: `packages/local/src/app/app.ts:4111-4115`
  (`history/<stamp>-<hash12>.json`에 적용 전 procedure.json 원문).
- 사실: 재사용 메모리(판본 복원용). 교훈 문장 저장소가 아니다.
- 빈틈: 없음 (M9-3 집계 입력이 아님 — 판본과 교훈을 혼동하지 않는다).

### 3. 소비자 없음 — 유사분석은 lessons를 보지 않음
- 위치: `packages/local/src/services/similar.ts:65-122`
  (`listProceduresWithLatest`: goals + latest + metrics만 반환).
- 사실: M10-1 유사분석 입력은 이름·목표·최근상태·규모뿐이다.
  lessons 참조 코드는 없다.
- 빈틈: 집계 후 M10-1 연동 여부 (§5 판정 3).

### 4. 교훈 재료 (events/calls/attempts), 집계 저장소·쿼리 없음
- 위치: M9-2-spec §0-5 (events.jsonl, cassettes, attempts, node hash).
- 사실: 재료는 있으나 attempt에 node hash가 기록되지 않아 조인 시 재계산 필요.
  집계 저장소·쿼리 코드는 없다.
- 빈틈: M9-3 집계는 lessons.md(수기)만 대상으로 한다.
  자동 추출(LLM 요약)은 범위 밖 (M10 불변: Proof가 직접 LLM을 호출하지 않음,
  `docs/M10-spec.md:27-31`).

### 5. latest/metrics 인덱스 현행
- 위치: `packages/local/src/services/procedure-latest.ts:11-30`
  (종료 상태일 때만 `runs/by-procedure/<name>/latest.json` 원자 갱신),
  `similar.ts:43-63` (metricsSummary: 파일 수·행 합, 순위 미사용).
- 사실: 집계가 참조할 절차서별 최신 실행 포인터는 이미 있다.
- 빈틈: lessons용 인덱스는 없음 (§2 집계 방식 판정과 연결).

## §1 목표
- 절차서별 수기 교훈(`lessons.md`)을 정해진 형식으로 모으고,
  다음 유사분석·재분석이 참조할 수 있게 읽는다.
- 범위: ① 수집 스키마 (§2), ② 집계 읽기 (§2),
  ③ M10-1 연동 여부 판정 (§5 판정 3). 문서화는 M9-2-4 방식 준용.
- 범위 밖: 자동 생성·요약 (수기만), history/ 판본의 교훈 전용화,
  MCP 표면 변경 (신규 도구 없음).

## §2 수집 스키마 + 집계 (B안)
- 위치 (불변): `procedures/<name>/lessons.md` (경로 유지).
  재finalize 보존 현행 유지 (`procedureWriter.ts:241-247`).
- 항목 형식: `# 교훈` 헤더 아래 `- ` 불릿 1줄 = 1교훈.
  선택 접두 `[run:<runId>]`가 있으면 latest/report로 대조 가능.
  예: `- [run:8f463c…] 밤 집계를 먼저 한다.`
- 관용: 헤더·불릿 밖 줄은 무시한다 (기존 자유형식 호환 — 파싱 실패가
  집계 전체를 깨뜨리지 않음). 파일 없음은 빈 목록 (정상).
- 줄 길이: 1줄 500자 상한 제안 (`why` 1~500자 선례, `app.ts:4099-4108`).
  초과 처리 (절단 vs 거부)는 판정 필요 (§5 판정 4).
- 집계 방식 (권고): 읽기 시점 집계 — 새 파일·쓰기 경로 없음.
  이유: 쓰기 경로 추가 시 동시성·원자성·stale 문제가 생기며,
  참조용 latest.json도 읽기 시점 조립(`similar.ts`)이 선례다.
  확정은 판정 필요 (§5 판정 2).
- 집계 출력: `{ procedure, lessons: [{ text, runId? }] }[]` (메모리 내,
  저장 안 함 — 권고안 기준).

## §3 저장 위치·파일 형식 (`.procforge/` 아래, 불변 목록 준수)
- `procedures/<name>/lessons.md` — 현행 유지 (형식 규약만 추가).
- `procedures/<name>/history/` — 현행 유지 (판본 보관, 교훈 아님).
- `runs/by-procedure/<name>/latest.json` — 현행 유지 (대조용).
- 불변 준수: `pf_*` 21종·`procforge_decompose`·`format`·
  `.procforge` 루트·`server.ts:618`/`app.ts:160` 건드리지 않음
  (M9-2-spec §3과 동일).

## §4 구현 커밋 분할안

### M9-3-1 수집 파서+테스트
- lessons.md 줄 파서 (헤더·불릿·`[run:]` 접두·500자·파일없음→빈 목록).
- 테스트 5종: ① 정상 2줄 ② 자유형식 줄 무시 ③ 파일 없음 ④ 500자 초과
  ⑤ `[run:]` runId 추출. 기존 테스트 파괴 0.

### M9-3-2 집계 읽기
- §5 판정 2 확정 방식대로 구현 (권고: 읽기 시점).
- M10-1 연동은 판정 3 확정 후 (연동 시 `SimilarProcedure` 확장 + 테스트).

### M9-3-3 문서
- DEV-GUIDE lessons 작성법 1절 + PROCEDURE-FORMAT lessons.md 형식 +
  DECISIONS [M9-3] 판정 기록 + M10-dogfood 주의문 (M9-2-4 방식 준용).

## §5 판정 요청 (판정자)
1. B 범위 확정 (수집 스키마 있음 vs A 파일목록만).
2. 집계 방식 확정 (읽기 시점 권고 vs 인덱스 파일).
3. M10-1 연동 여부 (유사분석 결과에 lessons 포함 여부·순위 반영 여부).
4. 줄 길이 상한 (500자 제안) + 초과 처리 (절단 vs 거부).
5. lessons.md 미존재 시 동작 (빈 목록 제안).
