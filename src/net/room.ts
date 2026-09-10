// ルーム(オンライン対戦)の作成・参加・同期。データモデルは TWIXT_アプリ構成設計.md 7.3 を参照。
import {
  child, get, onDisconnect, onValue, ref, runTransaction, serverTimestamp, set, update, type Unsubscribe,
} from "firebase/database";
import type { Player } from "../core/board";
import { applyMove, replay, type GameSettings, type Move, type Result } from "../core/game";
import { moveToStr, strToMoves } from "../core/notation";
import { ensureSignedIn as fbSignIn, getDb } from "./firebase";
import { mockGet, mockSet, mockSubscribe, mockTransaction, mockUid } from "./mockBackend";

const MOCK = typeof location !== "undefined" && new URLSearchParams(location.search).get("mock") === "1";

export async function ensureSignedIn(): Promise<string> {
  return MOCK ? mockUid() : fbSignIn();
}

export interface RoomData {
  createdAt: number;
  expiresAt: number;
  settings: GameSettings;
  players: { white: string | null; black: string | null };
  status: "waiting" | "playing" | "finished";
  /** 棋譜(空白区切り)。配列より文字列の方がトランザクションが単純 */
  moves: string;
  result: Result;
  presence?: Record<string, { online: boolean; lastSeen: number }>;
}

export interface RoomView {
  code: string;
  data: RoomData;
  myUid: string;
  myColor: Player | null;
  opponentOnline: boolean;
}

const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
// 紛らわしい文字(0/O, 1/I)を除いた英数字
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function randomCode(len = 6): string {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

export function normalizeCode(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/O/g, "0").replace(/I/g, "1");
}

function roomRef(code: string) {
  return ref(getDb(), `rooms/${code}`);
}

/** ルームを作る。hostColor は作成者の色("random" 可) */
export async function createRoom(settings: GameSettings, hostColor: Player | "random"): Promise<{ code: string; myColor: Player }> {
  const uid = await ensureSignedIn();
  const myColor: Player = hostColor === "random" ? (Math.random() < 0.5 ? "white" : "black") : hostColor;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    if (MOCK) {
      if (mockGet(code)) continue;
    } else if ((await get(roomRef(code))).exists()) continue;
    const now = Date.now();
    const data: RoomData = {
      createdAt: now,
      expiresAt: now + ROOM_TTL_MS,
      settings,
      players: { white: myColor === "white" ? uid : null, black: myColor === "black" ? uid : null },
      status: "waiting",
      moves: "",
      result: null,
    };
    if (MOCK) mockSet(code, data); else await set(roomRef(code), data);
    return { code, myColor };
  }
  throw new Error("ルームコードの生成に失敗しました");
}

/** ルームに参加する。空いている色に入る。既に参加済みならその色を返す */
export async function joinRoom(codeRaw: string): Promise<{ code: string; myColor: Player }> {
  const uid = await ensureSignedIn();
  const code = normalizeCode(codeRaw);
  if (code.length !== 6) throw new Error("ルームコードは 6 文字です");
  let myColor: Player | null = null;
  const joinFn = (cur: RoomData | null) => {
    if (cur === null) return cur; // 存在しない → abort 扱いにするため undefined ではなく null を返す
    if (cur.players.white === uid) { myColor = "white"; return cur; }
    if (cur.players.black === uid) { myColor = "black"; return cur; }
    if (cur.status !== "waiting") return; // 満員
    if (cur.players.white === null) { myColor = "white"; cur.players.white = uid; }
    else if (cur.players.black === null) { myColor = "black"; cur.players.black = uid; }
    else return;
    cur.status = "playing";
    return cur;
  };
  if (MOCK) {
    const r = mockTransaction(code, joinFn);
    if (!r.committed || !r.data) throw new Error("ルームが見つからないか、満員です");
  } else {
    const res = await runTransaction(roomRef(code), joinFn);
    if (!res.committed || !res.snapshot.exists()) throw new Error("ルームが見つからないか、満員です");
  }
  if (!myColor) throw new Error("ルームは満員です");
  return { code, myColor };
}

