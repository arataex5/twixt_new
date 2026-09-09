import { CELLS, KNIGHT, SIZE, idx, inBounds, linkEnds, linkId, xy, type LinkId } from "./board";

/**
 * 2 つの線分が(端点以外で)交差するか。ナイト跳びの線分は端点以外の格子点を通らないため、
 * 端点を共有しない 2 本が接触するのは「真に交差する」場合のみ。
 */
function segmentsCross(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const cross = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    (qx - px) * (ry - py) - (qy - py) * (rx - px);
  const d1 = cross(cx, cy, dx, dy, ax, ay);
  const d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy);
  const d4 = cross(ax, ay, bx, by, dx, dy);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** 盤上に存在しうる全リンク(向きなし)を列挙 */
export function allLinkIds(): LinkId[] {
  const out: LinkId[] = [];
  for (let x = 0; x < SIZE; x++) {
    for (let y = 0; y < SIZE; y++) {
      for (const [dx, dy] of KNIGHT) {
        const nx = x + dx, ny = y + dy;
        if (!inBounds(nx, ny)) continue;
        const a = idx(x, y), b = idx(nx, ny);
        if (a < b) out.push(linkId(a, b));
      }
    }
  }
  return out;
}

/**
 * 交差テーブル: 各リンクに対して、それと交差しうるリンクの一覧(最大 9 本)。
 * 起動時に幾何判定で生成する(手計算のテーブルより間違いにくい)。
 */
const CROSS_TABLE: Map<LinkId, LinkId[]> = (() => {
  const table = new Map<LinkId, LinkId[]>();
  const ids = allLinkIds();
  const idSet = new Set(ids);
  for (const id of ids) {
    const [a, b] = linkEnds(id);
    const [ax, ay] = xy(a);
    const [bx, by] = xy(b);
    const minx = Math.min(ax, bx) - 2, maxx = Math.max(ax, bx) + 2;
    const miny = Math.min(ay, by) - 2, maxy = Math.max(ay, by) + 2;
    const found: LinkId[] = [];
    for (let x = minx; x <= maxx; x++) {
      for (let y = miny; y <= maxy; y++) {
        if (!inBounds(x, y)) continue;
        for (const [dx, dy] of KNIGHT) {
          const nx = x + dx, ny = y + dy;
          if (!inBounds(nx, ny)) continue;
          const c = idx(x, y), d = idx(nx, ny);
          if (c > d) continue;
          const other = linkId(c, d);
          if (other === id || !idSet.has(other)) continue;
          if (c === a || c === b || d === a || d === b) continue;
          if (segmentsCross(ax, ay, bx, by, x, y, nx, ny)) found.push(other);
        }
      }
    }
    table.set(id, found);
  }
  return table;
})();

export function crossingCandidates(id: LinkId): readonly LinkId[] {
  return CROSS_TABLE.get(id) ?? [];
}

/** リンク id の両端セルから、方向(0..7)を求める補助 */
export function linkDirection(id: LinkId): number {
  const [a, b] = linkEnds(id);
  const [ax, ay] = xy(a);
  const [bx, by] = xy(b);
  const dx = bx - ax, dy = by - ay;
  return KNIGHT.findIndex(([kx, ky]) => kx === dx && ky === dy);
}

export { CELLS };
