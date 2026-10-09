# ProcForge DEV-GUIDE (에이전트 인계용)

> 이 문서를 받은 에이전트는 **이 문서 + `docs/DECISIONS.md`를 먼저 읽고, 사용자 지시의 다음 마일스톤(M4.2)부터 진행**한다.
> 작업 전제: Windows + WSL Ubuntu 사용 가능, Node 20+, pnpm 9.

## 1. 공통 규칙 (사용자 고정 지시 — 매 작업 준수)

- **항목별 커밋**: 사용자 지시의 번호 항목마다 커밋 1개. 커밋 메시지는 `M<마일스톤>-<번호> <요약>` 형식.
- **푸시 전**: `git status --porcelain` 비어 있음 + **클린 클론 검증** 통과.
  ```bash
  # WSL에서 (경로는 환경에 맞게):
  rm -rf ~/pfhead && mkdir -p ~/pfhead
  git archive HEAD | tar -x -C ~/pfhead && cd ~/pfhead
  pnpm install --frozen-lockfile && pnpm -r build
  pnpm -r run test -- --run --testTimeout=20000 --hookTimeout=20000
  ```
- **완료 기준**: GitHub Actions `build-test (ubuntu-latest + windows-latest)` success.
  여러 커밋을 한 번에 푸시하면 마지막 커밋만 CI를 타므로, **보고는 head 커밋의 run 결과 기준** + run URL 포함.
  head 일치 확인: run의 `head_sha`가 로컬 head와 같은지 대조한다.
  ```powershell
  (Invoke-WebRequest -Uri 'https://api.github.com/repos/ckdfuf2001/ProcForge/actions/runs?branch=master&per_page=1' -UseBasicParsing).Content | ConvertFrom-Json
  ```
- **보고**: `base..head` diff 기준, 항목별 결과 + 테스트 수 + run URL. 질문이 아닌 이상 보고만 한다.
- 가정·결정은 `docs/DECISIONS.md`에 `[M<번호>]` 형식으로 기록한다 (형식은 파일 상단 참조).

## 2. 저장소 지도

```
packages/shared/src/  schema.ts(스키마) core-client.ts(인터페이스) normalize.ts(비교·params 치환)
                      deps.ts(의존 펼침) ids.ts(정렬) args-schema.ts(검사 공용) store.ts(Store 포트)
packages/core/src/    service.ts(CoreService, Pf* 구현) — local이 직접 import 금지
packages/local/src/   server.ts(MCP 도구층) core-inprocess.ts(유일한 core 직접 import 허용 파일, M6 교체점)
                      artifacts.ts(fixtures ingest) capture.ts(자동 캡처+스냅샷) catalog.ts(버전 대응 카탈로그)
                      export.ts(자작 zip) trace.ts procedure.ts(finalize) validator.ts checker.ts
                      runner/{run,resolve,paths,recordings,connections,workdir,procedure-run}.ts
packages/local/test/ m3-runner.test.ts m36-capture.test.ts m41-snapshot.test.ts finalize.test.ts
                      m2-e2e.test.ts mcp-*.test.ts fixtures/fake-ppt-mcp/server.mjs
scripts/              check-deps.mjs m3-ci-replay.mjs dogfood-demo.mjs
docs/                 DECISIONS.md M2-manual.md PROCEDURE-FORMAT.md REVIEW-M4.md M3.5-dogfood.md
```

## 3. 의존·금지 규칙 (CI가 검사)

- `local → core` 소스 import 금지 (`scripts/check-deps.mjs`, 예외: `core-inprocess.ts` 1파일).
- `packages/local/src`에서 `console.log` 금지 (logger 사용, `cli.ts` 제외).
- `server.ts` description·prompt에 금지어 포함 금지:
  `부가세 llm_rubric numeric_match json_path_exists file_exists "auto constraint" 휴리스틱`.
- CI 전체 (`.github/workflows/ci.yml`): install → build → `pnpm -r run test -- ...` → check:deps → m3-ci-replay → grep 3종.
  로컬 테스트 명령은 **반드시 `pnpm -r run test --` 형태** (`pnpm -r test --`는 pnpm이 거부).

