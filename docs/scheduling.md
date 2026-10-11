# 스케줄 실행 (M5.5-4)

스케줄러는 내장하지 않는다. OS 스케줄러에서 `procforge run --unattended`를 호출하라.

## 종료 코드

| 코드 | 의미 | 예 |
| --- | --- | --- |
| 0 | 성공 (fail=0, suspended=0) | 정상 완료 |
| 1 | 검사 실패·중단 (fail>0 또는 suspended>0) | constraint 실패, 생성값·승인 대기 |
| 2 | 입력 오류 (`bad_request`·`bad_args`·`not_found`·`session_not_found`) | bad `--param`, procedure 없음, approvals.json 형식 오류 |
| 3 | 승인 필요 | 무인 실행 중 미승인 external (failedConstraints `approval`) |
| 4 | 겹친 실행 (`conflict`) | 같은 절차서의 다른 run이 진행 중 (`procedures/<name>/.run.lock`) |

## approvals.json

`procedures/<name>/approvals.json`. 무인 실행에서 external 노드는
일치하는 항목이 있을 때만 실행된다. 파일이 없으면 빈 목록(= 전부 거부).

```json
{
  "version": 2,
  "entries": [
    {
      "node": { "id": "1.1", "hash": "a3f9…" },
      "tool": { "server": "web", "name": "fetch" },
      "args": { "url": { "$prefix": "https://example.com/" }, "mode": { "$any": true } }
    }
  ]
}
```

- 형식은 `{version: 2, entries}`. 옛 배열 형식(v1)은 로드 시 1회 변환된다
  (`"*"` → `$any`, 끝 `*` 문자열 → `$prefix`) 후 경고가 남는다.
  node pin 없는 v1은 재생성해야 한다 (`approve`로 다시 생성).
- `node.id` + `node.hash` 필수. `approve` 생성분에는 `approvalHash`도 들어간다
  (nodeHash + tool + sideEffect + map/until 전체 스펙 + script 파일 내용 +
  var 참조 상류 노드 재귀. 상류·템플릿·스크립트 변경도 stale). 절차서를 수정하면
  기존 승인은 거부된다 (`approval: 승인 갱신 필요`). 항목 생성은 CLI로 한다
  (MCP 도구 추가 없음):
  `procforge approve procedures/<name> --node <id> [--allow-wildcard <key> ...]`
  (같은 노드 항목이 있으면 갱신).
- `args` 생략 = 해당 tool 전체 승인 (노드 pin은 유지).
- `args`가 있으면 실제 호출 인자의 키 집합과 정확히 일치해야 한다
  (추가 키가 하나라도 있으면 거부).
- 패턴 값은 명시적이다. 문자열은 항상 정확 일치 (`"SELECT *"`는 `"SELECT x"`와
  불일치). 와일드카드는 `{"$any": true}`, 접두는 `{"$prefix": "..."}`만 쓴다.
- `$prefix`가 `scheme://`로 시작하면 URL 모드다 (아래 참조).
  `/`를 포함한 그 외 접두는 경로 모드다: posix 정규화 후 `".."`·절대경로를
  패턴·실제 모두 거부하고 세그먼트 접두로 비교한다. 끝 `/`는 하위만 일치
  (`"output/"`에 `"output"` 자체는 불일치). `/` 없는 접두는 문자열 접두 유지.
- `$prefix`가 `scheme://`로 시작하면 URL 모드다. 실제 값을 `new URL()`로
  정규화 (호스트 소문자·기본 포트·dot 세그먼트 해소) 후 origin 정확 일치 +
  path 세그먼트 접두로 비교한다. 패턴은 origin 뒤 `/`가 필수
  (`"https://a.com"`은 로드 시 `bad_request`). 패턴에 query/fragment가
  있으면 로드 시 `bad_request`, 실제 값에 username/password가 있으면 거부한다.
- 생성된 패턴은 fixed 값 그대로다. 단 fixed 값에 `${...}`가 있으면 리터럴
  앞부분으로 `$prefix`를 생성한다 (URL이면 URL 모드 규칙 적용, 리터럴이
  비어 있으면 `$any`). URL 리터럴이 origin 뒤 `/` 없으면 생성 거부.
  var/generated 키는 `--allow-wildcard <key>`로
  명시한 것만 `{"$any": true}`가 되고, 미지정 키가 있으면 `bad_request`(exit 2) +
  키 목록으로 거부된다 (암묵적 전체 허용 금지).
- 매칭 기준은 논리 경로다 (rewritePaths 전 해석 인자). path 인자는 고정
  상대경로 그대로 승인하면 실행 시 run fs 절대경로로 바뀌어도 일치한다.
- map/until external 노드는 부모 노드 id+hash로 승인한다 (항목별 해시는 불안정).

## Windows 작업 스케줄러 예시

스케줄러의 PATH를 믿지 마라. `cmd.exe /c`에 절대경로를 쓴다.

- 프로그램: `C:\Windows\System32\cmd.exe`
- 인수: `/c ""C:\Tools\nodejs\procforge.cmd" run procedures/daily-crawl --unattended --out out >> D:\logs\procforge.log 2>&1"`
- 시작 위치: `D:\work\site` (projectRoot. `--project-root`으로 대신 지정 가능)

`procforge.cmd`가 없으면 node 절대경로로 dist 직접 호출:

- 프로그램: `C:\Tools\nodejs\node.exe`
- 인수: `D:\tools\ProcForge\packages\local\dist\cli.js run procedures/daily-crawl --unattended --out out >> D:\logs\procforge.log 2>&1`

작업 설정에서 반드시 지정:

- 보안 옵션: "사용자 로그온 여부에 관계없이 실행" + "가장 높은 권한으로 실행"
  (로그 파일·산출물 쓰기 권한 필요).
- 조건: "컴퓨터의 전원이 켜져 있으면 시작" (필요 시).
- 실패 판단: "마지막 실행 결과"가 `0x0`이 아니면 실패.
  `0x1` 검사 실패·중단, `0x2` 입력 오류, `0x3` 승인 필요, `0x4` 겹친 실행.

PowerShell에서 등록할 때 예시:

```powershell
$action = New-ScheduledTaskAction -Execute "C:\Windows\System32\cmd.exe" `
  -Argument '/c ""C:\Tools\nodejs\procforge.cmd" run procedures/daily-crawl --unattended --out out >> D:\logs\procforge.log 2>&1"' `
  -WorkingDirectory "D:\work\site"
$trigger = New-ScheduledTaskTrigger -Daily -At "06:00"
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName "procforge-daily" -Action $action -Trigger $trigger -Principal $principal
```

실패 알림은 스케줄러의 종료 코드로 판단한다 (0이 아니면 실패, 3이면 승인 필요, 4면 겹침).

## cron 예시

```sh
0 6 * * * cd /srv/site && procforge run procedures/daily-crawl --unattended --out out >> /var/log/procforge.log 2>&1
```

## 주의

- `--unattended`에서는 `generated` 인자 노드가 하나라도 있으면 실행 전
  `bad_request`(exit 2)로 거부된다. 스케줄 실행 절차서는 generated 없이 설계하라.
- 실패한 run은 `state.json`을 갱신하지 않는다. 다음 스케줄 실행이 같은 지점부터
  다시 시도한다.
- 같은 절차서의 실행이 겹치면 `procedures/<name>/.run.lock`으로 두 번째가
  `conflict`(exit 4)로 거부된다. 앞선 실행이 비정상 종료된 지 60초가 지나면
  잠금을 회수하고 진행한다.
- 산출물 복사는 `--out` 지정 시에만, 기존 파일은 `--force` 없으면 거부된다.
