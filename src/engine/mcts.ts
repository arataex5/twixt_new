// PUCT 型 MCTS。twixtbot-ui の nnmcts.py を TypeScript に移植したもの。
// 評価はニューラルネット(value + policy)のみで、ランダムロールアウトは行わない。
import { xy } from "../core/board";
import { applyMove, type GameState, type Move } from "../core/game";
import { POLICY_SIZE, policyIndexToCell } from "./features";
import type { Net } from "./net";

export class Node {
  N = new Float32Array(POLICY_SIZE);
  Q = new Float32Array(POLICY_SIZE);
  P = new Float32Array(POLICY_SIZE);
  /** 合法手(証明済みの負け手は 0 に落とす) */
  LM = new Uint8Array(POLICY_SIZE);
  legalIdx: number[] = [];
  children: (Node | null)[] = new Array(POLICY_SIZE).fill(null);
  proven = false;
  /** 手番側から見た評価 −1..+1(proven なら確定値) */
  score = 0;
  winningMove: number | null = null;
  drawingMove: number | null = null;
  transposed = false;
}

export interface MctsOptions {
  cpuct?: number;
  /** ルートで「最多訪問手が確定したら打ち切る」(smart accept) */
  smartRoot?: boolean;
  onProgress?: (done: number, total: number) => void;
  isCancelled?: () => boolean;
  /** 時間制(ms)。指定時は sims は上限扱い */
  timeMs?: number;
  /** 時間制のとき、時間切れでもこの回数までは読む */
  minSims?: number;
}

export interface MctsResult {
  move: Move;
  /** ルートの評価(手番側) */
  value: number;
  /** 訪問数上位の候補 */
  candidates: { cell: number; p: number; n: number; q: number }[];
  sims: number;
  proven: boolean;
}

export class Mcts {
  private cpuct: number;
  private net: Net;
  private opts: MctsOptions;
  constructor(net: Net, opts: MctsOptions = {}) {
    this.net = net;
    this.opts = opts;
    this.cpuct = opts.cpuct ?? 1.0;
  }

  private async expand(state: GameState): Promise<Node> {
    const leaf = new Node();
    if (state.result) {
      leaf.proven = true;
      // state.result は「直前に指した側が勝った/引き分け」。手番側から見ると負け or 0
      leaf.score = state.result.winner === "draw" ? 0 : -1;
      return leaf;
    }
    const ev = await this.net.evaluate(state.board, state.toMove, true);
    leaf.transposed = ev.transposed;
    leaf.score = ev.value;
    let any = false;
    for (let i = 0; i < POLICY_SIZE; i++) {
      if (ev.legal[i]) { leaf.LM[i] = 1; leaf.legalIdx.push(i); any = true; }
      leaf.P[i] = ev.policy[i];
    }
    if (!any) { leaf.proven = true; leaf.score = 0; }
    return leaf;
  }

  private moveOf(node: Node, index: number): Move {
    const [x, y] = xy(policyIndexToCell(index, node.transposed));
    return { type: "place", x, y };
  }

  private select(node: Node, top: boolean, remaining: number): number {
    let nsum = 0;
    for (const i of node.legalIdx) nsum += node.N[i];
    const stv = Math.sqrt(nsum + 1);
    let best = -Infinity, bi = -1;
    let candidates = node.legalIdx;
    if (top && this.opts.smartRoot) {
      // 残り試行数で最多訪問を逆転できる手だけを候補にする
      let maxn = 0;
      for (const i of node.legalIdx) if (node.N[i] > maxn) maxn = node.N[i];
      const winnable = node.legalIdx.filter((i) => node.N[i] > maxn - remaining);
      if (winnable.length === 1) return winnable[0];
      candidates = winnable;
    }
    for (const i of candidates) {
      if (!node.LM[i]) continue;
      const u = node.Q[i] + this.cpuct * node.P[i] * stv / (1 + node.N[i]);
      if (u > best) { best = u; bi = i; }
    }
    return bi;
  }

