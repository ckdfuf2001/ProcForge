# ProcForge 개발 가이드 v2

> 이 문서는 ProcForge 개발의 단일 기준 문서다. 작업 전에 반드시 전체를 읽는다.
> 최종 갱신: 2026-10-09 / 기준 커밋: `ac97ac6` (M4.1-8, CI run 20 green)

---

## 0. 공통 규칙

### 0.1 문서 업데이트 규칙 (필수)

에이전트는 작업하면서 아래 문서를 직접 갱신한다. 문서 갱신은 해당 항목 커밋에 함께 넣는다. 별도 커밋으로 미루지 않는다.

| 문서 | 언제 | 무엇을 |
|---|---|---|
| `docs/DEV-GUIDE.md` (이 파일) | 항목 완료 시 | 8절 진행 현황 표의 체크박스, 커밋 SHA, run URL |
| `docs/DEV-GUIDE.md` | 가이드와 구현이 달라질 때 | 해당 절 본문 수정 + 9절 변경 이력에 사유 기록 |
| `docs/DECISIONS.md` | 가이드에 없는 가정을 할 때 | `[M<x>-<n>] 제목 — 가정/이유/영향` |
| `docs/REVIEW-<M>.md` | 마일스톤 종료 시 | 7절 자가 점검 결과 |
| `README.md`, `SKILL.md`, `command.md` 템플릿 | 사용자에게 보이는 동작이 바뀔 때 | 실제 구현과 일치하게 |

규칙:
- 가이드 내용을 임의로 생략하거나 바꾸지 않는다. 바꿔야 하면 본문을 고치고 9절에 "무엇을, 왜"를 남긴다.
- 진행 현황 표는 실제 상태만 적는다. CI가 green이 아니면 체크하지 않는다.
- 막힌 항목은 `[!]`로 표시하고 원인과 필요한 결정을 적은 뒤 다음 항목으로 넘어가지 말고 보고한다.

### 0.2 작업 규칙

- 커밋은 항목별로 `M<x>-<n> 요약` 형식. 회귀 테스트를 반드시 같이 넣는다.
- 푸시 전 `git status --porcelain`이 비어 있어야 한다. 클린 클론에서 `pnpm install --frozen-lockfile` → build → test 통과를 확인한다.
- 완료 기준: GitHub Actions에서 ubuntu-latest, windows-latest 둘 다 success. run URL을 보고한다.
- 보고는 `git diff --stat <base>..<head>` 기준으로, 실제로 바뀐 것만 쓴다.
- 테스트 명령: `pnpm -r run test -- --run --testTimeout=20000 --hookTimeout=20000`
- MCP sampling, elicitation에 의존하지 않는다 (OpenCode 미지원).
- UI는 M7 전까지 착수하지 않는다.
- 테스트가 무한 대기하면 자식 프로세스·연결 정리 누락부터 의심한다. 항목 단위로 커밋·푸시해서 중간에 멈춰도 진행분이 남게 한다.

---

## 1. 아키텍처 원칙

```
[어댑터]   server.ts(MCP) · cli.ts · ui/(M7)
              │  App 메서드만 호출
[App]      packages/local/src/app/      ← 유스케이스 조립 (사용자 행동 1개 = 메서드 1개)
         ┌────┴──────────────┐
[CoreClient]            [LocalServices]
상태 변경·판단           파일 I/O (sandbox, 스냅샷, fixture,
(M6에 원격 서버)         cassette, runner, 절차서 쓰기)
```

- **R1. 세션·노드 상태 변경은 CoreClient 메서드로만 한다.** `FileStore` 쓰기 메서드는 core in-process 구현만 호출할 수 있다.
- **R2. 파일 작업은 LocalServices가 맡는다.** LocalServices는 세션 상태를 직접 바꾸지 않고 결과 데이터를 App에 돌려준다.
- **R3. 어댑터는 얇게 둔다.** 입력 스키마 검증, App 호출, 응답 포맷, 에러 변환, 응답 크기 자르기만 한다. 상태·정책 판단 if문, 파일 접근, store 접근 금지.
- **R4. MCP 도구와 App 메서드는 1:1.** 나중에 UI 버튼도 같은 App 메서드를 호출한다. 새 기능은 CoreClient → App → 어댑터 순서로 만든다.
- **R5. CoreClient는 원격 가능해야 한다.** 모든 메서드 async, 입출력 JSON 직렬화 가능(Date, Map, Buffer, 함수 금지). DTO는 `shared/dto.ts` zod 스키마로 정의하고 MCP outputSchema와 UI API가 공유한다.
- **R6. 동시 수정 방지.** 세션에 `revision`(정수). 변경 메서드는 `expectedRevision?`을 받고 불일치 시 `conflict`. MCP 호스트는 생략 가능, UI는 항상 보낸다.
- **R7. 모든 변경은 이벤트로 남긴다.** `sessions/<sid>/events.jsonl`에 `{seq, at, actor: "host"|"human"|"runner", method, nodeIds, beforeHash, afterHash, summary}`. 히스토리, trace, UI 갱신의 단일 원천.
- **R8. core는 파일을 모른다.** 경로는 프로젝트 기준 상대 문자열과 `{sha256, size, mime}`으로만 주고받는다. 텍스트 미리보기만 4KB 이하 허용.

