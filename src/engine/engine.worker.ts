/// <reference lib="webworker" />
import { SIZE, idx, xy } from "../core/board";
import { applyMove, newGame, replay, type GameState, type Move } from "../core/game";
import { crossingCandidates } from "../core/links";
import { policyIndexToCell } from "./features";
import { levelSpec } from "./levels";
import { Net } from "./net";
import type { Candidate, FromWorker, ToWorker } from "./protocol";

const net = new Net();
let current: { id: number; cancelled: boolean } | null = null;

const post = (m: FromWorker) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (e: MessageEvent<ToWorker>) => {
  const msg = e.data;
  try {
    if (msg.type === "init") {
      const t0 = performance.now();
      await net.load(msg.baseUrl);
      const loadMs = performance.now() - t0;
      const t1 = performance.now();
      await net.evaluate(newGame().board, "white", false);
      post({ type: "ready", loadMs, evalMs: performance.now() - t1 });
    } else if (msg.type === "think") {
      current = { id: msg.id, cancelled: false };
      const state = replay(msg.settings, msg.moves);
      const res = await think(state, msg.level, current);
      if (current.cancelled) post({ type: "cancelled", id: msg.id });
      else post({ type: "move", id: msg.id, ...res });
    } else if (msg.type === "cancel") {
      if (current && current.id === msg.id) current.cancelled = true;
    }
  } catch (err) {
    post({ type: "error", id: msg.type === "think" ? msg.id : undefined, message: (err as Error).message });
  }
};

interface ThinkResult { move: Move; value: number; candidates: Candidate[]; evalMs: number }

async function think(state: GameState, level: number, job: { cancelled: boolean }): Promise<ThinkResult> {
  const t0 = performance.now();
  const spec = levelSpec(level);

  // 先手の初手(パイルール有り): スワップされてもされなくても五分に近い点を選ぶ
  if (state.moves.length === 0 && state.settings.pieRule) {
    const r = await balancedFirstMove(state, job);
    return { ...r, evalMs: performance.now() - t0 };
  }

  // 後手の 1 手目: スワップ判断
  if (state.canSwap && state.toMove === "black") {
    const ev = await net.evaluate(state.board, "black", false);
    const first = state.moves[0];
    const heuristic = first.type === "place" && wantSwapHeuristic(first.x, first.y);
    // ネットが「黒不利」と言えばスワップ。判断が僅差(|v|<0.05)なら経験則に従う
    const swap = Math.abs(ev.value) < 0.05 ? heuristic : ev.value < 0;
    if (swap) {
      return { move: { type: "swap" }, value: -ev.value, candidates: [], evalMs: performance.now() - t0 };
    }
  }

  const ev = await net.evaluate(state.board, state.toMove, true);
  if (job.cancelled) return { move: { type: "resign" }, value: 0, candidates: [], evalMs: 0 };

  // 候補手(上位 10)
  const order = Array.from({ length: ev.policy.length }, (_, i) => i).filter((i) => ev.legal[i]).sort((a, b) => ev.policy[b] - ev.policy[a]);
  const candidates: Candidate[] = order.slice(0, 10).map((i) => ({ cell: policyIndexToCell(i, ev.transposed), p: ev.policy[i] }));

  // 温度サンプリング
  let pick: number;
  if (spec.temperature <= 0 || spec.topK <= 1) {
    pick = order[0];
  } else {
    const top = order.slice(0, spec.topK);
    const w = top.map((i) => Math.pow(ev.policy[i], 1 / spec.temperature));
    const s = w.reduce((a, b) => a + b, 0);
    let r = Math.random() * s;
    pick = top[top.length - 1];
    for (let k = 0; k < top.length; k++) { r -= w[k]; if (r <= 0) { pick = top[k]; break; } }
  }
  const cell = policyIndexToCell(pick, ev.transposed);
  const [x, y] = xy(cell);
  const move = placeWithRemoval(state, x, y);
  return { move, value: ev.value, candidates, evalMs: performance.now() - t0 };
}

/** 標準ルールで自リンクが邪魔な場合は外して置く(ネットは PP ルール前提なので、置けるリンクは全部張る) */
function placeWithRemoval(state: GameState, x: number, y: number): Move {
  if (state.settings.rules !== "standard") return { type: "place", x, y };
  // PP ルールで張れるリンク集合と standard で張れる集合を比べ、差があれば自リンク除去で解決を試みる
  const asPP = applyMove({ ...state, settings: { ...state.settings, rules: "pp" } }, { type: "place", x, y });
  const asStd = applyMove(state, { type: "place", x, y });
  if (asPP.board.links.size <= asStd.board.links.size) return { type: "place", x, y };
  // PP では張れて standard では張れないリンクを妨げている自リンクを探す
  const remove = new Set<number>();
  for (const [id] of asPP.board.links) {
    if (asStd.board.links.has(id)) continue;
    for (const c of crossingCandidates(id)) if (state.board.links.get(c) === state.toMove) remove.add(c);
  }
  if (remove.size === 0) return { type: "place", x, y };
  return { type: "place", x, y, removeLinks: [...remove] };
}

/** twixtbot-ui の swapmodel と同じ経験則: 7〜18 行目、または B6/C6/V6/W6/B19/C19/V19/W19 ならスワップ */
function wantSwapHeuristic(x: number, y: number): boolean {
  const row = y + 1;
  if (row >= 7 && row <= 18) return true;
  const col = String.fromCharCode(65 + x);
  return (row === 6 || row === 19) && ["B", "C", "V", "W"].includes(col);
}

async function balancedFirstMove(state: GameState, job: { cancelled: boolean }): Promise<{ move: Move; value: number; candidates: Candidate[] }> {
  // 候補: 6 行目 / 19 行目(1-indexed)の D〜T 列。スワップ境界に近く、五分に近い点が多い
  const cands: number[] = [];
  for (const y of [5, SIZE - 6]) for (let x = 3; x <= SIZE - 4; x++) cands.push(idx(x, y));
  const scored: { cell: number; v: number }[] = [];
  for (const cell of cands) {
    if (job.cancelled) break;
    const [x, y] = xy(cell);
    const s = applyMove(state, { type: "place", x, y });
    const ev = await net.evaluate(s.board, "black", false); // 黒から見た評価
    scored.push({ cell, v: ev.value });
  }
  scored.sort((a, b) => Math.abs(a.v) - Math.abs(b.v));
  const best = scored.slice(0, 5);
  const chosen = best[Math.floor(Math.random() * best.length)] ?? { cell: idx(11, 5), v: 0 };
  const [x, y] = xy(chosen.cell);
  return { move: { type: "place", x, y }, value: -chosen.v, candidates: best.map((b) => ({ cell: b.cell, p: 1 - Math.abs(b.v) })) };
}
