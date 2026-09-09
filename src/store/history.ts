// 対局履歴と「進行中の対局」の保存(localStorage)。1 局は棋譜文字列なので小さい。
import type { Player } from "../core/board";
import type { GameSettings, Move, Result } from "../core/game";
import { movesToStr, strToMoves } from "../core/notation";

export interface CpuInfo {
  color: Player;
  level: number;
  strongestTimeMs?: number;
}

export interface GameRecord {
  id: string;
  /** 開始/終了時刻(ISO) */
  startedAt: string;
  endedAt: string;
  mode: "local" | "cpu";
  settings: GameSettings;
  cpu?: CpuInfo;
  /** 棋譜(空白区切り) */
  moves: string;
  result: Exclude<Result, null>;
  /** 手動で付けたメモ */
  note?: string;
}

export interface InProgressGame {
  startedAt: string;
  mode: "local" | "cpu";
  settings: GameSettings;
  cpu?: CpuInfo;
  moves: string;
  updatedAt: string;
}

const HISTORY_KEY = "twixt.history.v1";
const INPROGRESS_KEY = "twixt.inprogress.v1";
const MAX_RECORDS = 300;

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadHistory(): GameRecord[] {
  return read<GameRecord[]>(HISTORY_KEY) ?? [];
}

export function addRecord(rec: Omit<GameRecord, "id">): GameRecord {
  const list = loadHistory();
  const full: GameRecord = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, ...rec };
  list.unshift(full);
  if (list.length > MAX_RECORDS) list.length = MAX_RECORDS;
  write(HISTORY_KEY, list);
  return full;
}

export function updateRecord(id: string, patch: Partial<GameRecord>): void {
  const list = loadHistory();
  const i = list.findIndex((r) => r.id === id);
  if (i < 0) return;
  list[i] = { ...list[i], ...patch };
  write(HISTORY_KEY, list);
}

export function deleteRecord(id: string): void {
  write(HISTORY_KEY, loadHistory().filter((r) => r.id !== id));
}

export function clearHistory(): void {
  write(HISTORY_KEY, []);
}

export function loadInProgress(): InProgressGame | null {
  const g = read<InProgressGame>(INPROGRESS_KEY);
  if (!g || !g.moves) return null;
  return g;
}

export function saveInProgress(g: InProgressGame): void {
  write(INPROGRESS_KEY, g);
}

export function clearInProgress(): void {
  try { localStorage.removeItem(INPROGRESS_KEY); } catch { /* ignore */ }
}

export function recordMoves(rec: { moves: string }): Move[] {
  return strToMoves(rec.moves);
}

export function movesString(moves: Move[]): string {
  return movesToStr(moves);
}

export function resultLabel(r: Exclude<Result, null>, cpu?: CpuInfo): string {
  if (r.winner === "draw") return "引き分け";
  const who = r.winner === "white" ? "白" : "黒";
  const side = cpu ? (r.winner === cpu.color ? "CPU の勝ち" : "あなたの勝ち") : `${who}の勝ち`;
  const reason = r.reason === "connect" ? "連結" : r.reason === "resign" ? "投了" : "";
  return reason ? `${side}(${reason})` : side;
}
