// 着手の「ねらい」を盤面から機械的に読み取るモジュール。
// ニューラルネットは理由を持たないので、ここでは盤面から計算できる事実
// (残り距離・ブロック・セットアップ)だけを取り出し、UI 側でネットの数値と合わせて解説にする。
import {
  CELLS, KNIGHT, SIZE, canPlaceAt, idx, inBounds, linkId, other, xy,
  type Player,
} from "./board";
import type { Board, GameState } from "./game";
import { crossingCandidates } from "./links";
import { pointToStr } from "./notation";

const INF = 1 << 28;

/** player にとってそのセルを通る費用。自分のペグ 0 / 置ける空き穴 1 / 通れない INF */
function cellCost(board: Board, player: Player, c: number): number {
  const o = board.cells[c];
  if (o === player) return 0;
  if (o !== null) return INF;
  const [x, y] = xy(c);
  return canPlaceAt(player, x, y) ? 1 : INF;
}

/**
 * a-b 間に player のリンクが通せるか。
 * 相手のリンクと交差する場合だけ不可(自分のリンクは標準ルールなら外せる・PP なら交差可)。
 */
export function linkPassable(board: Board, player: Player, a: number, b: number): boolean {
  const id = linkId(a, b);
  const owner = board.links.get(id);
  if (owner === player) return true;
  if (owner !== undefined) return false;
  const opp = other(player);
  for (const c of crossingCandidates(id)) if (board.links.get(c) === opp) return false;
  return true;
}

function knightNeighbors(c: number): number[] {
  const [x, y] = xy(c);
  const out: number[] = [];
  for (const [dx, dy] of KNIGHT) {
    const nx = x + dx, ny = y + dy;
    if (inBounds(nx, ny)) out.push(idx(nx, ny));
  }
  return out;
}

export interface Connection {
  /** 2 辺を結ぶのに、あと何個ペグを足せばよいか(最短) */
  cost: number;
  /** その最短ルートが通るセル */
  path: number[];
}

/** player が自分の 2 辺を結ぶ最短ルート。結べないなら null(0-1 BFS) */
export function connectionPlan(board: Board, player: Player): Connection | null {
  const dist = new Int32Array(CELLS).fill(INF);
  const parent = new Int32Array(CELLS).fill(-1);
  const cap = CELLS * 24;
  const dq = new Int32Array(cap);
  let head = cap >> 1, tail = cap >> 1;
  const pushFront = (v: number) => { dq[--head] = v; };
  const pushBack = (v: number) => { dq[tail++] = v; };

  for (let k = 0; k < SIZE; k++) {
    const s = player === "white" ? idx(k, 0) : idx(0, k);
    const c = cellCost(board, player, s);
    if (c >= INF) continue;
    dist[s] = c;
    if (c === 0) pushFront(s); else pushBack(s);
  }

  const isGoal = (c: number) => {
    const [x, y] = xy(c);
    return player === "white" ? y === SIZE - 1 : x === SIZE - 1;
  };

  while (head < tail) {
    const c = dq[head++];
    if (isGoal(c)) {
      const path: number[] = [];
      for (let cur = c; cur !== -1; cur = parent[cur]) path.push(cur);
      return { cost: dist[c], path: path.reverse() };
    }
    for (const n of knightNeighbors(c)) {
      const w = cellCost(board, player, n);
      if (w >= INF) continue;
      if (!linkPassable(board, player, c, n)) continue;
      const nd = dist[c] + w;
      if (nd < dist[n]) {
        dist[n] = nd;
        parent[n] = c;
        if (w === 0) pushFront(n); else pushBack(n);
      }
    }
  }
  return null;
}

