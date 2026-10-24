import { useEffect, useState } from "react";
import { api, type NodeDetail, type NodeEvent } from "./api.js";
import { EditPanel } from "./EditPanel.js";

// M7-ui3: 노드 상세 패널. 판단 if문 금지 — 표시 매핑만.

/** argSpec kind 표시 (fixed/var/generated/script) */
const ARG_KIND: Record<string, string> = {
  fixed: "고정",
  var: "변수",
  generated: "생성",
  script: "스크립트",
};

export function NodeDetailPanel({
  sessionId,
  nodeId,
  revision,
}: {
  sessionId: string;
  nodeId: string;
  revision: number;
}) {
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [events, setEvents] = useState<NodeEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await api.nodeDetail(sessionId, nodeId);
        setDetail(r.detail);
        setEvents(r.events);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [sessionId, nodeId, revision]);

  if (error) return <p role="alert">오류: {error}</p>;
  if (!detail) return <p>상세 불러오는 중…</p>;

  return (
    <section className="node-detail">
      <div className="detail-heading">
        {/* M8-ui3: 접근 가능한 이름에 상태를 함께 넣는다 (E2E·스크린리더가 "1.1 · leaf" 로 읽는다) */}
        <h3 aria-label={`${detail.nodeId} · ${detail.status}`}>{detail.nodeId}</h3>
        <span className={`status status-${detail.status}`}>{detail.status}</span>
      </div>
      <p>목표: {detail.goal}</p>
      <p>
        도구:{" "}
        {detail.tool ? `${detail.tool.server}/${detail.tool.name}` : "(없음)"}{" "}
        · hash: {detail.hash.slice(0, 12)} · 잠금: {String(detail.locked)} · 부작용:{" "}
        {detail.sideEffect}
        {detail.staleSince
          ? ` · stale rev${detail.staleSince.revision} (원인 ${detail.staleSince.causeNodeId})`
          : ""}
        {detail.reverifySince
          ? ` · 재검증 대기 rev${detail.reverifySince.revision} (원인 ${detail.reverifySince.cause})`
          : ""}
      </p>
      <h4>인자 (argSpecs)</h4>
      <ul>
        {Object.entries(detail.args).map(([k, v]) => {
          const spec = v as { kind?: string; value?: unknown; ref?: string; instruction?: string };
          return (
            <li key={k}>
              {k}: {ARG_KIND[String(spec.kind)] ?? String(spec.kind)} ·{" "}
              <code>{JSON.stringify(v)}</code>
            </li>
          );
        })}
      </ul>
      <h4>검사 조건</h4>
      <ul>
        {detail.constraints.map((c) => (
          <li key={c.id}>
            {c.id} · {c.source} · {c.kind}
            {detail.lastFailedConstraints.includes(c.id) ? " · 마지막 판정: 실패" : ""}
            {detail.lastVerdict === "pass" ? " · 마지막 판정: 통과" : ""}
          </li>
        ))}
      </ul>
      <h4>의견 이력</h4>
      <ul>
        {detail.advice.map((a, i) => (
          <li key={`${a.at}-${i}`}>
            {a.at}: {a.text}
          </li>
        ))}
      </ul>
      <h4>실행 이력</h4>
      <ol>
        {detail.attempts.map((a) => (
          <li key={a.id}>
            {a.at} · {a.tool.server}/{a.tool.name} · 판정:{" "}
            {a.verdict ?? "미정"} · 사유: {a.resultSummary}
            {a.rubricReasons &&
              Object.entries(a.rubricReasons).map(([k, v]) => (
                <span key={k}>
                  {" "}
                  ({k}: {v})
                </span>
              ))}
            {a.artifactPreviews.map((p, i) => (
              <div key={p.rel}>
                <span>
                  산출물 {p.rel} ({p.mime}, {p.size}B)
                </span>
                {p.text !== null ? (
                  <pre>{p.text}</pre>
                ) : (
                  <span> (이진 · 전문 내려받기 버튼)</span>
                )}
                <a href={api.artifactUrl(sessionId, detail.nodeId, a.id, i)}>
                  전문 내려받기
                </a>
              </div>
            ))}
          </li>
        ))}
      </ol>
      <h4>golden</h4>
      <pre>{detail.golden ? detail.golden.output : "(없음)"}</pre>
      <h4>이 노드 이력</h4>
      <ul>
        {events.map((e, i) => (
          <li key={`${e.revision}-${i}`}>
            rev{e.revision} · {e.actor} · {e.method} · {e.summary}
          </li>
        ))}
      </ul>
      <EditPanel
        sessionId={sessionId}
        nodeId={nodeId}
        revision={detail.revision}
      />
    </section>
  );
}