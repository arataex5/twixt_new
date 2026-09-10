// エンジン同士の自動対局(レベル校正用)。Node 上で ONNX Runtime Web(wasm)を動かす。
// 実行: npm run selfplay -- --pairs 3:4,4:5 --games 20 --jobs 4
//   レベル指定: 1〜6 = levels.ts の定義、sN = MCTS N 回、tN = 時間制 N ms(例 s20, t5000)
//   出力: 各ペアの勝率(A 側から見て)と 95% 信頼区間、1 手あたりの評価回数と時間
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import type { Player } from "../src/core/board";
import { applyMove, newGame, type GameSettings, type GameState, type Result } from "../src/core/game";
import { movesToStr } from "../src/core/notation";
import { LEVELS, type LevelSpec } from "../src/engine/levels";
import { Net } from "../src/engine/net";
import { chooseMove } from "../src/engine/think";

interface Args {
  pairs: [string, string][];
  games: number;
  jobs: number;
  pie: boolean;
  rules: GameSettings["rules"];
  maxPlies: number;
  out?: string;
}

interface Job { pair: number; game: number; a: string; b: string; aIsWhite: boolean }

interface GameResult extends Job {
  winner: Player | "draw";
  reason: string;
  plies: number;
  moves: string;
  /** 各側の平均: 1 手の評価回数と時間(ms) */
  stats: Record<"a" | "b", { moves: number; evals: number; ms: number; sims: number }>;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { pairs: [], games: 20, jobs: 2, pie: true, rules: "standard", maxPlies: 400 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === "--pairs") { a.pairs = v.split(",").map((p) => p.split(":") as [string, string]); i++; }
    else if (k === "--games") { a.games = Number(v); i++; }
    else if (k === "--jobs") { a.jobs = Number(v); i++; }
    else if (k === "--pie") { a.pie = v !== "0"; i++; }
    else if (k === "--rules") { a.rules = v as GameSettings["rules"]; i++; }
    else if (k === "--maxPlies") { a.maxPlies = Number(v); i++; }
    else if (k === "--out") { a.out = v; i++; }
    else throw new Error(`unknown arg: ${k}`);
  }
  if (a.pairs.length === 0) throw new Error("--pairs が必要(例 --pairs 3:4,4:5)");
  return a;
}

export function specOf(token: string): LevelSpec {
  const m = /^([st])(\d+)$/.exec(token);
  if (m) {
    const n = Number(m[2]);
    return m[1] === "s"
      ? { level: 0, name: `MCTS ${n} sims`, sims: n, temperature: 0, topK: 1, description: "" }
      : { level: 0, name: `MCTS ${n} ms`, sims: 0, timeMs: n, temperature: 0, topK: 1, description: "" };
  }
  const spec = LEVELS.find((l) => l.level === Number(token));
  if (!spec) throw new Error(`unknown level: ${token}`);
  return spec;
}

function reasonOf(r: Result): string {
  if (!r) return "maxPlies";
  return r.reason;
}

async function playGame(net: Net, job: Job, settings: GameSettings, maxPlies: number): Promise<GameResult> {
  const specs: Record<Player, LevelSpec> = {
    white: specOf(job.aIsWhite ? job.a : job.b),
    black: specOf(job.aIsWhite ? job.b : job.a),
  };
  const stats = { a: { moves: 0, evals: 0, ms: 0, sims: 0 }, b: { moves: 0, evals: 0, ms: 0, sims: 0 } };
  let state: GameState = newGame(settings);
  while (!state.result && state.moves.length < maxPlies) {
    const side: "a" | "b" = (state.toMove === "white") === job.aIsWhite ? "a" : "b";
    const before = net.evalCount;
    const t0 = performance.now();
    const r = await chooseMove(net, state, specs[state.toMove]);
    const st = stats[side];
    st.moves++;
    st.evals += net.evalCount - before;
    st.ms += performance.now() - t0;
    st.sims += r.sims ?? 0;
    state = applyMove(state, r.move);
  }
  const winner = state.result?.winner ?? "draw";
  return { ...job, winner, reason: reasonOf(state.result), plies: state.moves.length, moves: movesToStr(state.moves), stats };
}

async function workerMain() {
  const { jobs, settings, maxPlies, root } = workerData as { jobs: Job[]; settings: GameSettings; maxPlies: number; root: string };
  const net = new Net();
  await net.load(`file://${root}/public/`, new Uint8Array(readFileSync(`${root}/public/models/twixtbot.onnx`)));
  for (const job of jobs) {
    const res = await playGame(net, job, settings, maxPlies);
    parentPort!.postMessage(res);
  }
  parentPort!.postMessage({ done: true });
}