/** 2 つの自ペグを「1 手で結べる空き穴」の数(2 以上ならセットアップ = 相手は 1 手で防げない) */
function waysBetween(board: Board, player: Player, a: number, b: number): number {
  if (board.links.has(linkId(a, b))) return 99; // すでに直結
  let n = 0;
  for (const m of knightNeighbors(a)) {
    if (board.cells[m] !== null) continue;
    const [mx, my] = xy(m);
    if (!canPlaceAt(player, mx, my)) continue;
    if (!knightNeighbors(m).includes(b)) continue;
    if (!linkPassable(board, player, m, a)) continue;
    if (!linkPassable(board, player, m, b)) continue;
    n++;
  }
  return n;
}

export interface MoveFacts {
  player: Player;
  cell: number;
  coord: string;
  /** その手で新しく張れたリンクの数 / 外したリンクの数 */
  newLinks: number;
  removedLinks: number;
  /** 分かれていた自分のかたまりをいくつ橋渡ししたか */
  joinedGroups: number;
  /** 自分・相手の「あと何個必要か」。null は連結不可 */
  myBefore: number | null;
  myAfter: number | null;
  oppBefore: number | null;
  oppAfter: number | null;
  /** 相手の最短ルート上の穴を取ったか */
  onOppPath: boolean;
  /** 新しく作ったセットアップ(2 通り以上で結べる相手ペグ) */
  setupsMade: { with: string; ways: number }[];
  /** 相手のセットアップを削ったもの */
  oppSetupsCut: { a: string; b: string; before: number; after: number }[];
  finished: "win" | "draw" | null;
}