---

## 2. CoreClient 계약 (목표 형태)

공통 입력 `{ sessionId, expectedRevision?, actor }`, 변경 메서드 공통 출력 `{ revision, changedNodeIds, events, instruction? }`.

| 구분 | 메서드 | 비고 |
|---|---|---|
| 조회 | `getSession`, `getTree(page)`, `getNode`, `listAttempts`, `getEvents(sinceSeq)` | 상태 변경 없음 |
| 분해 루프 | `pfStart`, `pfNext`, `pfReport`, `pfSplit`, `pfConfirmLeaf`, `pfRetry`, `pfAskHuman`, `pfApprove` | `pfNext`는 open→probing 변경이므로 변경 메서드 |
| 사람 개입 | `pfAdvise`, `pfLock`, `pfReopen` | |
| 신규 | `pfEditArgs(nodeId, patch)` | fixed 값 수정, fixed↔var 전환 (중간 논리 수정) |
| 신규 | `pfEditNode(nodeId, {goal?, addConstraints?, removeConstraintIds?})` | 목표·검사 조건 직접 수정 |
| 신규 | `amendAttemptArtifacts(nodeId, attemptId, refs)` | server.ts의 `store.saveNode` 직접 호출 대체 |
| 신규 | `pfUpdateCatalog(entries)` | 툴 목록 수집은 local, core는 저장만 |
| 신규 | `pfBuildProcedure(name)` | 검증·params 경고·golden 선택 → `ProcedureDoc` DTO + warnings 반환. 파일 쓰기는 local |

`pfEditArgs` 동작:
- locked 노드는 `conflict`로 거부.
- 수정 인자를 inputSchema로 검증(shared `args-schema`), 해시 재계산.
- leaf는 open으로 되돌리고 `suggestedArgs`에 수정 인자 저장. 이전 golden은 참고용으로 보존.
- 다음 `pfNext` instruction: "사람이 인자를 수정함. 이 인자로 실행 후 pf_report".
- 하류 노드에 `propagateStale` 적용.

`validator.ts`는 순수 함수이므로 `shared`로 옮겨 core와 local이 공유한다.

---

## 3. LocalServices (`packages/local/src/services/`)

| 모듈 | 책임 |
|---|---|
| `workspace` | sandbox 생성, seed 복사, `assertSafePath`, 프로젝트 경계 |
| `snapshot` | 사전 스냅샷 기록·비교, inout 원본 보존 |
| `artifacts` | 결과물 ingest, 5MB 상한, 바이너리는 메타만, manifest |
| `catalog` | `opencode.json` 기반 MCP 툴 수집, schemaHash |
| `runner` | record / replay / passthrough / live |
| `procedureWriter` | `ProcedureDoc` 파일 기록, 원자 교체, `.opencode/command/<name>.md` |
| `trace` | 로그, export zip |

---

## 4. App 층 (`packages/local/src/app/`)

```ts
export class ProcForgeApp {
  constructor(private core: CoreClient, private svc: LocalServices) {}

  async report(i: ReportInput) {
    const io = this.svc.snapshot.classify(i.sessionId, i.nodeId);           // out / in / inout
    const refs = await this.svc.artifacts.ingest(i.sessionId, i.nodeId, io); // 메타·해시만
    return this.core.pfReport({ ...i, artifacts: refs, io: io.roles });
  }

  async finalize(i: FinalizeInput) {
    const { doc, warnings } = await this.core.pfBuildProcedure(i);
    const files = this.svc.procedureWriter.write(doc, { force: i.force });
    return { ...files, warnings };
  }
}
```

server.ts 핸들러는 이 형태여야 한다:

```ts
server.registerTool("pf_report", spec, async (a) => {
  try { return ok(await app.report(a)); } catch (e) { return errResult(e); }
});
```

---

## 5. 강제 장치 (CI)

