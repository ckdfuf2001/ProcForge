import { progressOf, type ProgressInput } from "./progress.js";

// M10-3-ui: 상단 진행률 바. core가 준 status 문자열만 쓴다.
// M7-5-3: 인라인 style 금지 (CSP) — 5% 단위 클래스로 폭을 둔다.

export function ProgressBar({ nodes }: { nodes: ProgressInput[] }) {
  const { done, total, percent } = progressOf(nodes);
  const step = Math.round(percent / 5) * 5;
  return (
    <div className="progress-wrap" role="status" aria-label={`진행률 ${done} / ${total} (${percent}%)`}>
      <div className="progress-track" aria-hidden="true">
        <div className={`progress-fill progress-fill-${step}`} />
      </div>
      <span className="progress-text">
        {done} / {total} ({percent}%)
      </span>
    </div>
  );
}
