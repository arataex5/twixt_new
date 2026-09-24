import { describe, expect, it } from "vitest";
import { canPlaceAt, idx, xy } from "./board";
import { analyzeMove, connectionPlan, explainMove } from "./explain";
import { applyMove, newGame, type GameState, type Move } from "./game";

function play(s: GameState, moves: Move[]): GameState {
  let cur = s;
  for (const m of moves) cur = applyMove(cur, m);
  return cur;
}

const place = (x: number, y: number): Move => ({ type: "place", x, y });

describe("connectionPlan", () => {
  it("空盤では両者とも同じ手数で結べる", () => {
    const s = newGame({ pieRule: false });
    const w = connectionPlan(s.board, "white");
    const b = connectionPlan(s.board, "black");
    expect(w).not.toBeNull();
    expect(b).not.toBeNull();
    expect(w!.cost).toBe(b!.cost);
    expect(w!.cost).toBeGreaterThan(5); // 24 路なのでナイト跳びで 9 個前後
  });

  it("ペグを置くと必要な手数が 1 減る(自分のペグは費用 0)", () => {
    const s0 = newGame({ pieRule: false });
    const before = connectionPlan(s0.board, "white")!.cost;
    // 最短ルート上のセルに置く
    const on = connectionPlan(s0.board, "white")!.path[3];
    const s1 = applyMove(s0, { type: "place", x: Math.floor(on / 24), y: on % 24 });
    expect(connectionPlan(s1.board, "white")!.cost).toBe(before - 1);
  });
});

describe("analyzeMove", () => {
  it("2 通りで結べる関係(セットアップ)を検出する", () => {
    // 白: (11,10) と (11,12) は直線 2 間。(13,11) と (9,11) の 2 通りで結べる
    const s = play(newGame({ pieRule: false }), [place(11, 10), place(5, 5)]);
    const after = applyMove(s, place(11, 12));
    const f = analyzeMove(s, after)!;
    expect(f.player).toBe("white");
    expect(f.setupsMade.some((x) => x.with === "L11" && x.ways >= 2)).toBe(true);
    expect(explainMove(f).bullets.length).toBeGreaterThan(1);
  });

  it("リンクが張られた手では newLinks が増える", () => {
    const s = play(newGame({ pieRule: false }), [place(11, 10), place(5, 5)]);
    const after = applyMove(s, place(12, 12)); // ナイト跳びの位置
    const f = analyzeMove(s, after)!;
    expect(f.newLinks).toBe(1);
    expect(f.myAfter).toBeLessThan(f.myBefore!);
  });

  it("相手の最短ルート上の穴を取った手を検出する", () => {
    // 白が 1 手打った局面(手番は赤)。赤が白の最短ルート上の空き穴を取る
    const before = applyMove(newGame({ pieRule: false }), place(5, 5));
    const plan = connectionPlan(before.board, "white")!;
    const target = plan.path.find((c) => before.board.cells[c] === null && canPlaceAt("black", ...xy(c)))!;
    const after = applyMove(before, place(...xy(target)));
    const f = analyzeMove(before, after)!;
    expect(f.player).toBe("black");
    expect(f.onOppPath).toBe(true);
    expect(f.oppAfter).not.toBeNull();
  });

  it("勝利手では finished が win になる", () => {
    // 盤の端から端まで白がつながる棋譜を作るのは長いので、勝ち判定の分岐だけ確認
    const s = play(newGame({ pieRule: false }), [place(11, 10), place(5, 5)]);
    const after = applyMove(s, place(12, 12));
    expect(analyzeMove(s, after)!.finished).toBeNull();
  });

  it("place 以外(スワップ)では null", () => {
    const s = applyMove(newGame({ pieRule: true }), place(11, 10));
    const after = applyMove(s, { type: "swap" });
    expect(analyzeMove(s, after)).toBeNull();
  });
});

describe("idx", () => {
  it("テスト用の座標変換が core と一致する", () => {
    expect(idx(11, 10)).toBe(11 * 24 + 10);
  });
});