1. **check-deps 확장.** 어댑터(`server.ts`, `cli.ts`, `ui/**`)가 import할 수 있는 것은 `app/`, `shared`의 schema·dto·errors, `logger`, MCP SDK, zod뿐. `filestore`, `services/**`, `runner/**`, `node:fs` import 시 실패.
2. **grep 검사.** 어댑터에 `saveNode|writeFileSync|readFileSync|existsSync|mkdirSync` 있으면 실패. `FileStore` save 계열은 core in-process 구현 파일에서만 허용.
3. **1:1 매핑 테스트.** `TOOL_NAMES` 전 항목이 `APP_METHODS` 매핑을 가져야 한다.
4. **Loopback client.** `createLoopbackClient(inner)`가 모든 입출력을 `JSON.parse(JSON.stringify())` 후 DTO zod로 검증. 전체 테스트를 `PROCFORGE_CLIENT=inprocess`와 `loopback`으로 돌리고 CI 매트릭스에 추가.
5. **Parity 테스트.** 같은 시나리오를 App 직접 호출과 MCP InMemoryTransport로 실행. uuid·시각 정규화 후 최종 session·nodes 동일.
6. **인자-스키마 정적 테스트.** 도구 설명·핸들러에서 쓰는 인자가 inputSchema에 있는지 검사.

---

## 6. 마일스톤

### M4.2 계층 정리 + M4.1.1 보정 (다음 작업)

**0단계: 공용 기반**
- `shared/errors.ts`(ProcForgeError, 코드 목록), `shared/dto.ts` 신설, `validator`를 shared로 이동.
- 세션에 `revision` 추가, `events.jsonl` 도입. 기존 세션은 로드 시 revision 0으로 마이그레이션.

**1단계: server.ts 로직 이전** (도구 하나당 커밋 하나)

| 현재 위치 | 옮길 곳 |
|---|---|
| `pf_start`의 sandbox 설정 | `workspace` |
| `pf_next`의 스냅샷 기록 | `snapshot` |
| `pf_report`의 capture / diff / ingest | `App.report` |
| `pf_confirm_leaf`의 `store.saveNode` | `core.amendAttemptArtifacts` |
| `pf_advise`의 fixture 읽기 | `artifacts` (바이너리는 메타만) |
| finalize·test 조립, junit 쓰기 | App + `procedureWriter` / `runner` |

**2단계: 신규 CoreClient 메서드**
- 2절 표의 `pfEditArgs`, `pfEditNode`, `amendAttemptArtifacts`, `pfUpdateCatalog`, `pfBuildProcedure`, `getEvents`.
- MCP 도구 `pf_edit_args`, `pf_edit_node` 추가.

**3단계: M4.1.1 버그 수정**
1. 스냅샷 대비 바뀐 파일은 `inout`으로 분류. 원본은 seed → 앞 노드 캡처 기록 → pf_next 시점 사본(5MB 이하, `nodes/<id>/pre/`) 순서로 찾아 fixture 저장. 못 찾으면 confirm 시 bad_request. 테스트: 기존 pptx 수정 노드가 확정 후 replay 통과.
2. `junitPath`는 `assertSafePath`로 프로젝트 안만 허용. 생략 시 `runs/<runId>/junit.xml`.
3. `pf_test.procedure`에 `PROCEDURE_NAME_RE` zod 적용. `../` 거부 테스트.
4. `pf_test` inputSchema에 `nodeId` 추가. 서브트리만 실행되는지 계약 테스트.
5. golden params 경고는 자리표시자 복원 전 원문 기준. 자리표시자 있으면 경고 없음, 실제 값이 박혀 있으면 경고.
6. 스냅샷은 처음 probing될 때와 `pf_retry` 때만. `pf_next` annotation은 쓰기로 변경.
7. `pf_advise` 응답 summary는 `constraintSummary` 사용.

**4단계:** 5절 강제 장치 1~6 적용.

**완료 기준**
- server.ts에 `node:fs` import와 store 접근 0건.
- in-process / loopback 양쪽 전체 테스트 통과, parity 테스트 통과.
- 테스트 수 감소 없음.
- tools/list 스냅샷 변경은 의도분(`pf_edit_*`, `pf_next` annotation, `pf_test.nodeId`)만, 사유는 DECISIONS.md에.

### M3.5 PPT 실사용 테스트 (사람 진행)
- `docs/M3.5-dogfood.md`대로 Windows PC에서 실제 `a.pptx`로 진행, export zip·trace 회수.
- 에이전트는 여기서 나온 문제만 `M3.5.x`로 수정. 새 기능 금지.
- `pf_edit_args`로 중간 인자 수정 → 해당 노드만 재실행되는 흐름도 확인.

