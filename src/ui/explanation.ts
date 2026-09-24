// CPU の着手解説を組み立てる共通処理(CPU 戦画面・CPU 同士の対戦画面で共用)。
import { xy } from "../core/board";
import { applyMove, type GameState } from "../core/game";
import { analyzeMove, explainMove } from "../core/explain";
import { pointToStr } from "../core/notation";
import { getEngine, type ThinkResult } from "../engine/EngineClient";
import type { Explanation } from "./ExplainPanel";

export const EXPLAIN_KEY = "twixt.explain.v1";

export function loadExplainFlag(): boolean {
  try { return localStorage.getItem(EXPLAIN_KEY) === "1"; } catch { return false; }
}

export function saveExplainFlag(on: boolean): void {
  try { localStorage.setItem(EXPLAIN_KEY, on ? "1" : "0"); } catch { /* ignore */ }
}

/** −1..+1 の評価値を勝率(%)に */
export const toWin = (v: number) => Math.round(((v + 1) / 2) * 100);

/**
 * 着手直後に出せる解説(盤面の事実 + 選んだ時点の評価)。
 * 着手後の局面評価(winAfter)は completeExplanation で後から埋める。
 */
export function baseExplanation(prev: GameState, r: ThinkResult, level: number, who?: string): { exp: Explanation; next: GameState } | null {
  let next: GameState;
  try { next = applyMove(prev, r.move); } catch { return null; }
  const facts = analyzeMove(prev, next);
  const base = facts
    ? explainMove(facts)
    : { headline: r.move.type === "swap" ? "初手を奪うスワップ(先手が有利と判断しました)" : "投了", bullets: [] as string[] };
  const exp: Explanation = {
    who,
    coord: facts ? facts.coord : r.move.type === "swap" ? "スワップ" : "—",
    level,
    headline: base.headline,
    bullets: base.bullets,
    winBefore: toWin(r.value),
    winAfter: null,
    sims: r.sims,
    candidates: r.candidates.slice(0, 3).map((c) => {
      const [cx, cy] = xy(c.cell);
      return { coord: pointToStr(cx, cy), p: c.p, n: c.n, q: c.q };
    }),
  };
  return { exp, next };
}

/** 着手後の局面をネットで評価して winAfter を埋めた解説を返す(失敗時は元のまま) */
export async function completeExplanation(exp: Explanation, next: GameState): Promise<Explanation> {
  if (next.result) return exp; // 終局なら評価不要
  try {
    const ev = await getEngine().evaluate(next.settings, next.moves);
    // ev.value は次の手番(相手)視点なので符号を反転して着手側視点にする
    return { ...exp, winAfter: toWin(-ev.value) };
  } catch {
    return exp;
  }
}
