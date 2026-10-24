import { useEffect, useState } from "react";
import { api, ApiError, type DecompositionRound, type NodeDetail } from "./api.js";

// M8-ui3: 분해 사유·대안 패널 (오른쪽 칸).
// 표시만 한다 — 판단 if문 금지.
// 의견 등록 UI는 **따로 만들지 않는다**: 기존 노드 상세(EditPanel)의
// advise-and-signal 경로를 그대로 쓴다 (로직 재구현 금지).

/** M8-1-0: 라운드 이벤트 종류 라벨 (core가 준 kind만 옮긴다) */
const EVENT_KIND_LABEL: Record<string, string> = {
  advise: "의견",
  reverify: "재검증",
  report: "실행",
  confirm: "재확정",
  edit: "수정",
  other: "기타",
};

export function ReasonPanel({
  sessionId,
  round,
  onOpenNode,
}: {
  sessionId: string;
  /** 선택된 라운드 (null = 최신) */
  round: DecompositionRound | null;
  /** 노드 상세로 가는 동작 (중복 폼 없이 재사용하기 위함) */
  onOpenNode: (nodeId: string) => void;
}) {
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const target = round?.parentId ?? null;

  useEffect(() => {
    if (!target) {
      setDetail(null);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const r = await api.nodeDetail(sessionId, target);
        if (alive) setDetail(r.detail);
      } catch (e) {
        if (alive) setError(e instanceof ApiError ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [sessionId, target]);

  if (error) return <p role="alert">오류: {error}</p>;

  if (!round) {
    return (
      <section className="reason-panel">
        <h3>분해 사유</h3>
        <p className="muted">
          왼쪽에서 분해 라운드를 고르면 왜 그렇게 나눴는지, 버린 대안은 무엇인지
          여기에 나옵니다.
        </p>
      </section>
    );
  }

  return (
    <section className="reason-panel">
      <h3>분해 사유</h3>
      <dl className="reason-meta">
        <dt>revision</dt>
        <dd>{round.revision}</dd>
        <dt>깊이</dt>
        <dd>{round.depth}</dd>
        <dt>부모</dt>
        <dd>{round.parentId}</dd>
        <dt>자식</dt>
        <dd>{round.childIds.join(", ") || "-"}</dd>
        <dt>작성자</dt>
        <dd>{round.actor}</dd>
        <dt>시각</dt>
        <dd>{round.at}</dd>
      </dl>
      <h4>사유</h4>
      {round.reason ? (
        <p className="reason-text">{round.reason}</p>
      ) : (
        <p className="muted">
          (사유 기록 없음 — 이 세션은 사유 도입 이전에 만들어졌다)
        </p>
      )}
      <h4>버린 대안</h4>
      {round.alternatives.length > 0 ? (
        <ul className="reason-alternatives">
          {round.alternatives.map((a, i) => (
            <li key={`${i}-${a}`}>{a}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">(기록 없음)</p>
      )}
      {round.causeAdviseIds.length > 0 && (
        <>
          <h4>원인이 된 의견</h4>
          <ul className="reason-causes">
            {round.causeAdviseIds.map((id) => (
              <li key={id}>
                <code>{id}</code>
              </li>
            ))}
          </ul>
        </>
      )}
      {round.events && round.events.length > 0 && (
        <>
          <h4>라운드 이후 이벤트</h4>
          <ul className="reason-events">
            {round.events.map((ev) => (
              <li
                key={`${ev.revision}-${ev.method}-${ev.nodeIds.join(",")}`}
                className={`reason-event ev-${ev.kind}`}
              >
                <span className="reason-event-kind">
                  {EVENT_KIND_LABEL[ev.kind] ?? ev.kind}
                </span>
                <span className="reason-event-rev">rev{ev.revision}</span>
                <span className="reason-event-nodes">
                  {ev.nodeIds.join(", ")}
                </span>
                <span className="reason-event-summary">{ev.summary}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {round.parentEvents && round.parentEvents.length > 0 && (
        <>
          <h4>이 노드의 계기</h4>
          <ul className="reason-events">
            {round.parentEvents.map((ev) => (
              <li
                key={`p-${ev.revision}-${ev.method}-${ev.nodeIds.join(",")}`}
                className={`reason-event ev-${ev.kind}`}
              >
                <span className="reason-event-kind">
                  {EVENT_KIND_LABEL[ev.kind] ?? ev.kind}
                </span>
                <span className="reason-event-rev">rev{ev.revision}</span>
                <span className="reason-event-nodes">
                  {ev.nodeIds.join(", ")}
                </span>
                <span className="reason-event-summary">{ev.summary}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {detail && detail.advice.length > 0 && (
        <>
          <h4>부모 노드의 의견 이력</h4>
          <ul className="reason-advice-history">
            {detail.advice.map((a, i) => (
              <li key={`${a.at}-${i}`}>
                {a.at}: {a.text}
              </li>
            ))}
          </ul>
        </>
      )}
      {target && (
        <button type="button" onClick={() => onOpenNode(target)}>
          이 노드 상세에서 의견 남기기
        </button>
      )}
    </section>
  );
}
