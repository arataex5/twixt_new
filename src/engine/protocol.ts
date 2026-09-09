// UI ⇔ Worker のメッセージ定義
import type { GameSettings, Move } from "../core/game";

export type ToWorker =
  | { type: "init"; baseUrl: string }
  | { type: "think"; id: number; settings: GameSettings; moves: Move[]; level: number }
  | { type: "cancel"; id: number };

export interface Candidate {
  cell: number;
  p: number;
}

export type FromWorker =
  | { type: "ready"; loadMs: number; evalMs: number }
  | { type: "progress"; id: number; done: number; total: number }
  | { type: "move"; id: number; move: Move; value: number; candidates: Candidate[]; evalMs: number }
  | { type: "cancelled"; id: number }
  | { type: "error"; id?: number; message: string };
