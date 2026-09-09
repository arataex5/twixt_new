export interface LevelSpec {
  level: number;
  name: string;
  /** MCTS シミュレーション数(0 = Policy のみ) */
  sims: number;
  /** 時間制(ms)。sims より優先 */
  timeMs?: number;
  /** 着手選択の温度(0 = 貪欲) */
  temperature: number;
  /** 温度サンプリング時に候補とする上位手数 */
  topK: number;
  description: string;
}

export const LEVELS: LevelSpec[] = [
  { level: 1, name: "入門", sims: 0, temperature: 1.0, topK: 12, description: "ネットの候補手から幅広く選ぶ。時々悪手を打つ" },
  { level: 2, name: "初級", sims: 0, temperature: 0.5, topK: 8, description: "候補手からやや絞って選ぶ" },
  { level: 3, name: "中級", sims: 0, temperature: 0, topK: 1, description: "ネットの最善手をそのまま打つ(twixtbot の trials 0 相当)" },
  { level: 4, name: "上級", sims: 30, temperature: 0, topK: 1, description: "30 回の先読み(MCTS)" },
  { level: 5, name: "有段", sims: 100, temperature: 0, topK: 1, description: "100 回の先読み(MCTS)" },
  { level: 6, name: "最強", sims: 0, timeMs: 5000, temperature: 0, topK: 1, description: "時間いっぱい先読み(端末が速いほど強い)" },
];

/** 現時点で利用可能なレベル(MCTS 実装前は 1〜3) */
export const AVAILABLE_LEVELS = LEVELS.filter((l) => l.sims === 0 && !l.timeMs);

export function levelSpec(level: number): LevelSpec {
  return LEVELS.find((l) => l.level === level) ?? LEVELS[2];
}
