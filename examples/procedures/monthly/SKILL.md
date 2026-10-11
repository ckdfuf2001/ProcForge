---
name: monthly
description: ProcForge 확정 절차 (2단계). 검증(replay) + 새 데이터 실행(run) 가능.
---

# monthly

이 skill은 확정된 절차를 검증(replay)하거나 새 데이터로 실행(run)한다. 탐색 금지.
입력 파일 경로·표지 문구처럼 기간이 들어간 값은 var로 분류한다.
예: "sales-${params.month}.xlsx", "월간보고서 ${params.month} (최종)".
앞 노드 출력과 같은 값은 fixed로 박지 말고 ref로 받아온다. 예: "$1.1.rows".
스크립트 leaf는 OS 수준 sandbox가 아니다. 자식 환경은 화이트리스트만,
run fs 밖 쓰기는 실행 전후 스냅샷으로 감지해 실패 처리한다.
파라미터: `month`

검증: `procforge test procedures/monthly --param k=v ...`
실행: `procforge run procedures/monthly --param k=v ... [--out dir]`
상세 단계는 PROCEDURE.md 참조. 실패 시 단계 번호와 constraint를 보고하라.