## 4. 핵심 설계 (상세는 DECISIONS)

- 세션 → 트리(leaf/split) → attempt(보고) → confirm_leaf 확정 → golden `{fixtures, output, attemptId, ignore}`.
- 실행 모드: record(호출+녹화) / replay(녹화만, golden 비교 없음) / passthrough(호출 + golden drift 비교).
- fixtures는 `sessions/<sid>/fixtures/` 자족, `fixtures-manifest.json`이 원본 상대경로 매핑. run fs는 golden fixtures만 전개.
- `golden.output`은 params 값 `${params.key}` 치환 저장, 비교 시 복원 (JSON 완전일치만, 부분치환 금지).
- 보고/확정 시 local이 in/inout/out 자동 ingest. 스냅샷(`pf_next`가 `nodes/<id>/pre-snapshot.json` 기록) 기준 생성·변경분은 out → 확정 시 golden에서 제외(증거 보존). 명시 `path`가 최우선. 스냅샷 없으면 폴백 + `pf_report warnings`.
- `file_exists`는 바이너리(확장자 기준) 존재+크기>0, sha256 비교 금지.
- export `--redact`는 기술자(`<원본>.redacted.json`)만, with-content는 원본+기술자 병행.
- 내장 툴 스키마는 `BUILTIN_BY_MAJOR` 표(major "1" 가정), 모르는 버전은 허용+경고. 세션에 `opencodeVersion` 기록.
- finalize: 이름 규칙 `^[a-z0-9][a-z0-9-]{0,63}$` → resolved 검사 → validateTree → `.tmp-<uuid>` 빌드 후 원자 교체 → 명령 파일 `<projectRoot>/.opencode/command/<name>.md` (force 없으면 거부).
- Attempt는 노드 hash에 포함되지 않으므로 보고 후 attempt 보정은 hash 무관.

## 5. 실전 교훈 (같은 실수 반복 금지)

- **edit 도구는 교체다**: oldString이 헤더 1줄이면 본문 첫 줄까지 먹지 않도록, 삽입은 "앵커+신규" 형태로. 편집 후 해당 영역을 반드시 다시 읽어라.
- **shared 수정 후 `pnpm -r build` 필수** (core/local은 shared의 `dist`를 참조 — 빌드 없이 테스트하면 `X is not a function`).
- CRLF 경고(`LF will be replaced by CRLF`)는 무시해도 된다.
- 테스트는 `-t "<이름>"`로 개별 실행 가능. MCP 스폰 테스트는 느리다(수십 초) — 멈춘 게 아니니 기다려라.
- 테스트 격리: tmp 디렉터리 + `HOME`/`USERPROFILE`을 빈 tmp로 덮는 패턴을 기존 테스트에서 그대로 따른다.
- **서버 경유 vs 직접**: 자동 캡처·스냅샷은 서버층(`server.ts`)에서만 동작. `client` 직접 호출 테스트에는 적용 안 됨.
- 이 환경에 `opencode` 바이너리 없음 → 버전 감지는 `"unknown"` (테스트는 주입식 `run` 파라미터 사용).
- `git push` DNS 스레드 오류(`getaddrinfo() thread failed`)는 일시적 — 수십 초 후 재시도.
- zip 자작 시 UTF-8 플래그(0x0800)는 비ASCII 이름에만 (탐색기가 플래그 있으면 해제 실패 — 해결됨, 회귀 테스트 있음).
- Windows `renameSync`는 덮어쓰기 불가 → `.old` 이동 후 교체·삭제 패턴 사용 (`swapDir`).
- 가짜 PPT 서버(`fake-ppt-mcp/server.mjs`) 수정 시 기존 응답 형태 유지 (키 없을 때 기존과 동일한 바이트).

## 6. 현재 상태 (2026-10-09)

- M0 ~ M4, M3.5 tooling, **M3.6**(1~7), **M4.1**(1~8) 완료. head `ac97ac6`.
- CI: https://github.com/ckdfuf2001/ProcForge/actions/runs/37887277145 (양 OS success).
- 로컬 전체: shared 10 + core 41 + local 124 통과.
- 다음: **M4.2** (사용자 지시 대기 — 지시 없이 추측 구현 금지).
