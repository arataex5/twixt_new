export interface LevelSpec {
  level: number;
  name: string;
  /** MCTS シミュレーション数(0 = Policy のみ) */
  sims: number;
  /** 時間制(ms)。sims より優先 */
  timeMs?: number;
  /** 時間制のとき、時間が切れてもこの回数までは読む(遅い端末で下のレベルより弱くならないため) */
  minSims?: number;
  /** MCTS の探索定数(既定 1.0) */
  cpuct?: number;
  /** 着手選択の温度(0 = 貪欲) */
  temperature: number;
  /** 温度サンプリング時に候補とする上位手数 */
  topK: number;
  description: string;
}

// 各レベルの強さは scripts/selfplay.ts の自動対局で校正した(docs/level_calibration.md)。
// 隣接レベル間の勝率(上位側): Lv1→2 84%、Lv2→3 80%、Lv3→4 62%、Lv4→5 57%。
export const LEVELS: LevelSpec[] = [
  { level: 1, name: "入門", sims: 0, temperature: 1.3, topK: 16, description: "ネットの候補手から幅広く選ぶ。よく悪手を打つ(Lv2 に 2 割しか勝てない)" },
  { level: 2, name: "初級", sims: 0, temperature: 1.0, topK: 12, description: "候補手を確率どおりに選ぶ。時々悪手を打つ(Lv3 に 2 割)" },
  { level: 3, name: "中級", sims: 0, temperature: 0, topK: 1, description: "ネットの最善手をそのまま打つ(twixtbot の trials 0 相当)。多くの人より強い" },
  { level: 4, name: "上級", sims: 12, temperature: 0, topK: 1, description: "12 回の先読み(MCTS)。スマホで 1 手 3 秒程度" },
  { level: 5, name: "有段", sims: 40, temperature: 0, topK: 1, description: "40 回の先読み(MCTS)。スマホで 1 手 10 秒程度" },
  { level: 6, name: "最強", sims: 0, timeMs: 5000, minSims: 60, temperature: 0, topK: 1, description: "時間いっぱい先読み(端末が速いほど強い)。遅い端末でも最低 60 回は読む" },
];

export const AVAILABLE_LEVELS = LEVELS;

export function levelSpec(level: number, strongestTimeMs?: number): LevelSpec {
  const spec = LEVELS.find((l) => l.level === level) ?? LEVELS[2];
  if (spec.timeMs && strongestTimeMs) return { ...spec, timeMs: strongestTimeMs };
  return spec;
}