/** before の手番側が指した 1 手(after の最終手)を分析する。place 以外なら null */
export function analyzeMove(before: GameState, after: GameState): MoveFacts | null {
  const move = after.moves[after.moves.length - 1];
  if (!move || move.type !== "place") return null;
  const player = before.toMove;
  const opp = other(player);
  const cell = idx(move.x, move.y);

  const myBeforePlan = connectionPlan(before.board, player);
  const myAfterPlan = connectionPlan(after.board, player);
  const oppBeforePlan = connectionPlan(before.board, opp);
  const oppAfterPlan = connectionPlan(after.board, opp);

  // 新しく張られた/外れたリンク
  let newLinks = 0;
  for (const [id, owner] of after.board.links) {
    if (owner === player && !before.board.links.has(id)) newLinks++;
  }
  const removedLinks = move.removeLinks?.length ?? 0;

  // 橋渡し: 新ペグにつながった相手先が、着手前は何個のかたまりに分かれていたか
  const linked = knightNeighbors(cell).filter((n) => after.board.links.get(linkId(cell, n)) === player);
  const groups = new Set<number>();
  const seen = new Uint8Array(CELLS);
  for (const start of linked) {
    if (seen[start]) continue;
    const root = start;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      for (const n of knightNeighbors(c)) {
        if (seen[n]) continue;
        if (before.board.links.get(linkId(c, n)) !== player) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    groups.add(root);
  }

  // 新しく作ったセットアップ
  const setupsMade: MoveFacts["setupsMade"] = [];
  const nearby = new Set<number>();
  for (const m of knightNeighbors(cell)) for (const q of knightNeighbors(m)) if (q !== cell) nearby.add(q);
  for (const q of nearby) {
    if (after.board.cells[q] !== player) continue;
    if (after.board.links.has(linkId(cell, q))) continue;
    const ways = waysBetween(after.board, player, cell, q);
    if (ways >= 2) setupsMade.push({ with: pointToStr(...xy(q)), ways });
  }
  setupsMade.sort((a, b) => b.ways - a.ways);

  // 相手のセットアップを削ったか(取った穴の両隣にある相手ペグの組を見る)
  const oppPegs = knightNeighbors(cell).filter((n) => before.board.cells[n] === opp);
  const oppSetupsCut: MoveFacts["oppSetupsCut"] = [];
  for (let i = 0; i < oppPegs.length; i++) {
    for (let j = i + 1; j < oppPegs.length; j++) {
      const a = oppPegs[i], b = oppPegs[j];
      if (before.board.links.has(linkId(a, b))) continue;
      const w0 = waysBetween(before.board, opp, a, b);
      if (w0 < 2 || w0 === 99) continue;
      const w1 = waysBetween(after.board, opp, a, b);
      if (w1 < w0) oppSetupsCut.push({ a: pointToStr(...xy(a)), b: pointToStr(...xy(b)), before: w0, after: w1 });
    }
  }

  return {
    player,
    cell,
    coord: pointToStr(move.x, move.y),
    newLinks,
    removedLinks,
    joinedGroups: groups.size,
    myBefore: myBeforePlan?.cost ?? null,
    myAfter: myAfterPlan?.cost ?? null,
    oppBefore: oppBeforePlan?.cost ?? null,
    oppAfter: oppAfterPlan?.cost ?? null,
    onOppPath: oppBeforePlan ? oppBeforePlan.path.includes(cell) : false,
    setupsMade,
    oppSetupsCut,
    finished: after.result ? (after.result.winner === "draw" ? "draw" : "win") : null,
  };
}

const dist = (v: number | null) => (v === null ? "連結不可" : `あと ${v} 個`);

/** 分析結果を日本語の解説にする */
export function explainMove(f: MoveFacts): { headline: string; bullets: string[] } {
  const gainMy = f.myBefore !== null && f.myAfter !== null ? f.myBefore - f.myAfter : 0;
  const gainOpp = f.oppBefore !== null && f.oppAfter !== null ? f.oppAfter - f.oppBefore : 0;

  let headline: string;
  if (f.finished === "win") headline = "この手で 2 辺がつながり、勝ちになりました";
  else if (f.finished === "draw") headline = "双方とも連結できなくなり、引き分けになりました";
  else if (f.oppAfter === null) headline = "相手の道を完全に断ちました";
  else if (gainOpp >= 2 && gainMy >= 1) headline = "自分の道を伸ばしながら相手も止める、攻防兼備の手";
  else if (gainOpp >= 2) headline = "相手の道を止めにいく、受け(ブロック)の手";
  else if (gainMy >= 2) headline = "自分の道を大きく縮める、攻めの手";
  else if (gainMy >= 1) headline = "自分の道を 1 歩進める手";
  else if (f.setupsMade.length > 0) headline = "先を見た布石(セットアップ作り)";
  else if (f.onOppPath) headline = "相手の進路をふさぐ、けん制の手";
  else headline = "陣地を広げる布石。直接の効果はまだ小さい";

  const bullets: string[] = [];
  bullets.push(`自分の残り距離: ${dist(f.myBefore)} → ${dist(f.myAfter)}${gainMy > 0 ? `(${gainMy} 縮んだ)` : ""}`);
  bullets.push(`相手の残り距離: ${dist(f.oppBefore)} → ${dist(f.oppAfter)}${gainOpp > 0 ? `(${gainOpp} 伸ばした)` : ""}`);
  if (f.onOppPath) bullets.push("相手の最短ルート上の穴を先に取った");
  if (f.newLinks > 0) bullets.push(`この手で ${f.newLinks} 本のリンクが張られた${f.joinedGroups >= 2 ? `(離れていた ${f.joinedGroups} 個のかたまりを橋渡し)` : ""}`);
  if (f.removedLinks > 0) bullets.push(`道を空けるため自分のリンクを ${f.removedLinks} 本外した`);
  for (const s of f.setupsMade.slice(0, 3)) {
    bullets.push(`${s.with} とは ${s.ways} 通りで結べる関係(セットアップ)。相手は 1 手では両方を防げない`);
  }
  for (const c of f.oppSetupsCut.slice(0, 3)) {
    bullets.push(c.after === 0
      ? `相手の ${c.a}–${c.b} のつながりを切った`
      : `相手の ${c.a}–${c.b} を ${c.before} 通り → ${c.after} 通りに減らした`);
  }
  if (f.setupsMade.length === 0 && f.newLinks === 0) bullets.push("既存のペグとはまだつながっていない(先行投資の一手)");
  return { headline, bullets };
}