/** ルームを購読。接続状態も更新する */
export function subscribeRoom(code: string, uid: string, cb: (view: RoomView | null) => void): Unsubscribe {
  const toView = (data: RoomData | null): RoomView | null => {
    if (!data) return null;
    const myColor: Player | null = data.players?.white === uid ? "white" : data.players?.black === uid ? "black" : null;
    const oppUid = myColor === "white" ? data.players?.black : myColor === "black" ? data.players?.white : null;
    const opponentOnline = !!(oppUid && data.presence?.[oppUid]?.online);
    return { code, data: { ...data, moves: data.moves ?? "" }, myUid: uid, myColor, opponentOnline };
  };
  if (MOCK) {
    mockTransaction(code, (cur) => { if (!cur) return; cur.presence = { ...(cur.presence ?? {}), [uid]: { online: true, lastSeen: Date.now() } }; return cur; });
    const unsub = mockSubscribe(code, (d) => cb(toView(d)));
    return () => { unsub(); mockTransaction(code, (cur) => { if (!cur) return; cur.presence = { ...(cur.presence ?? {}), [uid]: { online: false, lastSeen: Date.now() } }; return cur; }); };
  }
  const r = roomRef(code);
  const db = getDb();
  const me = child(r, `presence/${uid}`);

  // 接続状態: 接続中は online=true、切断時に自動で false
  const connRef = ref(db, ".info/connected");
  const unsubConn = onValue(connRef, (snap) => {
    if (snap.val() === true) {
      onDisconnect(me).set({ online: false, lastSeen: serverTimestamp() });
      set(me, { online: true, lastSeen: serverTimestamp() });
    }
  });

  const unsubRoom = onValue(r, (snap) => cb(toView(snap.val() as RoomData | null)));

  return () => {
    unsubConn();
    unsubRoom();
    set(me, { online: false, lastSeen: serverTimestamp() }).catch(() => {});
  };
}

/**
 * 着手を送る。トランザクションで「自分の手番」「手数が一致」「合法」を確認して追記する。
 * expectedIndex = 送信時点の手数(=この手が何手目になるか)
 */
export async function sendMove(code: string, uid: string, move: Move, expectedIndex: number): Promise<void> {
  let reason = "";
  const fn = (cur: RoomData | null) => {
    if (!cur) { reason = "ルームがありません"; return; }
    if (cur.status !== "playing") { reason = "対局中ではありません"; return; }
    const moves = strToMoves(cur.moves ?? "");
    if (moves.length !== expectedIndex) { reason = "手数がずれています(相手の手を受信中)"; return; }
    const state = replay(cur.settings, moves);
    const myColor: Player | null = cur.players.white === uid ? "white" : cur.players.black === uid ? "black" : null;
    if (!myColor) { reason = "参加者ではありません"; return; }
    if (move.type !== "resign" && state.toMove !== myColor) { reason = "あなたの手番ではありません"; return; }
    let next;
    try {
      next = applyMove(state, move.type === "resign" && state.toMove !== myColor ? { type: "resign" } : move);
    } catch (e) {
      reason = (e as Error).message; return;
    }
    // 投了は手番に関係なく「自分の負け」にする
    if (move.type === "resign") {
      cur.result = { winner: myColor === "white" ? "black" : "white", reason: "resign" };
      cur.status = "finished";
      cur.moves = [cur.moves, "resign"].filter(Boolean).join(" ");
      return cur;
    }
    cur.moves = [cur.moves, moveToStr(move)].filter(Boolean).join(" ");
    if (next.result) { cur.result = next.result; cur.status = "finished"; }
    return cur;
  };
  const committed = MOCK ? mockTransaction(code, fn).committed : (await runTransaction(roomRef(code), fn)).committed;
  if (!committed) throw new Error(reason || "送信に失敗しました");
}

/** ルームを離れる(待機中で自分しかいなければ削除) */
export async function leaveRoom(code: string, uid: string): Promise<void> {
  const data = MOCK ? mockGet(code) : ((await get(roomRef(code))).val() as RoomData | null);
  if (!data) return;
  const others = [data.players.white, data.players.black].filter((p) => p && p !== uid);
  if (data.status === "waiting" && others.length === 0) {
    if (MOCK) mockSet(code, null); else await set(roomRef(code), null);
  } else if (!MOCK) {
    await update(child(roomRef(code), `presence/${uid}`), { online: false, lastSeen: serverTimestamp() });
  }
}