/** Wilson 95% 信頼区間 */
function wilson(wins: number, n: number): [number, number] {
  if (n === 0) return [0, 1];
  const z = 1.96, p = wins / n;
  const den = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(centre - half) / den, (centre + half) / den];
}

function summarize(args: Args, results: GameResult[]): string {
  const lines: string[] = [];
  lines.push(`| ペア (A vs B) | 局数 | A 勝率 | 95% CI | A 白番勝 | A 黒番勝 | 引分 | 平均手数 | A: 評価/手, ms/手 | B: 評価/手, ms/手 |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|---|`);
  args.pairs.forEach(([a, b], pi) => {
    const rs = results.filter((r) => r.pair === pi);
    const n = rs.length;
    const aWins = rs.filter((r) => r.winner !== "draw" && (r.winner === "white") === r.aIsWhite);
    const draws = rs.filter((r) => r.winner === "draw").length;
    const aWhite = aWins.filter((r) => r.aIsWhite).length;
    const aBlack = aWins.length - aWhite;
    const whiteGames = rs.filter((r) => r.aIsWhite).length;
    const [lo, hi] = wilson(aWins.length + draws / 2, n);
    const plies = n ? rs.reduce((s, r) => s + r.plies, 0) / n : 0;
    const agg = (side: "a" | "b") => {
      const m = rs.reduce((s, r) => s + r.stats[side].moves, 0) || 1;
      const ev = rs.reduce((s, r) => s + r.stats[side].evals, 0) / m;
      const ms = rs.reduce((s, r) => s + r.stats[side].ms, 0) / m;
      return `${ev.toFixed(1)}, ${ms.toFixed(0)}`;
    };
    lines.push(`| Lv${a} vs Lv${b} | ${n} | ${n ? (((aWins.length + draws / 2) / n) * 100).toFixed(0) : "-"}% | ${(lo * 100).toFixed(0)}–${(hi * 100).toFixed(0)}% | ${aWhite}/${whiteGames} | ${aBlack}/${n - whiteGames} | ${draws} | ${plies.toFixed(0)} | ${agg("a")} | ${agg("b")} |`);
  });
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const settings: GameSettings = { pieRule: args.pie, rules: args.rules };
  const root = process.cwd();
  const jobs: Job[] = [];
  args.pairs.forEach(([a, b], pair) => {
    for (let game = 0; game < args.games; game++) jobs.push({ pair, game, a, b, aIsWhite: game % 2 === 0 });
  });
  // 手番順に並べると同じペアが同時に走って偏るので、ジョブは各 worker に round-robin で配る
  const buckets: Job[][] = Array.from({ length: Math.min(args.jobs, jobs.length) }, () => []);
  jobs.forEach((j, i) => buckets[i % buckets.length].push(j));

  const results: GameResult[] = [];
  const t0 = Date.now();
  const self = fileURLToPath(import.meta.url);
  await Promise.all(buckets.map((bucket) => new Promise<void>((resolve, reject) => {
    const w = new Worker(self, { workerData: { jobs: bucket, settings, maxPlies: args.maxPlies, root } });
    w.on("message", (m: GameResult | { done: true }) => {
      if ("done" in m) return;
      results.push(m);
      const aWon = m.winner !== "draw" && (m.winner === "white") === m.aIsWhite;
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`[${elapsed}s ${results.length}/${jobs.length}] Lv${m.a} vs Lv${m.b} #${m.game} A=${m.aIsWhite ? "白" : "黒"} → ${m.winner === "draw" ? "引分" : aWon ? "A 勝" : "B 勝"} (${m.reason}, ${m.plies} 手, A ${m.stats.a.evals}ev/${(m.stats.a.ms / 1000).toFixed(0)}s, B ${m.stats.b.evals}ev/${(m.stats.b.ms / 1000).toFixed(0)}s)`);
    });
    w.on("error", reject);
    w.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exit ${code}`))));
  })));

  results.sort((x, y) => x.pair - y.pair || x.game - y.game);
  const table = summarize(args, results);
  console.log("\n" + table);
  if (args.out) {
    writeFileSync(args.out, JSON.stringify({ args, elapsedSec: (Date.now() - t0) / 1000, table, results }, null, 1));
    console.log(`\n→ ${args.out}`);
  }
}

if (isMainThread) main().catch((e) => { console.error(e); process.exit(1); });
else workerMain().catch((e) => { console.error(e); process.exit(1); });