  private async visit(state: GameState, node: Node, top: boolean, remaining: number): Promise<number> {
    if (node.legalIdx.every((i) => !node.LM[i])) {
      // 全ての手が証明済み(負け) or 引き分け手のみ
      node.proven = true;
      node.score = node.drawingMove !== null ? 0 : -1;
      return node.score;
    }
    const index = this.select(node, top, remaining);
    if (index < 0) { node.proven = true; node.score = -1; return -1; }
    const move = this.moveOf(node, index);
    const next = applyMove(state, move);
    let child = node.children[index];
    let sub: number;
    if (child) {
      sub = -(await this.visit(next, child, false, remaining));
    } else {
      child = await this.expand(next);
      node.children[index] = child;
      sub = -child.score;
    }
    node.N[index] += 1;
    if (child.proven) {
      node.Q[index] = sub;
      node.LM[index] = 0; // この手はもう探索しない(確定)
      if (sub === 1) { node.proven = true; node.winningMove = index; node.score = 1; }
      else if (sub === 0) node.drawingMove = index;
    } else {
      node.Q[index] += (sub - node.Q[index]) / node.N[index];
    }
    return sub;
  }

  async run(state: GameState, sims: number): Promise<MctsResult> {
    const root = await this.expand(state);
    const t0 = performance.now();
    const timeMs = this.opts.timeMs;
    const total = timeMs ? Infinity : sims;
    let done = 0;
    while (!root.proven && done < total) {
      // Worker のメッセージ(キャンセル等)を処理できるよう、毎回イベントループに戻る
      await new Promise<void>((r) => setTimeout(r, 0));
      if (timeMs && performance.now() - t0 > timeMs && done >= (this.opts.minSims ?? 0)) break;
      if (this.opts.isCancelled?.()) break;
      await this.visit(state, root, true, timeMs ? Math.max(1, Math.floor((sims || 1e9) - done)) : sims - done);
      done++;
      if (done % 5 === 0) this.opts.onProgress?.(done, timeMs ? -1 : sims);
      // smart accept: 最多訪問手が 2 位を残り試行数以上引き離したら終了(時間制でも)
      if (this.opts.smartRoot && !timeMs) {
        let n1 = 0, n2 = 0;
        for (const i of root.legalIdx) { const n = root.N[i]; if (n > n1) { n2 = n1; n1 = n; } else if (n > n2) n2 = n; }
        if (n1 - n2 > sims - done) break;
      }
    }

    // 確定した結果
    if (root.proven) {
      if (root.winningMove !== null) {
        return { move: this.moveOf(root, root.winningMove), value: 1, candidates: [{ cell: policyIndexToCell(root.winningMove, root.transposed), p: 1, n: root.N[root.winningMove], q: 1 }], sims: done, proven: true };
      }
      if (root.drawingMove !== null) {
        return { move: this.moveOf(root, root.drawingMove), value: 0, candidates: [], sims: done, proven: true };
      }
      // 全部負け: 最も粘れる手(訪問数最大)を打つ。訪問が無ければ Policy 最大
      const idx = argmax(root.N, root.legalIdx) ?? argmax(root.P, root.legalIdx) ?? 0;
      return { move: this.moveOf(root, idx), value: -1, candidates: [], sims: done, proven: true };
    }

    // 最多訪問手(同数なら Q が高い方)
    let bi = -1, bn = -1, bq = -Infinity;
    for (const i of root.legalIdx) {
      const n = root.N[i];
      if (n > bn || (n === bn && root.Q[i] > bq)) { bn = n; bi = i; bq = root.Q[i]; }
    }
    if (bi < 0 || bn === 0) bi = argmax(root.P, root.legalIdx) ?? 0;
    const order = root.legalIdx.filter((i) => root.N[i] > 0).sort((a, b) => root.N[b] - root.N[a]).slice(0, 10);
    const candidates = order.map((i) => ({ cell: policyIndexToCell(i, root.transposed), p: root.N[i] / Math.max(1, done), n: root.N[i], q: root.Q[i] }));
    const value = bn > 0 ? root.Q[bi] : root.score;
    return { move: this.moveOf(root, bi), value, candidates, sims: done, proven: false };
  }
}

function argmax(arr: Float32Array, idxs: number[]): number | null {
  let bi: number | null = null, bv = -Infinity;
  for (const i of idxs) if (arr[i] > bv) { bv = arr[i]; bi = i; }
  return bi;
}