### M5 검증과 실행 분리
- `procforge test <proc>`: replay 전용, drift 검출만.
- `procforge run <proc> --param k=v [--from 2.1]`: OpenCode 없이 단독 live 실행. constraints로만 판정, golden 비교는 경고.
- generated 인자 노드만 `opencode run`으로 인자 생성, 절차서에 "LLM 필요 지점"으로 표시. generated 없는 절차서는 완전 결정적.
- App에 `runProcedure`, `testProcedure`. 실행 기록은 `runs/`와 이벤트에.
- SKILL.md, command.md 문구를 실제 동작에 맞게 갱신.
- 완료 기준: fake MCP E2E에서 9월 절차서를 `--param month=2026-10`으로 실행해 10월 산출물 생성 + constraints 통과.

### M5.5 반복 노드
- `kind: "map"`, `over: "$1.2.output.items"`, 본문 서브트리 템플릿, `maxItems`, 기본 동시 실행 1.
- 집계 검사 `count_min`, `pass_ratio`.
- 페이지네이션용 `loop`: `until` 조건, `maxIter`.
- validator, runner, core 상태, hash, stale을 반복 노드에 맞게 확장.

### M5.6 실행 간 상태와 sideEffect
- 절차서별 `state/` 폴더, `${state.lastRun}`, `${state.seen}` 참조. 전체 성공 시에만 원자 기록.
- external 노드는 run 모드에서 `--allow-external` 없으면 dry-run. 멱등성 키.

### 크롤링 테스트 (사람 진행)
- "웹사이트 일일 크롤링" 요청으로 절차서 생성 → Windows 작업 스케줄러에 `procforge run` 등록.
- 선택자 변경 시 실패 감지 → `pf_edit_args` 수정 → 해당 노드만 재실행 확인.

### M6 core 분리
- 원격 CoreClient(HTTPS JSON-RPC, 토큰 인증, 테넌트 검사). loopback 테스트 통과가 전제.
- 저장소를 비공개 core / 공개 local로 분리.
- 서버 전송 데이터에 redaction 적용.

### M7 UI
- `procforge ui`: 127.0.0.1 + 무작위 토큰만 허용, CDN 없이 오프라인 동작.
- 화면 기능은 전부 기존 App 메서드 사용: 트리=`getTree`, 상세=`getNode`/`listAttempts`, 조언=`advise`, 인자 수정=`editArgs`, 잠금·재open, 서브트리 test, 히스토리=`getEvents`.
- UI 서버 API에서 새 로직 금지. 필요하면 CoreClient → App 순서로 먼저 추가.

---

## 7. 마일스톤 종료 자가 점검 (`docs/REVIEW-<M>.md`)

- [ ] 어댑터에 판단 로직 없음 (5절 grep 결과 첨부)
- [ ] 새 상태 변경 기능이 모두 CoreClient에 있고 loopback 테스트 통과
- [ ] 새 경로·ID 입력에 `assertSafePath`와 ID 검증 적용
- [ ] Windows 경로(공백, 한글, 드라이브 문자) 테스트 존재
- [ ] tools/list 스냅샷 변경 사유 기록
- [ ] SKILL.md, command.md, README가 실제 구현과 일치
- [ ] 이 문서 8절 진행 현황 갱신 완료
- [ ] 남은 위험, 다음 마일스톤으로 넘기는 항목 기록

---

## 8. 진행 현황

표기: `[ ]` 미착수 · `[~]` 진행 중 · `[x]` 완료(CI green) · `[!]` 막힘

| 마일스톤 | 항목 | 상태 | 커밋 | CI run | 비고 |
|---|---|---|---|---|---|
| M0~M4.1 | 기존 작업 | [x] | `ac97ac6` | run 20 | |
| M4.2 | 0단계 공용 기반 | [~] | | | errors/dto/validator/revision/events 진행 중 |
| M4.2 | 1단계 server.ts 로직 이전 | [ ] | | | |
| M4.2 | 2단계 신규 CoreClient 메서드 | [ ] | | | |
| M4.2 | 3단계 M4.1.1 버그 1~7 | [ ] | | | |
| M4.2 | 4단계 강제 장치 1~6 | [ ] | | | |
| M3.5 | PPT 실사용 테스트 | [ ] | | | 사람 진행 |
| M5 | 검증/실행 분리 | [ ] | | | |
| M5.5 | 반복 노드 | [ ] | | | |
| M5.6 | 상태 / sideEffect | [ ] | | | |
| - | 크롤링 테스트 | [ ] | | | 사람 진행 |
| M6 | core 분리 | [ ] | | | |
| M7 | UI | [ ] | | | |

---

## 9. 변경 이력

| 날짜 | 절 | 변경 내용 | 사유 |
|---|---|---|---|
| 2026-10-09 | 전체 | v2 작성 (CoreClient / App / LocalServices 계층, M4.2~M7 로드맵) | 상태 변경 경로 단일화, UI·원격 core 대비 |
