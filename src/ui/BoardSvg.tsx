import { useCallback, useRef, useState } from "react";
import { SIZE, idx, isCorner, linkEnds, xy, type LinkId, type Player } from "../core/board";
import type { GameState } from "../core/game";
import { pointToStr } from "../core/notation";

export interface BoardSvgProps {
  state: GameState;
  /** この端末が操作できる色。null なら閲覧のみ */
  interactive: Player | "both" | null;
  onPlace: (x: number, y: number) => void;
  /** standard ルールで除去対象に選んだ自リンク */
  selectedLinks?: Set<LinkId>;
  onToggleLink?: (id: LinkId) => void;
  /** 180° 回転(黒番の人向け) */
  rotated?: boolean;
  /** 候補手のヒートマップ等(cell index → 0..1) */
  overlay?: Map<number, number>;
}

const CELL = 24; // 1 穴のピクセル幅(viewBox 単位)
const PAD = 22;
const W = SIZE * CELL + PAD * 2;

const COLORS = {
  board: "#d9c9a5",
  hole: "#8a7a5a",
  white: "#f4f1e8",
  whiteEdge: "#c9c2b0",
  black: "#1f1f1f",
  blackEdge: "#000",
  last: "#e0483e",
  selected: "#f5a623",
};

export function BoardSvg(props: BoardSvgProps) {
  const { state, interactive, onPlace, selectedLinks, onToggleLink, rotated, overlay } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, s: 1 }); // viewBox: origin & scale (1 = 全体)
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ startDist: number; startView: typeof view; moved: boolean; startCenter: { x: number; y: number } } | null>(null);

  const canAct = interactive !== null && !state.result && (interactive === "both" || interactive === state.toMove);

  const clampView = (v: { x: number; y: number; s: number }) => {
    const s = Math.min(1, Math.max(0.3, v.s));
    const size = W * s;
    return { s, x: Math.min(W - size, Math.max(0, v.x)), y: Math.min(W - size, Math.max(0, v.y)) };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    const c = pts.reduce((a, p) => ({ x: a.x + p.x / pts.length, y: a.y + p.y / pts.length }), { x: 0, y: 0 });
    const dist = pts.length >= 2 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 0;
    gesture.current = { startDist: dist, startView: view, moved: gesture.current?.moved ?? false, startCenter: c };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    const g = gesture.current;
    const rect = svgRef.current!.getBoundingClientRect();
    const pxToUnit = (W * view.s) / rect.width;
    const c = pts.reduce((a, p) => ({ x: a.x + p.x / pts.length, y: a.y + p.y / pts.length }), { x: 0, y: 0 });
    const dx = (c.x - g.startCenter.x) * pxToUnit, dy = (c.y - g.startCenter.y) * pxToUnit;
    if (Math.hypot(c.x - g.startCenter.x, c.y - g.startCenter.y) > 6) g.moved = true;
    if (pts.length >= 2) {
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const ratio = g.startDist > 0 ? g.startDist / dist : 1;
      const ns = g.startView.s * ratio;
      // ピンチ中心を固定
      const cx = g.startView.x + ((g.startCenter.x - rect.left) / rect.width) * W * g.startView.s;
      const cy = g.startView.y + ((g.startCenter.y - rect.top) / rect.height) * W * g.startView.s;
      const fx = (g.startCenter.x - rect.left) / rect.width, fy = (g.startCenter.y - rect.top) / rect.height;
      setView(clampView({ s: ns, x: cx - fx * W * ns - dx, y: cy - fy * W * ns - dy }));
      g.moved = true;
    } else if (g.moved) {
      setView(clampView({ s: g.startView.s, x: g.startView.x - dx, y: g.startView.y - dy }));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) {
      const moved = gesture.current?.moved;
      gesture.current = null;
      if (!moved) handleTap(e.clientX, e.clientY);
    } else {
      // 残った指で継続
      const pts = [...pointers.current.values()];
      const c = pts.reduce((a, p) => ({ x: a.x + p.x / pts.length, y: a.y + p.y / pts.length }), { x: 0, y: 0 });
      gesture.current = { startDist: 0, startView: view, moved: true, startCenter: c };
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width, fy = (e.clientY - rect.top) / rect.height;
    const ns = view.s * (e.deltaY > 0 ? 1.15 : 0.87);
    const cx = view.x + fx * W * view.s, cy = view.y + fy * W * view.s;
    setView(clampView({ s: ns, x: cx - fx * W * ns, y: cy - fy * W * ns }));
  };

  const handleTap = useCallback((clientX: number, clientY: number) => {
    const rect = svgRef.current!.getBoundingClientRect();
    let ux = view.x + ((clientX - rect.left) / rect.width) * W * view.s;
    let uy = view.y + ((clientY - rect.top) / rect.height) * W * view.s;
    if (rotated) { ux = W - ux; uy = W - uy; }
    // まずリンク(除去選択)の当たり判定
    if (onToggleLink && state.settings.rules === "standard" && canAct) {
      let best: { id: LinkId; d: number } | null = null;
      for (const [id, owner] of state.board.links) {
        if (owner !== state.toMove) continue;
        const [a, b] = linkEnds(id);
        const [ax, ay] = xy(a), [bx, by] = xy(b);
        const p1 = { x: PAD + ax * CELL + CELL / 2, y: PAD + ay * CELL + CELL / 2 };
        const p2 = { x: PAD + bx * CELL + CELL / 2, y: PAD + by * CELL + CELL / 2 };
        const d = distToSegment(ux, uy, p1.x, p1.y, p2.x, p2.y);
        if (d < CELL * 0.28 && (!best || d < best.d)) best = { id, d };
      }
      if (best) {
        // ペグの真上ならペグ優先
        const gx = Math.floor((ux - PAD) / CELL), gy = Math.floor((uy - PAD) / CELL);
        const nearPeg = state.board.cells[idx(gx, gy)] !== null &&
          Math.hypot(ux - (PAD + gx * CELL + CELL / 2), uy - (PAD + gy * CELL + CELL / 2)) < CELL * 0.35;
        if (!nearPeg) { onToggleLink(best.id); return; }
      }
    }
    const gx = Math.floor((ux - PAD) / CELL), gy = Math.floor((uy - PAD) / CELL);
    if (gx < 0 || gy < 0 || gx >= SIZE || gy >= SIZE) return;
    if (canAct) onPlace(gx, gy);
  }, [view, rotated, state, canAct, onPlace, onToggleLink]);

  const vb = `${view.x} ${view.y} ${W * view.s} ${W * view.s}`;
  const transform = rotated ? `rotate(180 ${W / 2} ${W / 2})` : undefined;
  const legal = (x: number, y: number) => canAct && state.board.cells[idx(x, y)] === null &&
    ((state.toMove === "white") ? x !== 0 && x !== SIZE - 1 : y !== 0 && y !== SIZE - 1) && !isCorner(x, y);

  const holes: React.ReactNode[] = [];
  for (let x = 0; x < SIZE; x++) {
    for (let y = 0; y < SIZE; y++) {
      if (isCorner(x, y)) continue;
      const cx = PAD + x * CELL + CELL / 2, cy = PAD + y * CELL + CELL / 2;
      const owner = state.board.cells[idx(x, y)];
      const ov = overlay?.get(idx(x, y));
      holes.push(
        <g key={`${x}-${y}`}>
          {ov !== undefined && ov > 0.02 && (
            <circle cx={cx} cy={cy} r={CELL * 0.45} fill="#3b82f6" opacity={Math.min(0.85, ov)} />
          )}
          {owner === null ? (
            <circle cx={cx} cy={cy} r={CELL * 0.14} fill={COLORS.hole} opacity={legal(x, y) ? 1 : 0.55} />
          ) : (
            <circle cx={cx} cy={cy} r={CELL * 0.36}
              fill={owner === "white" ? COLORS.white : COLORS.black}
              stroke={state.lastPeg === idx(x, y) ? COLORS.last : owner === "white" ? COLORS.whiteEdge : COLORS.blackEdge}
              strokeWidth={state.lastPeg === idx(x, y) ? 3 : 1.5} />
          )}
        </g>,
      );
    }
  }

  const links: React.ReactNode[] = [];
  for (const [id, owner] of state.board.links) {
    const [a, b] = linkEnds(id);
    const [ax, ay] = xy(a), [bx, by] = xy(b);
    const sel = selectedLinks?.has(id);
    links.push(
      <line key={id}
        x1={PAD + ax * CELL + CELL / 2} y1={PAD + ay * CELL + CELL / 2}
        x2={PAD + bx * CELL + CELL / 2} y2={PAD + by * CELL + CELL / 2}
        stroke={sel ? COLORS.selected : owner === "white" ? COLORS.white : COLORS.black}
        strokeWidth={sel ? 7 : 5} strokeLinecap="round" opacity={sel ? 0.9 : 1}
        strokeDasharray={sel ? "6 5" : undefined} />,
    );
  }

  // 座標ラベル
  const labels: React.ReactNode[] = [];
  for (let k = 0; k < SIZE; k++) {
    const p = PAD + k * CELL + CELL / 2;
    labels.push(<text key={`c${k}`} x={p} y={PAD - 8} fontSize={9} textAnchor="middle" fill="#5a4a2a" transform={rotated ? `rotate(180 ${p} ${PAD - 11})` : undefined}>{String.fromCharCode(65 + k)}</text>);
    labels.push(<text key={`r${k}`} x={PAD - 8} y={p + 3} fontSize={9} textAnchor="end" fill="#5a4a2a" transform={rotated ? `rotate(180 ${PAD - 11} ${p})` : undefined}>{k + 1}</text>);
  }

  const edge = PAD + CELL; // 辺行の内側境界
  return (
    <svg ref={svgRef} viewBox={vb} className="board"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp} onWheel={onWheel}
      style={{ touchAction: "none", userSelect: "none" }}>
      <rect x={0} y={0} width={W} height={W} fill={COLORS.board} rx={8} />
      <g transform={transform}>
        {/* 辺行の帯: 白は上下、黒は左右 */}
        <rect x={edge} y={PAD} width={W - 2 * edge} height={CELL} fill={COLORS.white} opacity={0.35} />
        <rect x={edge} y={W - PAD - CELL} width={W - 2 * edge} height={CELL} fill={COLORS.white} opacity={0.35} />
        <rect x={PAD} y={edge} width={CELL} height={W - 2 * edge} fill={COLORS.black} opacity={0.25} />
        <rect x={W - PAD - CELL} y={edge} width={CELL} height={W - 2 * edge} fill={COLORS.black} opacity={0.25} />
        {/* 境界線 */}
        <line x1={edge} y1={edge} x2={W - edge} y2={edge} stroke={COLORS.white} strokeWidth={1.5} />
        <line x1={edge} y1={W - edge} x2={W - edge} y2={W - edge} stroke={COLORS.white} strokeWidth={1.5} />
        <line x1={edge} y1={edge} x2={edge} y2={W - edge} stroke={COLORS.black} strokeWidth={1.5} />
        <line x1={W - edge} y1={edge} x2={W - edge} y2={W - edge} stroke={COLORS.black} strokeWidth={1.5} />
        {labels}
        {holes}
        {links}
      </g>
    </svg>
  );
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function cellLabel(cell: number): string {
  const [x, y] = xy(cell);
  return pointToStr(x, y);
}
