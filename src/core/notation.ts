import { SIZE } from "./board";
import type { Move } from "./game";

/** Little Golem 互換の座標表記: 列 A..X、行 1..24 (例 "F12") */
export function pointToStr(x: number, y: number): string {
  return String.fromCharCode(65 + x) + String(y + 1);
}

export function strToPoint(s: string): { x: number; y: number } {
  const m = /^([A-Xa-x])(\d{1,2})$/.exec(s.trim());
  if (!m) throw new Error(`bad point: ${s}`);
  const x = m[1].toUpperCase().charCodeAt(0) - 65;
  const y = parseInt(m[2], 10) - 1;
  if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) throw new Error(`out of range: ${s}`);
  return { x, y };
}

export function moveToStr(m: Move): string {
  switch (m.type) {
    case "place": return pointToStr(m.x, m.y);
    case "swap": return "swap";
    case "resign": return "resign";
    case "draw": return "draw";
  }
}

export function strToMove(s: string): Move {
  const t = s.trim().toLowerCase();
  if (t === "swap") return { type: "swap" };
  if (t === "resign") return { type: "resign" };
  if (t === "draw") return { type: "draw" };
  return { type: "place", ...strToPoint(s) };
}

/** "F12 swap G10 ..." 形式(空白区切り) */
export function movesToStr(moves: Move[]): string {
  return moves.map(moveToStr).join(" ");
}

export function strToMoves(s: string): Move[] {
  return s.split(/[\s,]+/).filter(Boolean).map(strToMove);
}
