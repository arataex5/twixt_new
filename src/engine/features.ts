// twixtbot のニューラルネット入力を作る。
// 仕様(TWIXT_CPU構築案.md 0章): 手番側が「白(上下を結ぶ)」になるよう正規化(黒番は転置+色入替)。
// 配列レイアウトは numpy の (24,24,C) = [x][y][ch]。

import { SIZE, linkEnds, xy, type Player } from "../core/board";
import type { Board } from "../core/game";

export const POLICY_SIZE = (SIZE - 2) * SIZE; // 528: x∈1..22, y∈0..23

export interface NetInput {
  pegs: Float32Array; // [24][24][2]  ch0 = 相手(黒) ch1 = 自分(白)
  links: Float32Array; // [24][24][8]
  locs: Float32Array; // [24][24][2]  定数
  transposed: boolean; // 黒番のとき true(出力の座標を戻すのに使う)
}

export const LOCS: Float32Array = (() => {
  const a = new Float32Array(SIZE * SIZE * 2);
  for (let x = 0; x < SIZE; x++) {
    for (let y = 0; y < SIZE; y++) {
      a[(x * SIZE + y) * 2 + 0] = y / SIZE; // ch0[x][y] = y/24
      a[(x * SIZE + y) * 2 + 1] = x / SIZE; // ch1[x][y] = x/24
    }
  }
  return a;
})();

/** 盤面 → ネット入力 */
export function encode(board: Board, toMove: Player): NetInput {
  const t = toMove === "black"; // 転置するか
  const pegs = new Float32Array(SIZE * SIZE * 2);
  const links = new Float32Array(SIZE * SIZE * 8);

  // 正規化後の座標・色に変換する補助
  const norm = (cell: number): [number, number] => {
    const [x, y] = xy(cell);
    return t ? [y, x] : [x, y];
  };
  const colorOf = (owner: Player): number => {
    // 正規化後: 0 = 相手(黒) 1 = 自分(白)
    const isMe = owner === toMove;
    return isMe ? 1 : 0;
  };

  for (let cell = 0; cell < SIZE * SIZE; cell++) {
    const o = board.cells[cell];
    if (o === null) continue;
    const [x, y] = norm(cell);
    pegs[(x * SIZE + y) * 2 + colorOf(o)] = 1;
  }

  // リンク面(まず twixtbot の内部表現 = 中点に格納)
  const raw = new Uint8Array(SIZE * SIZE * 8);
  for (const [id, owner] of board.links) {
    const [a, b] = linkEnds(id);
    const [ax, ay] = norm(a);
    const [bx, by] = norm(b);
    const color = colorOf(owner);
    const longy = (ax + bx) % 2 !== 0 ? 1 : 0; // 長辺が y 方向
    const diffsign = (by - ay) * (bx - ax) < 0 ? 1 : 0;
    const index = color + 2 * diffsign + 4 * longy;
    const cx = Math.floor((ax + bx) / 2);
    const cy = Math.floor((ay + by) / 2);
    raw[(cx * SIZE + cy) * 8 + index] = 1;
  }
  // 入力直前のシフト: (longy or diffsign) → x+1、(!longy or diffsign) → y+1
  for (let index = 0; index < 8; index++) {
    const longy = (index & 4) !== 0;
    const diffsign = (index & 2) !== 0;
    const dx = longy || diffsign ? 1 : 0;
    const dy = !longy || diffsign ? 1 : 0;
    for (let x = 0; x < SIZE; x++) {
      for (let y = 0; y < SIZE; y++) {
        if (!raw[(x * SIZE + y) * 8 + index]) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < SIZE && ny < SIZE) links[(nx * SIZE + ny) * 8 + index] = 1;
      }
    }
  }

  return { pegs, links, locs: LOCS, transposed: t };
}

/** 正規化座標 (x∈1..22, y) → policy index */
export function policyIndexOf(nx: number, ny: number): number {
  return (nx - 1) * SIZE + ny;
}

/** policy index → 元の盤面のセル index(黒番なら転置を戻す) */
export function policyIndexToCell(i: number, transposed: boolean): number {
  const nx = Math.floor(i / SIZE) + 1;
  const ny = i % SIZE;
  const x = transposed ? ny : nx;
  const y = transposed ? nx : ny;
  return x * SIZE + y;
}

/** 元の盤面のセル index → policy index(置けない辺行なら -1) */
export function cellToPolicyIndex(cell: number, transposed: boolean): number {
  const [x, y] = xy(cell);
  const nx = transposed ? y : x;
  const ny = transposed ? x : y;
  if (nx < 1 || nx > SIZE - 2) return -1;
  return policyIndexOf(nx, ny);
}

/** 合法手マスク(policy index 順)。手番側が置ける空き穴 = 1 */
export function legalMask(board: Board, toMove: Player): Uint8Array {
  const m = new Uint8Array(POLICY_SIZE);
  const t = toMove === "black";
  for (let i = 0; i < POLICY_SIZE; i++) {
    const cell = policyIndexToCell(i, t);
    if (board.cells[cell] !== null) continue;
    const [x, y] = xy(cell);
    // 四隅は置けない(policy 上は nx∈1..22 なので、四隅は y 側の辺で除外される)
    if ((x === 0 || x === SIZE - 1) && (y === 0 || y === SIZE - 1)) continue;
    m[i] = 1;
  }
  return m;
}

/** 3 値ロジット (負け, 引分, 勝ち) → 手番側の評価値 −1..+1 */
export function threeToValue(l: number, d: number, w: number): number {
  const el = Math.exp(l - d), ew = Math.exp(w - d);
  const div = 1 + el + ew;
  return ew / div - el / div;
}
