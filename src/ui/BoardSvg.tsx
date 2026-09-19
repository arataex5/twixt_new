import { useCallback, useMemo, useRef, useState } from "react";
import { SIZE, idx, isCorner, linkEnds, xy, type LinkId, type Player } from "../core/board";
import { winningPath, type GameState } from "../core/game";
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
  /** 選択中(未確定)の着手位置 */
  pending?: { x: number; y: number } | null;
  /** 直前がスワップのとき、鏡映前の初手位置(説明用のゴースト表示) */
  swapFrom?: { x: number; y: number } | null;
}

const CELL = 24; // 1 穴のピクセル幅(viewBox 単位)
const PAD = 22;
const W = SIZE * CELL + PAD * 2;

const COLORS = {
  board: "#dcc59c",
  boardEdge: "#bfa478",
  hole: "#a08a5e",
  label: "#6e5a36",
  white: "#fffdf8",
  whiteEdge: "#6f6350",
  black: "#d23c31",
  blackEdge: "#8f1f18",
  last: "#2f5fb3",
  selected: "#f5a623",
  win: "#f2b632",
  candidate: "#2f5fb3",
};

export function BoardSvg(props: BoardSvgProps) {
  const { state, interactive, onPlace, selectedLinks, onToggleLink, rotated, overlay, pending, swapFrom } = props;
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

  const winCells = useMemo(() => {
    if (!state.result || state.result.reason !== "connect") return new Set<number>();
    return new Set(winningPath(state.board, state.result.winner) ?? []);
  }, [state.result, state.board]);

  const holes: React.ReactNode[] = [];
  for (let x = 0; x < SIZE; x++) {
    for (let y = 0; y < SIZE; y++) {
      if (isCorner(x, y)) continue;
      const cx = PAD + x * CELL + CELL / 2, cy = PAD + y * CELL + CELL / 2;
      const owner = state.board.cells[idx(x, y)];
      const ov = overlay?.get(idx(x, y));
      const isLast = state.lastPeg === idx(x, y);
      const isWin = winCells.has(idx(x, y));
      holes.push(
        <g key={`${x}-${y}`}>
          {ov !== undefined && ov > 0.02 && (
            <circle cx={cx} cy={cy} r={CELL * 0.45} fill={COLORS.candidate} opacity={Math.min(0.75, ov)} />
          )}
          {owner === null ? (
            <circle cx={cx} cy={cy} r={CELL * 0.13} fill={COLORS.hole} opacity={legal(x, y) ? 1 : 0.5} />
          ) : (
            <>
              {isLast && !state.result && <circle className="last-ring" cx={cx} cy={cy} r={CELL * 0.5} fill="none" stroke={COLORS.last} strokeWidth={2.5} />}
              {isWin && <circle className="win-glow" cx={cx} cy={cy} r={CELL * 0.55} fill={COLORS.win} opacity={0.7} />}
              <circle key={`peg-${state.moves.length}`} className={isLast ? "peg-new" : undefined} cx={cx} cy={cy} r={CELL * 0.36}
                fill={owner === "white" ? COLORS.white : COLORS.black}
                stroke={owner === "white" ? COLORS.whiteEdge : COLORS.blackEdge}
                strokeWidth={owner === "white" ? 2 : 1.5} filter="url(#pegShadow)" />
              {owner === "white" && <circle cx={cx - CELL * 0.1} cy={cy - CELL * 0.12} r={CELL * 0.11} fill="#fff" opacity={0.9} pointerEvents="none" />}
              {owner === "black" && <circle cx={cx - CELL * 0.1} cy={cy - CELL * 0.12} r={CELL * 0.1} fill="#fff" opacity={0.35} pointerEvents="none" />}
            </>
          )}
        </g>,
      );
    }
  }

  const links: React.ReactNode[] = [];
  const outlines: React.ReactNode[] = [];
  for (const [id, owner] of state.board.links) {
    const [a, b] = linkEnds(id);
    const [ax, ay] = xy(a), [bx, by] = xy(b);
    const sel = selectedLinks?.has(id);
    const isNew = state.lastPeg !== null && (a === state.lastPeg || b === state.lastPeg);
    const onWinPath = winCells.has(a) && winCells.has(b);
    const x1 = PAD + ax * CELL + CELL / 2, y1 = PAD + ay * CELL + CELL / 2, x2 = PAD + bx * CELL + CELL / 2, y2 = PAD + by * CELL + CELL / 2;
    if (onWinPath) links.push(<line key={`w${id}`} className="win-glow" x1={x1} y1={y1} x2={x2} y2={y2} stroke={COLORS.win} strokeWidth={11} strokeLinecap="round" opacity={0.7} />);
    links.push(
      <line key={`${id}-${isNew ? state.moves.length : "s"}`} className={isNew && !sel ? "link-new" : undefined}
        x1={x1} y1={y1} x2={x2} y2={y2}
        stroke={sel ? COLORS.selected : owner === "white" ? COLORS.white : COLORS.black}
        strokeWidth={sel ? 7 : 5} strokeLinecap="round" opacity={sel ? 0.9 : 1}
        strokeDasharray={sel ? "6 5" : undefined} />,
    );
    if (owner === "white" && !sel) outlines.push(<line key={`e${id}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={COLORS.whiteEdge} strokeWidth={7.5} strokeLinecap="round" opacity={0.8} />);
  }

  // 座標ラベル
  const labels: React.ReactNode[] = [];
  for (let k = 0; k < SIZE; k++) {
    const p = PAD + k * CELL + CELL / 2;
    labels.push(<text key={`c${k}`} x={p} y={PAD - 8} fontSize={9} textAnchor="middle" fill={COLORS.label} fontWeight={600} transform={rotated ? `rotate(180 ${p} ${PAD - 11})` : undefined}>{String.fromCharCode(65 + k)}</text>);
    labels.push(<text key={`r${k}`} x={PAD - 8} y={p + 3} fontSize={9} textAnchor="end" fill={COLORS.label} fontWeight={600} transform={rotated ? `rotate(180 ${PAD - 11} ${p})` : undefined}>{k + 1}</text>);
  }

  const edge = PAD + CELL; // 辺行の内側境界
  return (
    <svg ref={svgRef} viewBox={vb} className="board"
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp} onWheel={onWheel}
      style={{ touchAction: "none", userSelect: "none" }}>
      <defs>
        <filter id="pegShadow" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="1.4" stdDeviation="1.1" floodColor="#1f2329" floodOpacity="0.45" />
        </filter>
        <linearGradient id="boardGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e4cfa9" />
          <stop offset="1" stopColor="#d1b784" />
        </linearGradient>
      </defs>
      <rect x={0} y={0} width={W} height={W} fill="url(#boardGrad)" rx={10} />
      <rect x={1} y={1} width={W - 2} height={W - 2} fill="none" stroke={COLORS.boardEdge} strokeWidth={2} rx={9} />
      <g transform={transform}>
        {/* 辺行の帯: 白は上下、赤は左右 */}
        <rect x={edge} y={PAD} width={W - 2 * edge} height={CELL} fill="#fff" opacity={0.4} rx={4} />
        <rect x={edge} y={W - PAD - CELL} width={W - 2 * edge} height={CELL} fill="#fff" opacity={0.4} rx={4} />
        <rect x={PAD} y={edge} width={CELL} height={W - 2 * edge} fill={COLORS.black} opacity={0.22} rx={4} />
        <rect x={W - PAD - CELL} y={edge} width={CELL} height={W - 2 * edge} fill={COLORS.black} opacity={0.22} rx={4} />
        {/* 境界線 */}
        <line x1={edge} y1={edge} x2={W - edge} y2={edge} stroke="#fff" strokeWidth={2} opacity={0.9} />
        <line x1={edge} y1={W - edge} x2={W - edge} y2={W - edge} stroke="#fff" strokeWidth={2} opacity={0.9} />
        <line x1={edge} y1={edge} x2={edge} y2={W - edge} stroke={COLORS.black} strokeWidth={2} opacity={0.6} />
        <line x1={W - edge} y1={edge} x2={W - edge} y2={W - edge} stroke={COLORS.black} strokeWidth={2} opacity={0.6} />
        {/* 中央の目安線(縦横の真ん中) */}
        <line x1={W / 2} y1={edge} x2={W / 2} y2={W - edge} stroke="#fff" strokeWidth={3} strokeDasharray="7 7" opacity={0.7} />
        <line x1={edge} y1={W / 2} x2={W - edge} y2={W / 2} stroke="#fff" strokeWidth={3} strokeDasharray="7 7" opacity={0.7} />
        <line x1={W / 2} y1={edge} x2={W / 2} y2={W - edge} stroke="#1f2329" strokeWidth={1.8} strokeDasharray="7 7" opacity={0.9} />
        <line x1={edge} y1={W / 2} x2={W - edge} y2={W / 2} stroke="#1f2329" strokeWidth={1.8} strokeDasharray="7 7" opacity={0.9} />
        {labels}
        {holes}
        {outlines}
        {links}
        {swapFrom && state.lastPeg !== null && (() => {
          const fx = PAD + swapFrom.x * CELL + CELL / 2, fy = PAD + swapFrom.y * CELL + CELL / 2;
          const [tx, ty] = xy(state.lastPeg);
          const cx = PAD + tx * CELL + CELL / 2, cy = PAD + ty * CELL + CELL / 2;
          return (
            <g pointerEvents="none">
              <line x1={fx} y1={fy} x2={cx} y2={cy} stroke={COLORS.candidate} strokeWidth={2} strokeDasharray="5 5" opacity={0.8} />
              <circle cx={fx} cy={fy} r={CELL * 0.36} fill="none" stroke={COLORS.whiteEdge} strokeWidth={2} strokeDasharray="4 3" />
              <text x={fx} y={fy - CELL * 0.6} fontSize={9} fontWeight={700} textAnchor="middle" fill={COLORS.label}>{pointToStr(swapFrom.x, swapFrom.y)}(白の初手)</text>
            </g>
          );
        })()}
        {pending && state.board.cells[idx(pending.x, pending.y)] === null && (() => {
          const cx = PAD + pending.x * CELL + CELL / 2, cy = PAD + pending.y * CELL + CELL / 2;
          const label = pointToStr(pending.x, pending.y);
          const above = pending.y > 1;
          const ly = above ? cy - CELL * 0.95 : cy + CELL * 0.95;
          return (
            <g className="pending" pointerEvents="none">
              <circle className="pending-ring" cx={cx} cy={cy} r={CELL * 0.55} fill="none" stroke={COLORS.candidate} strokeWidth={2.5} />
              <circle cx={cx} cy={cy} r={CELL * 0.36} fill={state.toMove === "white" ? COLORS.white : COLORS.black} stroke={state.toMove === "white" ? COLORS.whiteEdge : COLORS.blackEdge} strokeWidth={1.5} opacity={0.6} />
              <g transform={rotated ? `rotate(180 ${cx} ${ly})` : undefined}>
                <rect x={cx - 17} y={ly - 9} width={34} height={18} rx={5} fill={COLORS.candidate} />
                <text x={cx} y={ly + 4.5} fontSize={12} fontWeight={700} textAnchor="middle" fill="#fff">{label}</text>
              </g>
            </g>
          );
        })()}
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
