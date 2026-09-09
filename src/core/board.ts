// 盤面の基本定義。座標は x = 列(0..23, A..X)、y = 行(0..23, 表示は 1..24)。
// 白(先手)は上下 (y=0 と y=SIZE-1) を結ぶ。黒は左右 (x=0 と x=SIZE-1) を結ぶ。

export const SIZE = 24;
export const CELLS = SIZE * SIZE;

export type Player = "white" | "black";

export function other(p: Player): Player {
  return p === "white" ? "black" : "white";
}

export function idx(x: number, y: number): number {
  return x * SIZE + y;
}

export function xy(i: number): [number, number] {
  return [Math.floor(i / SIZE), i % SIZE];
}

export function inBounds(x: number, y: number): boolean {
  return x >= 0 && x < SIZE && y >= 0 && y < SIZE;
}

export function isCorner(x: number, y: number): boolean {
  return (x === 0 || x === SIZE - 1) && (y === 0 || y === SIZE - 1);
}

/** そのプレイヤーがペグを置ける穴か(相手の辺行・四隅は不可) */
export function canPlaceAt(player: Player, x: number, y: number): boolean {
  if (!inBounds(x, y) || isCorner(x, y)) return false;
  if (player === "white") return x !== 0 && x !== SIZE - 1; // 左右の列は黒の辺行
  return y !== 0 && y !== SIZE - 1; // 上下の行は白の辺行
}

/** ナイト跳びの 8 方向 */
export const KNIGHT: ReadonlyArray<readonly [number, number]> = [
  [1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1],
];

/** リンクの識別子: 両端のセル index の小さい方 * CELLS + 大きい方 */
export type LinkId = number;

export function linkId(a: number, b: number): LinkId {
  return a < b ? a * CELLS + b : b * CELLS + a;
}

export function linkEnds(id: LinkId): [number, number] {
  return [Math.floor(id / CELLS), id % CELLS];
}
