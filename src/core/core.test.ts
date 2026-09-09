import { describe, expect, it } from "vitest";
import { SIZE, canPlaceAt, idx, linkId } from "./board";
import { allLinkIds, crossingCandidates } from "./links";
import { applyMove, hasWon, newGame, replay, type Move } from "./game";
import { movesToStr, strToMoves } from "./notation";

const P = (x: number, y: number): Move => ({ type: "place", x, y });

describe("board", () => {
  it("辺行・四隅の制限", () => {
    expect(canPlaceAt("white", 0, 5)).toBe(false); // 左列は黒の辺行
    expect(canPlaceAt("white", 5, 0)).toBe(true); // 上行は白の辺行
    expect(canPlaceAt("black", 5, 0)).toBe(false);
    expect(canPlaceAt("black", 0, 5)).toBe(true);
    expect(canPlaceAt("white", 0, 0)).toBe(false);
    expect(canPlaceAt("black", SIZE - 1, SIZE - 1)).toBe(false);
  });
});

describe("links / crossing table", () => {
  it("リンク総数と交差候補数の上限", () => {
    const ids = allLinkIds();
    // 24x24 のナイト跳び: 4方向ペアの数 = 22*23*2 + 23*22*2 = 2024
    expect(ids.length).toBe(2024);
    let max = 0;
    for (const id of ids) max = Math.max(max, crossingCandidates(id).length);
    expect(max).toBe(9);
  });
  it("交差関係は対称", () => {
    for (const id of allLinkIds()) {
      for (const c of crossingCandidates(id)) expect(crossingCandidates(c)).toContain(id);
    }
  });
  it("端点を共有するリンクは交差しない", () => {
    const a = linkId(idx(5, 5), idx(6, 7));
    const b = linkId(idx(5, 5), idx(7, 6));
    expect(crossingCandidates(a)).not.toContain(b);
  });
});

describe("game", () => {
  it("ナイト跳びで自動リンク、相手ペグとは結ばない", () => {
    let s = newGame({ pieRule: false });
    s = applyMove(s, P(5, 5));
    s = applyMove(s, P(10, 10));
    s = applyMove(s, P(6, 7));
    expect(s.board.links.get(linkId(idx(5, 5), idx(6, 7)))).toBe("white");
    expect(s.board.links.size).toBe(1);
    s = applyMove(s, P(11, 12));
    expect(s.board.links.get(linkId(idx(10, 10), idx(11, 12)))).toBe("black");
  });

  it("相手リンクと交差するリンクは張られない", () => {
    let s = newGame({ pieRule: false });
    // 白 (5,5)-(6,7) を先に張る。黒 (4,6)-(6,6)... ナイト跳びではないので (5,7)-(7,6)? を試す
    s = applyMove(s, P(5, 5));
    s = applyMove(s, P(4, 7)); // 黒
    s = applyMove(s, P(6, 7)); // 白: (5,5)-(6,7) リンク
    // 黒 (4,7)-(6,6): 線分 (4,7)-(6,6) は (5,5)-(6,7) と交差する
    s = applyMove(s, P(6, 6));
    expect(s.board.links.has(linkId(idx(4, 7), idx(6, 6)))).toBe(false);
    expect(s.board.links.size).toBe(1);
  });

  it("standard では自リンク同士も交差不可、pp では可", () => {
    const seq: Move[] = [P(5, 5), P(20, 20), P(6, 7), P(20, 21), P(4, 7), P(20, 22), P(6, 6)];
    // 白: (5,5)-(6,7) を張り、その後 (4,7) と (6,6) を置く → (4,7)-(6,6) は交差
    const std = replay({ pieRule: false, rules: "standard" }, seq);
    expect(std.board.links.has(linkId(idx(4, 7), idx(6, 6)))).toBe(false);
    const pp = replay({ pieRule: false, rules: "pp" }, seq);
    expect(pp.board.links.has(linkId(idx(4, 7), idx(6, 6)))).toBe(true);
  });

  it("standard では自リンクを外して置ける", () => {
    const seq: Move[] = [P(5, 5), P(20, 20), P(6, 7), P(20, 21), P(4, 7), P(20, 22)];
    let s = replay({ pieRule: false }, seq);
    const blocking = linkId(idx(5, 5), idx(6, 7));
    s = applyMove(s, { type: "place", x: 6, y: 6, removeLinks: [blocking] });
    expect(s.board.links.has(blocking)).toBe(false);
    expect(s.board.links.has(linkId(idx(4, 7), idx(6, 6)))).toBe(true);
    // (6,6)-(5,... ) など他のリンクは既存ペグと結ばれる: (6,6)-(5,... ) は (5,8)? 無い。OK
  });

  it("スワップ: 主対角線で鏡映して黒の駒になり、白の手番", () => {
    let s = newGame({ pieRule: true });
    s = applyMove(s, P(5, 10));
    expect(s.canSwap).toBe(true);
    s = applyMove(s, { type: "swap" });
    expect(s.board.cells[idx(5, 10)]).toBe(null);
    expect(s.board.cells[idx(10, 5)]).toBe("black");
    expect(s.toMove).toBe("white");
    expect(s.canSwap).toBe(false);
  });

  it("パイルール OFF ではスワップ不可", () => {
    let s = newGame({ pieRule: false });
    s = applyMove(s, P(5, 10));
    expect(s.canSwap).toBe(false);
    expect(() => applyMove(s, { type: "swap" })).toThrow();
  });

  it("白が上下を結ぶと勝ち", () => {
    // 白: (5,0) → (6,2) → (7,4) ... y を 2 ずつ x を 1 ずつ。y=22 まで 11 リンク、最後 (16,22)→(17,24)? 範囲外。
    // 代わりに (5,0),(6,2),...,(15,20),(16,22),(17,23)? (16,22)->(17,23) はナイトではない。(16,22)->(15,23)? dx=-1,dy=1 違う。
    // (16,22)->(18,23) dx=2,dy=1 OK。
    const white: [number, number][] = [];
    for (let k = 0; k <= 11; k++) white.push([5 + k, 2 * k]);
    white.push([18, 23]);
    const moves: Move[] = [];
    white.forEach(([x, y], i) => {
      moves.push(P(x, y));
      if (i < white.length - 1) moves.push(P(1, 1 + i)); // 黒はどこか無関係な場所
    });
    const s = replay({ pieRule: false }, moves);
    expect(hasWon(s.board, "white")).toBe(true);
    expect(s.result).toEqual({ winner: "white", reason: "connect" });
    expect(() => applyMove(s, P(2, 2))).toThrow();
  });

  it("投了", () => {
    let s = newGame();
    s = applyMove(s, P(5, 5));
    s = applyMove(s, { type: "resign" });
    expect(s.result).toEqual({ winner: "white", reason: "resign" });
  });

  it("相手の辺行には置けない", () => {
    const s = newGame();
    expect(() => applyMove(s, P(0, 5))).toThrow();
  });
});

describe("notation", () => {
  it("往復変換", () => {
    const moves: Move[] = [P(5, 11), { type: "swap" }, P(0, 3), { type: "resign" }];
    const str = movesToStr(moves);
    expect(str).toBe("F12 swap A4 resign");
    expect(strToMoves(str)).toEqual(moves);
  });
});
