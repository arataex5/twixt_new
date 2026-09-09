// ONNX Runtime Web で twixtbot モデルを推論する(Worker 内で使う)
import * as ort from "onnxruntime-web/wasm";
import { SIZE, idx, linkEnds, linkId, xy, type Player } from "../core/board";
import type { Board } from "../core/game";
import { POLICY_SIZE, cellToPolicyIndex, encode, legalMask, policyIndexToCell, threeToValue } from "./features";

export interface Evaluation {
  /** 手番側から見た評価 −1..+1 */
  value: number;
  /** 合法手で正規化した確率(policy index 順、非合法は 0) */
  policy: Float32Array;
  transposed: boolean;
  legal: Uint8Array;
}

export class Net {
  private session: ort.InferenceSession | null = null;
  evalCount = 0;
  evalMs = 0;

  async load(baseUrl: string, modelBytes?: Uint8Array): Promise<void> {
    ort.env.wasm.wasmPaths = `${baseUrl}ort/`;
    // COOP/COEP が無い環境(GitHub Pages, Capacitor)では SharedArrayBuffer が使えないので 1 スレッド
    const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
    ort.env.wasm.numThreads = isolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    this.session = modelBytes
      ? await ort.InferenceSession.create(modelBytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" })
      : await ort.InferenceSession.create(`${baseUrl}models/twixtbot.onnx`, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
  }

  get ready(): boolean {
    return this.session !== null;
  }

  /**
   * 局面を評価する。randomFlip=true なら左右/上下反転をランダムに掛けて評価し結果を戻す
   * (どちらの反転も両プレイヤーの辺行を保つので対称)。同一局面で毎回同じ手を打たない効果もある。
   */
  async evaluate(board: Board, toMove: Player, randomFlip = true): Promise<Evaluation> {
    if (!this.session) throw new Error("net not loaded");
    const h = randomFlip && Math.random() < 0.5;
    const v = randomFlip && Math.random() < 0.5;
    const b2 = h || v ? mirrorBoard(board, h, v) : board;
    const inp = encode(b2, toMove);

    const t0 = performance.now();
    const out = await this.session.run({
      "pegx:0": new ort.Tensor("float32", inp.pegs, [1, SIZE, SIZE, 2]),
      "linkx:0": new ort.Tensor("float32", inp.links, [1, SIZE, SIZE, 8]),
      "locx:0": new ort.Tensor("float32", inp.locs, [1, SIZE, SIZE, 2]),
    });
    this.evalMs += performance.now() - t0;
    this.evalCount++;

    const pw = out["pwin:0"].data as Float32Array;
    const logits2 = out["movelogits:0"].data as Float32Array;

    // 反転した盤の policy index → 元の盤の policy index
    const t = inp.transposed;
    const logits = new Float32Array(POLICY_SIZE);
    for (let i = 0; i < POLICY_SIZE; i++) {
      const cell2 = policyIndexToCell(i, t);
      const cell = h || v ? mirrorCell(cell2, h, v) : cell2;
      const j = cellToPolicyIndex(cell, t);
      if (j >= 0) logits[j] = logits2[i];
    }

    const legal = legalMask(board, toMove);
    const policy = new Float32Array(POLICY_SIZE);
    let max = -Infinity;
    for (let i = 0; i < POLICY_SIZE; i++) if (legal[i] && logits[i] > max) max = logits[i];
    let sum = 0;
    for (let i = 0; i < POLICY_SIZE; i++) {
      if (!legal[i]) continue;
      const e = Math.exp(logits[i] - max);
      policy[i] = e;
      sum += e;
    }
    if (sum > 0) for (let i = 0; i < POLICY_SIZE; i++) policy[i] /= sum;

    return { value: threeToValue(pw[0], pw[1], pw[2]), policy, transposed: t, legal };
  }
}

export function mirrorCell(cell: number, h: boolean, v: boolean): number {
  const [x, y] = xy(cell);
  return idx(h ? SIZE - 1 - x : x, v ? SIZE - 1 - y : y);
}

export function mirrorBoard(board: Board, h: boolean, v: boolean): Board {
  const cells = new Array<Player | null>(board.cells.length).fill(null);
  for (let c = 0; c < board.cells.length; c++) {
    const o = board.cells[c];
    if (o !== null) cells[mirrorCell(c, h, v)] = o;
  }
  const links = new Map<number, Player>();
  for (const [id, o] of board.links) {
    const [a, b] = linkEnds(id);
    links.set(linkId(mirrorCell(a, h, v), mirrorCell(b, h, v)), o);
  }
  return { cells, links };
}
