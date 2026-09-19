// ルームのトランザクション本体のテスト。
// 空き枠は null の場合と未設定(undefined)の場合の両方があり得る点を再現する。
import { describe, expect, it } from "vitest";
import { joinTransition, mergeRemote, moveTransition, normalizeCode, readyTransition, startTransition, type RoomData } from "./room";

const settings = { pieRule: true, rules: "standard" as const };

function room(partial: Partial<RoomData> = {}): RoomData {
  return {
    createdAt: 0, expiresAt: 0, settings,
    players: { white: "host" }, // black は未設定(undefined)
    status: "waiting", moves: "", result: null,
    ...partial,
  };
}

describe("joinTransition", () => {
  it("空き枠(キー無し)に参加できる", () => {
    const r = joinTransition(room(), "guest");
    expect(r.myColor).toBe("black");
    expect(r.next?.players).toEqual({ white: "host", black: "guest" });
    expect(r.next?.status).toBe("ready");
  });
  it("空き枠が null でも参加できる(mock 互換)", () => {
    const r = joinTransition(room({ players: { white: null, black: "host" } }), "guest");
    expect(r.myColor).toBe("white");
  });
  it("参加済みなら自分の色を返して変更しない", () => {
    const r = joinTransition(room({ players: { white: "host", black: "guest" }, status: "playing" }), "host");
    expect(r.myColor).toBe("white");
    expect(r.next?.status).toBe("playing");
  });
  it("満員なら中断(undefined)", () => {
    const r = joinTransition(room({ players: { white: "a", black: "b" }, status: "playing" }), "c");
    expect(r.next).toBeUndefined();
    expect(r.myColor).toBeNull();
  });
  it("ルームが無ければ null を返す", () => {
    expect(joinTransition(null, "x").next).toBeNull();
  });
});

describe("moveTransition", () => {
  const playing = () => room({ players: { white: "w", black: "b" }, status: "playing" });
  it("自分の手番なら追記される", () => {
    const r = moveTransition(playing(), "w", { type: "place", x: 11, y: 11 }, 0);
    expect(typeof r).toBe("object");
    expect((r as RoomData).moves).toBe("L12");
  });
  it("相手の手番なら拒否", () => {
    expect(moveTransition(playing(), "b", { type: "place", x: 11, y: 11 }, 0)).toMatch(/手番/);
  });
  it("手数がずれていたら拒否", () => {
    expect(moveTransition(playing(), "w", { type: "place", x: 11, y: 11 }, 1)).toMatch(/手数/);
  });
  it("参加者でなければ拒否", () => {
    expect(moveTransition(playing(), "zzz", { type: "place", x: 11, y: 11 }, 0)).toMatch(/参加者/);
  });
  it("投了は手番に関係なく自分の負け", () => {
    const r = moveTransition(playing(), "b", { type: "resign" }, 0) as RoomData;
    expect(r.status).toBe("finished");
    expect(r.result).toEqual({ winner: "white", reason: "resign" });
    expect(r.moves).toBe("resign");
  });
  it("スワップ後は白が続けて指す", () => {
    const r1 = moveTransition(playing(), "w", { type: "place", x: 11, y: 11 }, 0) as RoomData;
    const r2 = moveTransition(r1, "b", { type: "swap" }, 1) as RoomData;
    expect(r2.moves).toBe("L12 swap");
    const r3 = moveTransition(r2, "w", { type: "place", x: 12, y: 9 }, 2) as RoomData;
    expect(r3.moves).toBe("L12 swap M10");
  });
  it("壊れた棋譜は拒否", () => {
    expect(moveTransition(room({ players: { white: "w", black: "b" }, status: "playing", moves: "ZZ99" }), "w", { type: "place", x: 0, y: 5 }, 1)).toMatch(/壊れ/);
  });
});

describe("normalizeCode", () => {
  it("小文字・紛らわしい文字を正規化", () => {
    expect(normalizeCode(" myx-tz7 ")).toBe("MYXTZ7");
    expect(normalizeCode("O0I1ab")).toBe("0011AB");
  });
});

describe("mergeRemote(再接続時の棋譜の突き合わせ)", () => {
  const playing = (moves = "") => room({ players: { white: "w", black: "b" }, status: "playing", moves });
  it("相手の棋譜が自分の続きなら採用する", () => {
    const r = mergeRemote(playing("L12"), { moves: "L12 M14 N10" });
    expect(r.moves).toBe("L12 M14 N10");
    expect(r.status).toBe("playing");
  });
  it("自分の方が長ければ何もしない", () => {
    const cur = playing("L12 M14");
    expect(mergeRemote(cur, { moves: "L12" })).toBe(cur);
  });
  it("続きでない棋譜(分岐)は無視する", () => {
    const cur = playing("L12 M14");
    expect(mergeRemote(cur, { moves: "L12 N10 K13" })).toBe(cur);
  });
  it("壊れた棋譜は無視する", () => {
    const cur = playing("L12");
    expect(mergeRemote(cur, { moves: "L12 ZZ99" })).toBe(cur);
  });
  it("投了で終わっていれば結果を引き継ぐ", () => {
    const r = mergeRemote(playing("L12"), { moves: "L12 resign", result: { winner: "white", reason: "resign" } });
    expect(r.status).toBe("finished");
    expect(r.result).toEqual({ winner: "white", reason: "resign" });
  });
  it("待機中のホストが再接続したゲストの棋譜を受け取ると対局中になる", () => {
    const r = mergeRemote(room({ players: { white: "w", black: "b" }, status: "waiting" }), { moves: "L12" });
    expect(r.status).toBe("playing");
  });
});

describe("readyTransition / startTransition", () => {
  const ready = () => room({ host: "w", players: { white: "w", black: "b" }, status: "ready", ready: {} });
  it("ゲストの準備完了だけでは始まらない", () => {
    const r = readyTransition(ready(), "b", true) as RoomData;
    expect(r.status).toBe("ready");
    expect(r.ready).toEqual({ black: true });
  });
  it("相手が未完了だとホストは開始できない", () => {
    expect(startTransition(ready(), "w")).toMatch(/準備完了/);
  });
  it("相手が準備完了ならホストが開始できる", () => {
    const r1 = readyTransition(ready(), "b", true) as RoomData;
    const r2 = startTransition(r1, "w") as RoomData;
    expect(r2.status).toBe("playing");
  });
  it("ゲストは開始できない", () => {
    const r1 = readyTransition(ready(), "b", true) as RoomData;
    expect(startTransition(r1, "b")).toMatch(/ホスト/);
  });
  it("取り消しできる", () => {
    const r1 = readyTransition(ready(), "b", true) as RoomData;
    const r2 = readyTransition(r1, "b", false) as RoomData;
    expect(r2.ready).toEqual({ black: false });
  });
  it("相手未入室なら拒否", () => {
    expect(readyTransition(room(), "host", true)).toMatch(/入室/);
  });
});
