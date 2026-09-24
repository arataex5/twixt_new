// UI ⇔ Worker のメッセージ定義
import type { GameSettings, Move } from "../core/game";

export type ToWorker =
  | { type: "init"; baseUrl: string }
  | { type: "think"; id: number; settings: GameSettings; moves: Move[]; level: number; strongestTimeMs?: number }
  | { type: "eval"; id: number; settings: GameSettings; moves: Move[] }
  | { type: "cancel"; id: number };

export interface Candidate {
  cell: number;
  /** Policy の確率(探索なし)または訪問数の割合(MCTS) */
  p: number;
  /** MCTS の訪問数・評価(あれば) */
  n?: number;
  q?: number;
}

export type FromWorker =
  | { type: "ready"; loadMs: number; evalMs: number }
  | { type: "progress"; id: number; done: number; total: number }
  | { type: "move"; id: number; move: Move; value: number; candidates: Candidate[]; evalMs: number; sims?: number }
  | { type: "evaluated"; id: number; value: number; candidates: Candidate[]; evalMs: number }
  | { type: "cancelled"; id: number }
  | { type: "error"; id?: number; message: string };
