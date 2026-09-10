// Node 上で ONNX Runtime Web(wasm)を動かし、MCTS の基本動作を確認する
import { describe, expect, it } from "vitest";
import { replay } from "../core/game";
import { strToMoves } from "../core/notation";
import { pointToStr } from "../core/notation";
import { xy } from "../core/board";
import { Mcts } from "./mcts";
import { Net } from "./net";

import { readFileSync } from "node:fs";

const baseUrl = `file://${process.cwd()}/public/`;
const modelBytes = new Uint8Array(readFileSync(`${process.cwd()}/public/models/twixtbot.onnx`));

describe("mcts (requires model)", () => {
  it("1 手で勝てる局面で勝ち手を見つける(proven)", async () => {
    const net = new Net();
    await net.load(baseUrl, modelBytes);
    // 白: F1 G3 H5 I7 J9 K11 L13 M15 N17 O19 P21 が縦につながり、あと Q23(x=16,y=22)→R24?
    // 簡単に: 白の鎖 (5,0)(6,2)...(15,20)(16,22) まで作り、最後 (18,23) で勝ち。
    const white: [number, number][] = [];
    for (let k = 0; k <= 11; k++) white.push([5 + k, 2 * k]);
    const moves: string[] = [];
    white.forEach(([x, y], i) => { moves.push(pointToStr(x, y)); moves.push(pointToStr(1, 1 + i)); });
    const state = replay({ pieRule: false }, strToMoves(moves.join(" ")));
    expect(state.toMove).toBe("white");
    const mcts = new Mcts(net, { smartRoot: true });
    const r = await mcts.run(state, 60);
    expect(r.move.type).toBe("place");
    if (r.move.type === "place") {
      // (18,23) または (14,23)... (16,22) からのナイト跳びで y=23 は (18,23),(14,23)
      const winning = [[18, 23], [14, 23]].map(([x, y]) => pointToStr(x, y));
      expect(winning).toContain(pointToStr(r.move.x, r.move.y));
    }
    expect(r.proven).toBe(true);
    expect(r.value).toBe(1);
  }, 120000);

  it("敗勢の局面では評価が大きく負になる", async () => {
    const net = new Net();
    await net.load(baseUrl, modelBytes);
    // 白が (16,22) まで鎖を作った直後の黒番。黒は y=23 行に置けないので防げない(必敗)
    const white: [number, number][] = [];
    for (let k = 0; k <= 11; k++) white.push([5 + k, 2 * k]);
    const moves: string[] = [];
    white.forEach(([x, y], i) => { moves.push(pointToStr(x, y)); if (i < white.length - 1) moves.push(pointToStr(1, 1 + i)); });
    const state = replay({ pieRule: false }, strToMoves(moves.join(" ")));
    expect(state.toMove).toBe("black");
    const mcts = new Mcts(net, { smartRoot: true });
    const r = await mcts.run(state, 40);
    expect(r.move.type).toBe("place");
    expect(r.value).toBeLessThan(-0.5);
    void xy;
  }, 120000);

  it("時間制でも minSims 回までは読む(Lv6 の下限)", async () => {
    const net = new Net();
    await net.load(baseUrl, modelBytes);
    const state = replay({ pieRule: false }, strToMoves("L12 M13"));
    // 時間 1ms なら通常は数回で打ち切られるが、minSims=15 で最低 15 回読む
    const r = await mcts_(net, { smartRoot: true, timeMs: 1, minSims: 15 }).run(state, 100000);
    expect(r.sims).toBeGreaterThanOrEqual(15);
    const r2 = await mcts_(net, { smartRoot: true, timeMs: 1 }).run(state, 100000);
    expect(r2.sims).toBeLessThan(15);
  }, 120000);
});

function mcts_(net: Net, opts: ConstructorParameters<typeof Mcts>[1]) { return new Mcts(net, opts); }
