# 스케줄 실행 (M5.5-4)

스케줄러는 내장하지 않는다. OS 스케줄러에서 `procforge run --unattended`를 호출하라.

## 종료 코드

| 코드 | 의미 | 예 |
| --- | --- | --- |
| 0 | 성공 (fail=0, suspended=0) | 정상 완료 |
| 1 | 검사 실패·중단 (fail>0 또는 suspended>0) | constraint 실패, 생성값·승인 대기 |
| 2 | 입력 오류 (`bad_request`·`bad_args`·`not_found`·`session_not_found`) | bad `--param`, procedure 없음, approvals.json 형식 오류 |
| 3 | 승인 필요 | 무인 실행 중 미승인 external (failedConstraints `approval`) |

## approvals.json

`procedures/<name>/approvals.json`. 무인 실행에서 external 노드는
일치하는 항목이 있을 때만 실행된다. 파일이 없으면 빈 목록(= 전부 거부).

```json
[
  { "tool": { "server": "web", "name": "fetch" }, "args": { "url": "https://example.com/list", "mode": "*" } }
]
```

- `args` 생략 = 해당 tool 전체 승인.
- `args`가 있으면 실제 호출 인자의 키 집합과 정확히 일치해야 한다
  (추가 키가 하나라도 있으면 거부).
- 패턴 값 `"*"` = 임의 값 허용 (하나의 키에 대해).
- 매칭 기준은 해석된(resolved) 실제 호출 인자다.

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

- `--unattended`에서도 `generated` 인자는 suspended로 멈춘다
  (runner가 값을 만들지 않음). 스케줄 실행 절차서는 generated 없이 설계하라.
- 실패한 run은 `state.json`을 갱신하지 않는다. 다음 스케줄 실행이 같은 지점부터
  다시 시도한다.
- 산출물 복사는 `--out` 지정 시에만, 기존 파일은 `--force` 없으면 거부된다.
