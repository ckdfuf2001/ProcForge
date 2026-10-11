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
[
  {
    "node": { "id": "1.1", "hash": "a3f9…" },
    "tool": { "server": "web", "name": "fetch" },
    "args": { "url": "https://example.com/list", "mode": "*" }
  }
]
```

- `node.id` + `node.hash` 필수. 절차서를 수정하면 해시가 바뀌어 기존 승인은
  거부된다 (`approval: 승인 갱신 필요`). 항목 생성은 CLI로 한다
  (MCP 도구 추가 없음):
  `procforge approve procedures/<name> --node <id>`
  (같은 노드 항목이 있으면 갱신).
- `args` 생략 = 해당 tool 전체 승인.
- `args`가 있으면 실제 호출 인자의 키 집합과 정확히 일치해야 한다
  (추가 키가 하나라도 있으면 거부).
- 패턴 값 `"*"` = 임의 값 허용 (하나의 키에 대해).
- 생성된 패턴은 fixed 값 그대로, var/generated는 `"*"`다.
  path 인자는 실행 시 절대경로로 바뀌므로 `"*"`로 직접 고쳐 써라.
- 매칭 기준은 해석된(resolved) 실제 호출 인자다.
- map/until external 노드는 부모 노드 id+hash로 승인한다 (항목별 해시는 불안정).

## Windows 작업 스케줄러 예시

```powershell
$action = New-ScheduledTaskAction -Execute "procforge" `
  -Argument "run procedures/daily-crawl --unattended --out out" `
  -WorkingDirectory "D:\work\site"
$trigger = New-ScheduledTaskTrigger -Daily -At "06:00"
Register-ScheduledTask -TaskName "procforge-daily" -Action $action -Trigger $trigger
```

실패 알림은 스케줄러의 종료 코드로 판단한다 (0이 아니면 실패, 3이면 승인 필요).

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
