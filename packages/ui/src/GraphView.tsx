import { useMemo } from "react";
import { stratify, tree as d3tree, type HierarchyPointNode } from "d3-hierarchy";
import type { NodeRow } from "./api.js";

// M10-3-ui: 노드 그래프 (A안 d3-hierarchy + SVG 직접 렌더, ISC).
// 기존 테이블 뷰는 그대로 둔다. 카드에는 id·goal 1줄·why 1줄을 항상 둔다.
// 상태 색: open=회색, probing=파랑, needs_human=노랑(확인 대기), leaf=초록,
// fail=빨강, needs_reverify=주황, stale(부모 변경)=보라 테두리.

const CARD_W = 190;
const CARD_H = 64;
const GAP_X = 60;
const GAP_Y = 18;

type Datum = {
  id: string;
  goal: string;
  why: string | null;
  status: string;
  stale: boolean;
};

function short(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function parentIdOf(id: string): string | null {
  const i = id.lastIndexOf(".");
  return i < 0 ? null : id.slice(0, i);
}

export function GraphView({
  nodes,
  onPick,
}: {
  nodes: NodeRow[];
  onPick: (nodeId: string) => void;
}) {
  const layout = useMemo(() => {
    if (nodes.length === 0) return null;
    const ids = new Set(nodes.map((n) => n.id));
    const data: Datum[] = nodes
      .filter((n) => {
        // 부모 없는 고아(상위 잘림)는 트리에서 뺀다 — 테이블에 그대로 있다.
        const p = parentIdOf(n.id);
        return p === null || ids.has(p);
      })
      .map((n) => ({
        id: n.id,
        goal: n.goal,
        why: n.why,
        status: n.status,
        stale: n.staleSince !== undefined,
      }));
    if (data.length === 0) return null;
    let root;
    try {
      root = stratify<Datum>()
        .id((d) => d.id)
        .parentId((d) => parentIdOf(d.id))(data);
    } catch {
      return null;
    }
    const t = d3tree<Datum>().nodeSize([CARD_H + GAP_Y, CARD_W + GAP_X]);
    const laid: HierarchyPointNode<Datum> = t(root);
    let minX = Infinity;
    let maxX = -Infinity;
    let maxY = 0;
    laid.each((d) => {
      if (d.x < minX) minX = d.x;
      if (d.x > maxX) maxX = d.x;
      if (d.y > maxY) maxY = d.y;
    });
    return { laid, minX, maxX, maxY };
  }, [nodes]);

  if (!layout) return <p className="muted">그래프에 올릴 노드가 없습니다.</p>;
  const { laid, minX, maxX, maxY } = layout;
  const pad = 12;
  const height = maxX - minX + CARD_H + pad * 2;
  const width = maxY + CARD_W + pad * 2;
  const ox = pad - minX;
  const oy = pad;

  const links: { key: string; d: string }[] = [];
  laid.each((d) => {
    const p = d.parent;
    if (!p) return;
    const x1 = p.y + CARD_W;
    const y1 = p.x + CARD_H / 2;
    const sx = x1;
    const sy = y1;
    const tx = d.y;
    const ty = d.x + CARD_H / 2;
    const mx = (sx + tx) / 2;
    links.push({
      key: `${p.data.id}->${d.data.id}`,
      d: `M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`,
    });
  });

  return (
    <div className="graph-view">
      <svg
        className="graph-svg"
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="노드 그래프"
      >
        <g transform={`translate(${ox},${oy})`}>
          {links.map((l) => (
            <path key={l.key} className="glink" d={l.d} />
          ))}
          {laid
            .descendants()
            .map((d) => {
              const datum = d.data;
              const cls = `gnode gnode-st-${datum.status}${datum.stale ? " gnode-st-stale" : ""}`;
              const x = d.y;
              const y = d.x - CARD_H / 2;
              return (
                <g
                  key={datum.id}
                  className={cls}
                  transform={`translate(${x},${y})`}
                  onClick={() => onPick(datum.id)}
                >
                  <title>{`${datum.id} · ${datum.status}`}</title>
                  <rect width={CARD_W} height={CARD_H} rx={8} />
                  <text className="gnode-id" x={8} y={18}>
                    {datum.id}
                  </text>
                  <text className="gnode-line" x={8} y={36}>
                    {short(datum.goal || "(목표 없음)", 24)}
                  </text>
                  <text className="gnode-line" x={8} y={52}>
                    {short(datum.why ?? "(why 없음)", 24)}
                  </text>
                </g>
              );
            })}
        </g>
      </svg>
    </div>
  );
}
