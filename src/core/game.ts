import {
  CELLS, KNIGHT, SIZE, canPlaceAt, idx, inBounds, linkEnds, linkId, other, xy,
  type LinkId, type Player,
} from "./board";
import { crossingCandidates } from "./links";

export type RuleSet = "standard" | "pp";
// standard: 全てのリンクと交差不可。自分のリンクは手番中に外せる。
// pp      : 相手のリンクとのみ交差不可(自リンク同士は交差可)。リンクは外せない。

export interface GameSettings {
  pieRule: boolean;
  rules: RuleSet;
}

export const DEFAULT_SETTINGS: GameSettings = { pieRule: true, rules: "standard" };

export type Move =
  | { type: "place"; x: number; y: number; removeLinks?: LinkId[] }
  | { type: "swap" }
  | { type: "resign" }
  | { type: "draw" }; // 合意による引き分け

export type Result =
  | null
  | { winner: Player; reason: "connect" | "resign" }
  | { winner: "draw"; reason: "agreement" | "noPath" };

export interface Board {
  /** 各セルの所有者。null = 空 */
  cells: (Player | null)[];
  /** 存在するリンク → 所有者 */
  links: Map<LinkId, Player>;
}

export interface GameState {
  settings: GameSettings;
  moves: Move[];
  board: Board;
  toMove: Player;
  result: Result;
  /** 後手がスワップを選べる局面か */
  canSwap: boolean;
  /** 直近に置かれたペグ(ハイライト用) */
  lastPeg: number | null;
}

export class InvalidMoveError extends Error {}

export function newGame(settings: Partial<GameSettings> = {}): GameState {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  return {
    settings: s,
    moves: [],
    board: { cells: new Array<Player | null>(CELLS).fill(null), links: new Map() },
    toMove: "white",
    result: null,
    canSwap: false,
    lastPeg: null,
  };
}

function cloneBoard(b: Board): Board {
  return { cells: b.cells.slice(), links: new Map(b.links) };
}

/** リンク候補 (a,b) が既存リンクと交差して張れないか */
export function isBlocked(board: Board, id: LinkId, owner: Player, rules: RuleSet): boolean {
  for (const c of crossingCandidates(id)) {
    const o = board.links.get(c);
    if (o === undefined) continue;
    if (rules === "pp" && o === owner) continue; // PP: 自リンク同士の交差は許可
    return true;
  }
  return false;
}

/** セル cell の周囲で、owner の既存ペグとの間に張れるリンクを列挙 */
export function linkableFrom(board: Board, cell: number, owner: Player, rules: RuleSet): LinkId[] {
  const [x, y] = xy(cell);
  const out: LinkId[] = [];
  for (const [dx, dy] of KNIGHT) {
    const nx = x + dx, ny = y + dy;
    if (!inBounds(nx, ny)) continue;
    const n = idx(nx, ny);
    if (board.cells[n] !== owner) continue;
    const id = linkId(cell, n);
    if (board.links.has(id)) continue;
    if (isBlocked(board, id, owner, rules)) continue;
    out.push(id);
  }
  return out;
}

/** 隣接リスト(リンクで結ばれたセル) */
function neighbors(board: Board, cell: number, owner: Player): number[] {
  const [x, y] = xy(cell);
  const out: number[] = [];
  for (const [dx, dy] of KNIGHT) {
    const nx = x + dx, ny = y + dy;
    if (!inBounds(nx, ny)) continue;
    const n = idx(nx, ny);
    if (board.cells[n] !== owner) continue;
    if (board.links.get(linkId(cell, n)) === owner) out.push(n);
  }
  return out;
}

/** owner が自分の 2 辺を結んでいるか(リンクで連結したペグの鎖) */
export function hasWon(board: Board, owner: Player): boolean {
  const seen = new Uint8Array(CELLS);
  const stack: number[] = [];
  for (let k = 0; k < SIZE; k++) {
    const start = owner === "white" ? idx(k, 0) : idx(0, k);
    if (board.cells[start] === owner) { seen[start] = 1; stack.push(start); }
  }
  while (stack.length) {
    const c = stack.pop()!;
    const [x, y] = xy(c);
    if (owner === "white" ? y === SIZE - 1 : x === SIZE - 1) return true;
    for (const n of neighbors(board, c, owner)) {
      if (!seen[n]) { seen[n] = 1; stack.push(n); }
    }
  }
  return false;
}

