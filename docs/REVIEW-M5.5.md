# 자체 리뷰 — M5.5 반복·상태 + 무인 실행 (4.1·4.2 보강 포함)

날짜: 2026-10-11. 대상: M5.5-0 ~ M5.5-6, M5.5-4.1 (0~6), M5.5-4.2 (1~6).

## 범위
- 반복: map (`packages/local/test/m55-map.test.ts`), until (`m55-until.test.ts`).
- 상태: `state.json` + `${state.k}` + `stateWrites` (`m55-state.test.ts`).
- 무인 실행: `--unattended` + `approvals.json` + exit 표 (`m55-unattended.test.ts`,
  `src/app/run-exit.ts`, `docs/scheduling.md`).
- 보강: exit 확장·args 정확일치·nodeHash+approve CLI·generated 거부·run 잠금·
  Windows 예시 (4.1), 논리경로 매칭·wildcard 명시·해시 재계산·경로 정규화·
  잠금 finally·NODE_ENV 경고 (4.2).
- 실증: dogfood daily-crawl (`m55-dogfood.test.ts`).

## 확인 항목
- [x] map/until: 템플릿 인라인·자식 금지, `$self`·`${item}`·policy·failedItems
  - until carry 회귀 (M5.5-3 selfCarry 누락 → `9e1d0b3` 수정, `m55-until`이 포착).
- [x] state: 성공 종료 시에만 원자 저장, 실패·중단 불변. 첫 실행 부재 시
  `stateDefaults` 또는 `bad_request`.
- [x] 승인 매칭: node pin(id+hash) + tool + args 키집합 정확일치.
  매칭 기준은 논리 경로 (rewritePaths 전). `approve` 생성 → 무수정 run → exit 0
  (`m55-pathsave` 수락 테스트).
- [x] 해시: 런타임 hash는 procedure.json 내용에서 재계산
  (`computeNodeHash(goal·args·constraints·dependsOn [])`, 세션 파일 일치 확인).
  1글자 수정 → stale → `fail ["approval"]` + "승인 갱신 필요" (exit 3).
  - 한계: dependsOn은 항상 []이므로 순서 변경은 해시 무영향.
    map/until 템플릿 변경도 현 공식 미반영 (args 패턴으로만 통제).
- [x] wildcard: var/generated는 `--allow-wildcard` 명시 시에만 `*` 생성,
  미지정 시 `bad_request` + 키 목록. 패턴 값 접두 와일드카드만 (`끝 *`,
  정규식 없음). 다른 호스트 URL → exit 3.
- [x] exit: 0 성공 / 1 실패·중단 / 2 입력 오류
  (`bad_request`·`bad_args`·`not_found`·`session_not_found`) /
  3 승인 필요 / 4 겹친 실행. `scheduling.md` 표·`run-exit.ts`·테스트 일치 고정.
- [x] 잠금: `procedures/<name>/.run.lock` (세션 lockfile 기제 재사용,
  staleMs 60s 문서 일치). 겹치면 `conflict` → exit 4.
  절차서 잠금 실패 시 세션 잠금 해제 (finally, 테스트).
  하트비트 20s가 세션+절차서 잠금 모두 갱신 (가짜 타이머 테스트).
- [x] generated: `--unattended`에서 미공급 generated 노드가 있으면 실행 전
  `bad_request` (exit 2). 대화형은 기존 suspended 유지.
- [x] 경로: approve 판별 전 `\` → `/` 정규화 (win32 테스트).
  스케줄러 예시는 `cmd.exe /c` + 절대경로 + "로그온 여부와 관계없이 실행".
- [x] instruction: pf_start·pf_next 분해 안내에
  "항목 반복은 map, 페이지는 until, 지난 실행 기억은 state" 추가.
  계약 테스트 (`instruction-host.test.ts`, 언급 도구 등록 확인 + 문구 고정) 유지.
- [x] 환경: `check:env`가 `NODE_ENV=production` 경고
  (devDependencies 스킵 → tsc/vitest 없음, 클린 클론 검증 실패 사례).

## 교훈 (M5.5-3 CI failure)
- `612030a`는 CI failure (`run 38126010591`) 상태에서 완료 처리됨.
  원인은 로컬 신규 파일만 실행하고 CI 미확인. CI는 전체 스위트이므로
  파일 수 검사가 아니라 head_sha 일치 run의 success 확인이 강제 장치
  (DECISIONS M5.5-4.1-0). 이후 항목부터 API 확인 후 완료 선언.
- 중간 커밋에는 run이 생기지 않음 (푸시 head만 실행).

## 남는 것
- 실제 웹 크롤링 도구 연동은 범위 밖 (fake board/detail/dogfood로 대체).
- 스케줄러 내장 없음 (`docs/scheduling.md` 예시만).