/**
 * owner がこの先どう打っても 2 辺を結べないか(楽観的判定: 空き穴を自分のペグとみなし、
 * 相手リンクとの交差だけを障害とする)。true なら本当に不可能。
 */
export function cannotEverWin(board: Board, owner: Player): boolean {
  const opp = other(owner);
  const seen = new Uint8Array(CELLS);
  const stack: number[] = [];
  const mine = (c: number) => board.cells[c] === owner || (board.cells[c] === null && canPlaceAt(owner, ...xy(c)));
  for (let k = 0; k < SIZE; k++) {
    const start = owner === "white" ? idx(k, 0) : idx(0, k);
    if (mine(start)) { seen[start] = 1; stack.push(start); }
  }
  while (stack.length) {
    const c = stack.pop()!;
    const [x, y] = xy(c);
    if (owner === "white" ? y === SIZE - 1 : x === SIZE - 1) return false;
    for (const [dx, dy] of KNIGHT) {
      const nx = x + dx, ny = y + dy;
      if (!inBounds(nx, ny)) continue;
      const n = idx(nx, ny);
      if (seen[n] || !mine(n)) continue;
      const id = linkId(c, n);
      if (board.links.get(id) === owner) { seen[n] = 1; stack.push(n); continue; }
      let blocked = false;
      for (const cc of crossingCandidates(id)) {
        if (board.links.get(cc) === opp) { blocked = true; break; }
      }
      if (!blocked) { seen[n] = 1; stack.push(n); }
    }
  }
  return true;
}

export function isLegalPlace(state: GameState, x: number, y: number): boolean {
  if (state.result) return false;
  if (!canPlaceAt(state.toMove, x, y)) return false;
  return state.board.cells[idx(x, y)] === null;
}

export function applyMove(state: GameState, move: Move): GameState {
  if (state.result) throw new InvalidMoveError("game is over");
  const { rules } = state.settings;
  const board = cloneBoard(state.board);
  const me = state.toMove;
  let lastPeg = state.lastPeg;
  let result: Result = null;

  switch (move.type) {
    case "place": {
      if (!canPlaceAt(me, move.x, move.y)) throw new InvalidMoveError("cannot place there");
      const cell = idx(move.x, move.y);
      if (board.cells[cell] !== null) throw new InvalidMoveError("occupied");
      if (move.removeLinks?.length) {
        if (rules !== "standard") throw new InvalidMoveError("link removal not allowed");
        for (const id of move.removeLinks) {
          if (board.links.get(id) !== me) throw new InvalidMoveError("not your link");
          board.links.delete(id);
        }
      }
      board.cells[cell] = me;
      for (const id of linkableFrom(board, cell, me, rules)) board.links.set(id, me);
      lastPeg = cell;
      if (hasWon(board, me)) result = { winner: me, reason: "connect" };
      else if (cannotEverWin(board, "white") && cannotEverWin(board, "black")) result = { winner: "draw", reason: "noPath" };
      break;
    }
    case "swap": {
      if (!state.canSwap) throw new InvalidMoveError("swap not available");
      const first = state.moves[0];
      if (first.type !== "place") throw new InvalidMoveError("bad first move");
      const from = idx(first.x, first.y);
      const to = idx(first.y, first.x); // 主対角線で鏡映
      board.cells[from] = null;
      board.cells[to] = "black";
      board.links.clear();
      lastPeg = to;
      break;
    }
    case "resign":
      result = { winner: other(me), reason: "resign" };
      break;
    case "draw":
      result = { winner: "draw", reason: "agreement" };
      break;
  }

  const moves = [...state.moves, move];
  // スワップ後は元の先手(白)が続けて指す
  const toMove = move.type === "swap" ? "white" : other(me);
  return {
    settings: state.settings,
    moves,
    board,
    toMove,
    result,
    canSwap: state.settings.pieRule && moves.length === 1 && move.type === "place",
    lastPeg,
  };
}

/** 手順列から状態を再構築 */
export function replay(settings: Partial<GameSettings>, moves: Move[]): GameState {
  let s = newGame(settings);
  for (const m of moves) s = applyMove(s, m);
  return s;
}

/** 直前の手を取り消した状態(再構築) */
export function undo(state: GameState, count = 1): GameState {
  return replay(state.settings, state.moves.slice(0, Math.max(0, state.moves.length - count)));
}

export { linkEnds };
