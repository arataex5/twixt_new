// ルーム(オンライン対戦)の作成・参加・同期。PeerJS(WebRTC P2P)版。
//
// 構成:
//   - ホストの Peer ID = "twixt-<ルームコード>"。ゲストはコードだけでホストにつながる。
//   - ホストが審判役。ゲストの手はホストに送られ、ホストが合法性を確認して両者に配る。
//   - 両者とも対局状態(RoomData)を localStorage に保存する。切断後・アプリ再起動後も
//     同じコードで再接続でき、接続時に棋譜を突き合わせて長い方から再開する。
//   - サーバーは PeerJS 公式の無料シグナリング(0.peerjs.com)を借りるだけ。手を預かる場所は無いので、
//     再開には両方が同時にアプリを開いている必要がある。
//   - ?mock=1 で PeerJS を使わず同一ブラウザ内の複数タブで検証できる(mockBackend.ts)。
import { Peer, type DataConnection } from "peerjs";
import type { Player } from "../core/board";
import { applyMove, replay, type GameSettings, type Move, type Result } from "../core/game";
import { moveToStr, strToMoves } from "../core/notation";
import { mockGet, mockSet, mockSubscribe, mockTransaction, mockUid } from "./mockBackend";

const MOCK = typeof location !== "undefined" && new URLSearchParams(location.search).get("mock") === "1";

export interface RoomData {
  createdAt: number;
  expiresAt: number;
  settings: GameSettings;
  /** ルームを作った側の uid(設定を変更できる人) */
  host?: string;
  /** 空き枠は null または未設定(undefined)。判定は == null で行う */
  players: { white?: string | null; black?: string | null };
  /** waiting: 相手待ち / ready: 両者入室・準備確認中 / playing / finished */
  status: "waiting" | "ready" | "playing" | "finished";
  /** 準備完了フラグ(ready 中のみ意味を持つ) */
  ready?: { white?: boolean; black?: boolean };
  /** 引き分け提案中の側(対局中のみ)。着手があると消える */
  drawOffer?: Player | null;
  /** 棋譜(空白区切り) */
  moves: string;
  result: Result;
}

export interface RoomView {
  code: string;
  data: RoomData;
  myUid: string;
  myColor: Player | null;
  opponentOnline: boolean;
  /** ルームを作った側の uid */
  hostUid: string | null;
}

const ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// 紛らわしい文字(0/O, 1/I)を除いた英数字
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const UID_KEY = "twixt.peer.uid";
const ROOM_KEY = (code: string) => `twixt.peer.room.${code}`;
const PEER_PREFIX = "twixt-";
const RECONNECT_MS = 3000;
const JOIN_TIMEOUT_MS = 15000;
const ACK_TIMEOUT_MS = 10000;

export function randomCode(len = 6): string {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

export function normalizeCode(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/O/g, "0").replace(/I/g, "1");
}

/** 端末ごとの ID(初回に生成して保存)。ログインは不要 */
export async function ensureSignedIn(): Promise<string> {
  if (MOCK) return mockUid();
  try {
    let uid = localStorage.getItem(UID_KEY);
    if (!uid) { uid = "u" + randomCode(10).toLowerCase(); localStorage.setItem(UID_KEY, uid); }
    return uid;
  } catch {
    return "u" + randomCode(10).toLowerCase();
  }
}

// ---------------------------------------------------------------------------
// 純粋な状態遷移(テスト対象)
// ---------------------------------------------------------------------------

/**
 * 参加。戻り値: next = undefined なら満員などで中断、null ならルーム無し。
 */
export function joinTransition(cur: RoomData | null, uid: string): { next: RoomData | null | undefined; myColor: Player | null } {
  if (cur === null) return { next: null, myColor: null };
  const players = cur.players ?? {};
  if (players.white === uid) return { next: cur, myColor: "white" };
  if (players.black === uid) return { next: cur, myColor: "black" };
  if (cur.status !== "waiting") return { next: undefined, myColor: null };
  let myColor: Player;
  if (players.white == null) { myColor = "white"; players.white = uid; }
  else if (players.black == null) { myColor = "black"; players.black = uid; }
  else return { next: undefined, myColor: null };
  cur.players = players;
  cur.status = "ready";
  cur.ready = {};
  return { next: cur, myColor };
}

/** 着手。戻り値: 文字列 = 拒否理由。RoomData = 新しいルーム */
export function moveTransition(cur: RoomData, uid: string, move: Move, expectedIndex: number): RoomData | string {
  if (cur.status !== "playing") return "対局中ではありません";
  const players = cur.players ?? {};
  const myColor: Player | null = players.white === uid ? "white" : players.black === uid ? "black" : null;
  if (!myColor) return "参加者ではありません";
  let state;
  try {
    const moves = strToMoves(cur.moves ?? "");
    if (moves.length !== expectedIndex) return "手数がずれています(相手の手を受信中)";
    state = replay(cur.settings, moves);
  } catch (e) {
    return `棋譜が壊れています: ${(e as Error).message}`;
  }
  // 投了は手番に関係なく「自分の負け」にする
  if (move.type === "resign") {
    cur.result = { winner: myColor === "white" ? "black" : "white", reason: "resign" };
    cur.status = "finished";
    cur.moves = [cur.moves, "resign"].filter(Boolean).join(" ");
    return cur;
  }
  if (state.toMove !== myColor) return "あなたの手番ではありません";
  let next;
  try {
    next = applyMove(state, move);
  } catch (e) {
    return (e as Error).message;
  }
  cur.moves = [cur.moves, moveToStr(move)].filter(Boolean).join(" ");
  cur.drawOffer = null; // 着手で引き分け提案は流れる
  if (next.result) { cur.result = next.result; cur.status = "finished"; }
  return cur;
}

/**
 * 再接続時の棋譜の突き合わせ。相手の棋譜が自分の続き(自分の棋譜を前置に持つ)で、かつ再生できるなら採用する。
 * 戻り値: 採用後の RoomData(変更が無ければ cur をそのまま返す)
 */
export function mergeRemote(cur: RoomData, remote: { moves?: string; result?: Result; status?: RoomData["status"] } | null | undefined): RoomData {
  if (!remote || typeof remote.moves !== "string") return cur;
  const mine = cur.moves ?? "";
  const theirs = remote.moves;
  if (theirs.length <= mine.length) return cur;
  if (mine && !theirs.startsWith(mine + " ")) return cur;
  try {
    const st = replay(cur.settings, strToMoves(theirs).filter((m) => m.type !== "resign"));
    const next: RoomData = { ...cur, moves: theirs };
    const resigned = /(^|\s)resign$/.test(theirs);
    if (resigned) {
      next.result = remote.result ?? null;
      next.status = "finished";
    } else if (st.result) {
      next.result = st.result;
      next.status = "finished";
    } else if (cur.status === "waiting" || cur.status === "ready") {
      next.status = "playing";
    }
    return next;
  } catch {
    return cur;
  }
}

/** 準備完了の切り替え。両者そろえば対局開始(playing)。戻り値: 文字列 = 拒否理由 */
export function readyTransition(cur: RoomData, uid: string, ready: boolean): RoomData | string {
  if (cur.status !== "ready") return cur.status === "playing" ? "対局はもう始まっています" : "相手がまだ入室していません";
  const players = cur.players ?? {};
  const color: Player | null = players.white === uid ? "white" : players.black === uid ? "black" : null;
  if (!color) return "参加者ではありません";
  cur.ready = { ...(cur.ready ?? {}), [color]: ready };
  return cur;
}

/** 引き分けの提案・受諾・拒否(自分の提案の取り消しは decline)。戻り値: 文字列 = 拒否理由 */
export function drawTransition(cur: RoomData, uid: string, action: "offer" | "accept" | "decline"): RoomData | string {
  if (cur.status !== "playing") return "対局中ではありません";
  const players = cur.players ?? {};
  const me: Player | null = players.white === uid ? "white" : players.black === uid ? "black" : null;
  if (!me) return "参加者ではありません";
  const offer = cur.drawOffer ?? null;
  if (action === "offer") {
    if (offer) return offer === me ? "すでに提案しています" : "相手からの提案に答えてください";
    cur.drawOffer = me;
    return cur;
  }
  if (!offer) return "引き分けの提案はありません";
  if (action === "accept") {
    if (offer === me) return "自分の提案は受諾できません";
    cur.drawOffer = null;
    cur.result = { winner: "draw", reason: "agreement" };
    cur.status = "finished";
    cur.moves = [cur.moves, "draw"].filter(Boolean).join(" ");
    return cur;
  }
  cur.drawOffer = null; // decline(相手の拒否 or 自分の取り消し)
  return cur;
}

/** ホストが対局を開始する。ゲストが準備完了していることが条件 */
export function startTransition(cur: RoomData, uid: string): RoomData | string {
  if (cur.status === "playing") return "対局はもう始まっています";
  if (cur.status !== "ready") return "相手がまだ入室していません";
  if (cur.host && cur.host !== uid) return "ホストのみ開始できます";
  const players = cur.players ?? {};
  const hostColor: Player | null = players.white === uid ? "white" : players.black === uid ? "black" : null;
  if (!hostColor) return "参加者ではありません";
  const guestColor: Player = hostColor === "white" ? "black" : "white";
  if (!cur.ready?.[guestColor]) return "相手がまだ準備完了していません";
  cur.status = "playing";
  cur.ready = undefined;
  return cur;
}

// ---------------------------------------------------------------------------
// 保存
// ---------------------------------------------------------------------------

interface Saved { role: "host" | "guest"; myColor: Player; data: RoomData }

function loadSaved(code: string): Saved | null {
  try {
    const raw = localStorage.getItem(ROOM_KEY(code));
    if (!raw) return null;
    const s = JSON.parse(raw) as Saved;
    if (!s.data || s.data.expiresAt < Date.now()) { localStorage.removeItem(ROOM_KEY(code)); return null; }
    return s;
  } catch { return null; }
}

function save(code: string, s: Saved) {
  try { localStorage.setItem(ROOM_KEY(code), JSON.stringify(s)); } catch { /* ignore */ }
}

function forget(code: string) {
  try { localStorage.removeItem(ROOM_KEY(code)); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// P2P セッション
// ---------------------------------------------------------------------------

type Msg =
  | { t: "hello"; uid: string; moves: string; result: Result; status: RoomData["status"] }
  | { t: "welcome"; data: RoomData; yourColor: Player }
  | { t: "reject"; reason: string }
  | { t: "move"; id: number; uid: string; move: Move; expectedIndex: number }
  | { t: "ack"; id: number; ok: boolean; reason?: string; data?: RoomData }
  | { t: "state"; data: RoomData }
  | { t: "ready"; uid: string; ready: boolean }
  | { t: "draw"; uid: string; action: "offer" | "accept" | "decline" }
  | { t: "bye" };

interface Session {
  code: string;
  role: "host" | "guest";
  uid: string;
  myColor: Player;
  data: RoomData;
  peer: Peer | null;
  conn: DataConnection | null;
  alive: boolean;
  listeners: Set<(v: RoomView | null) => void>;
  pending: Map<number, { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  nextId: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  /** 接続の状態説明(UI には出さないがデバッグ用) */
  lastError: string | null;
  /** 初回の welcome を待つ(ゲスト) */
  joinWaiters: { resolve: (c: Player) => void; reject: (e: Error) => void }[];
}

const sessions = new Map<string, Session>();

function peerId(code: string) { return PEER_PREFIX + code; }

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

function view(s: Session): RoomView {
  return { code: s.code, data: clone(s.data), myUid: s.uid, myColor: s.myColor, opponentOnline: !!s.conn?.open, hostUid: s.data.host ?? (s.role === "host" ? s.uid : null) };
}

function notify(s: Session) {
  const v = view(s);
  for (const cb of s.listeners) cb(v);
}

function persist(s: Session) {
  save(s.code, { role: s.role, myColor: s.myColor, data: s.data });
}

function safeSend(conn: DataConnection | null, m: Msg) {
  try { if (conn?.open) conn.send(m); } catch { /* ignore */ }
}

function peerOptions() {
  // 既定: PeerJS 公式の無料シグナリングサーバー + Google の STUN。TURN は無し。
  // 開発用: ?peerserver=127.0.0.1:9000 でローカルの PeerServer(npx peer --port 9000)に接続
  const opt: ConstructorParameters<typeof Peer>[1] = { debug: 0 };
  const dev = typeof location !== "undefined" ? new URLSearchParams(location.search).get("peerserver") : null;
  if (dev) {
    const [host, port] = dev.split(":");
    Object.assign(opt, { host, port: Number(port || 9000), path: "/", secure: false });
  }
  return opt;
}

function newPeer(id?: string): Peer {
  return id ? new Peer(id, peerOptions()) : new Peer(peerOptions());
}

function scheduleRetry(s: Session, fn: () => void, ms = RECONNECT_MS) {
  if (!s.alive) return;
  if (s.retryTimer) clearTimeout(s.retryTimer);
  s.retryTimer = setTimeout(() => { s.retryTimer = null; if (s.alive) fn(); }, ms);
}

function destroyPeer(s: Session) {
  try { s.conn?.close(); } catch { /* ignore */ }
  try { s.peer?.destroy(); } catch { /* ignore */ }
  s.conn = null;
  s.peer = null;
}

// ---- ホスト ----

function startHost(s: Session, onReady?: { resolve: () => void; reject: (e: Error) => void }) {
  destroyPeer(s);
  const peer = newPeer(peerId(s.code));
  s.peer = peer;
  let ready = false;
  peer.on("open", () => { ready = true; s.lastError = null; onReady?.resolve(); notify(s); });
  peer.on("connection", (conn) => attachHostConn(s, conn));
  peer.on("disconnected", () => {
    // シグナリングサーバーとの接続が切れた(既存の P2P 接続はそのまま)。再接続して新規参加を受け付けられるようにする
    if (!s.alive) return;
    scheduleRetry(s, () => { try { peer.reconnect(); } catch { startHost(s); } });
  });
  peer.on("error", (err) => {
    const type = (err as Error & { type?: string }).type ?? "";
    s.lastError = `${type}: ${err.message}`;
    if (type === "unavailable-id") {
      // 直前の自分のセッションがサーバーにまだ残っている。少し待って取り直す
      scheduleRetry(s, () => startHost(s, ready ? undefined : onReady));
      return;
    }
    if (!ready && onReady && (type === "network" || type === "server-error" || type === "browser-incompatible" || type === "ssl-unavailable")) {
      onReady.reject(new Error(`接続サーバーに到達できません(${type})`));
      s.alive = false;
      destroyPeer(s);
      return;
    }
    if (!ready) scheduleRetry(s, () => startHost(s, onReady));
  });
}

function attachHostConn(s: Session, conn: DataConnection) {
  conn.on("open", () => {
    // 同じ相手からの新しい接続で古いものを置き換える(hello を受けてから確定)
  });
  conn.on("data", (raw) => {
    const m = raw as Msg;
    if (m.t === "hello") {
      const cur = clone(s.data);
      const r = joinTransition(cur, m.uid);
      if (!r.next || !r.myColor) { safeSend(conn, { t: "reject", reason: "ルームは満員です" }); setTimeout(() => conn.close(), 200); return; }
      const merged = mergeRemote(r.next, m);
      // 古い接続を閉じて新しいものを採用
      if (s.conn && s.conn !== conn) { try { s.conn.close(); } catch { /* ignore */ } }
      s.conn = conn;
      s.data = merged;
      persist(s);
      safeSend(conn, { t: "welcome", data: clone(s.data), yourColor: r.myColor });
      notify(s);
    } else if (m.t === "move") {
      const r = moveTransition(clone(s.data), m.uid, m.move, m.expectedIndex);
      if (typeof r === "string") { safeSend(conn, { t: "ack", id: m.id, ok: false, reason: r }); return; }
      s.data = r;
      persist(s);
      // ack に最新状態を同梱して往復を 1 回にする
      safeSend(conn, { t: "ack", id: m.id, ok: true, data: clone(s.data) });
      notify(s);
    } else if (m.t === "draw") {
      const r = drawTransition(clone(s.data), m.uid, m.action);
      if (typeof r === "string") return;
      s.data = r;
      persist(s);
      safeSend(conn, { t: "state", data: clone(s.data) });
      notify(s);
    } else if (m.t === "ready") {
      const r = readyTransition(clone(s.data), m.uid, m.ready);
      if (typeof r === "string") return;
      s.data = r;
      persist(s);
      safeSend(conn, { t: "state", data: clone(s.data) });
      notify(s);
    } else if (m.t === "bye") {
      if (s.conn === conn) { s.conn = null; notify(s); }
    }
  });
  const onGone = () => { if (s.conn === conn) { s.conn = null; notify(s); } };
  conn.on("close", onGone);
  conn.on("error", onGone);
}

// ---- ゲスト ----

function startGuest(s: Session) {
  destroyPeer(s);
  const peer = newPeer();
  s.peer = peer;
  peer.on("open", () => connectToHost(s));
  peer.on("disconnected", () => { if (s.alive) scheduleRetry(s, () => { try { peer.reconnect(); } catch { startGuest(s); } }); });
  peer.on("error", (err) => {
    const type = (err as Error & { type?: string }).type ?? "";
    s.lastError = `${type}: ${err.message}`;
    if (type === "peer-unavailable") {
      // ホストがまだ開いていない。待って再試行
      scheduleRetry(s, () => connectToHost(s));
      return;
    }
    if (type === "network" || type === "server-error" || type === "ssl-unavailable" || type === "browser-incompatible") {
      const w = s.joinWaiters.splice(0);
      if (w.length) { w.forEach((x) => x.reject(new Error(`接続サーバーに到達できません(${type})`))); s.alive = false; destroyPeer(s); return; }
      scheduleRetry(s, () => startGuest(s));
      return;
    }
    scheduleRetry(s, () => connectToHost(s));
  });
}

function connectToHost(s: Session) {
  if (!s.alive || !s.peer || s.peer.destroyed) return;
  if (s.peer.disconnected) { try { s.peer.reconnect(); } catch { /* ignore */ } return; }
  if (s.conn?.open) return;
  let conn: DataConnection;
  try {
    conn = s.peer.connect(peerId(s.code), { reliable: true, serialization: "json" });
  } catch {
    scheduleRetry(s, () => connectToHost(s));
    return;
  }
  s.conn = conn;
  let opened = false;
  const onGone = () => {
    if (s.conn === conn) s.conn = null;
    for (const [, p] of s.pending) { clearTimeout(p.timer); p.reject(new Error("相手との接続が切れました")); }
    s.pending.clear();
    notify(s);
    scheduleRetry(s, () => connectToHost(s));
  };
  conn.on("open", () => {
    opened = true;
    safeSend(conn, { t: "hello", uid: s.uid, moves: s.data.moves ?? "", result: s.data.result ?? null, status: s.data.status });
  });
  conn.on("data", (raw) => {
    const m = raw as Msg;
    if (m.t === "welcome") {
      s.data = m.data; // ホストが正(こちらの棋譜は hello で送ってあり、ホスト側で突き合わせ済み)
      s.myColor = m.yourColor;
      persist(s);
      const w = s.joinWaiters.splice(0);
      w.forEach((x) => x.resolve(m.yourColor));
      notify(s);
    } else if (m.t === "reject") {
      const w = s.joinWaiters.splice(0);
      w.forEach((x) => x.reject(new Error(m.reason)));
      if (w.length) { s.alive = false; destroyPeer(s); }
    } else if (m.t === "state") {
      s.data = m.data;
      // ホストが待機中に色を変えた場合に追従する
      const pl = m.data.players ?? {};
      if (pl.white === s.uid) s.myColor = "white"; else if (pl.black === s.uid) s.myColor = "black";
      persist(s);
      notify(s);
    } else if (m.t === "ack") {
      if (m.ok && m.data) { s.data = m.data; persist(s); notify(s); }
      const p = s.pending.get(m.id);
      if (p) { s.pending.delete(m.id); clearTimeout(p.timer); if (m.ok) p.resolve(); else p.reject(new Error(m.reason ?? "拒否されました")); }
    } else if (m.t === "bye") {
      onGone();
    }
  });
  conn.on("close", onGone);
  conn.on("error", onGone);
  // open にならないまま固まった場合の保険
  setTimeout(() => { if (!opened && s.conn === conn && s.alive) { try { conn.close(); } catch { /* ignore */ } onGone(); } }, JOIN_TIMEOUT_MS);
}

function newSession(code: string, role: Session["role"], uid: string, myColor: Player, data: RoomData): Session {
  const s: Session = {
    code, role, uid, myColor, data, peer: null, conn: null, alive: true,
    listeners: new Set(), pending: new Map(), nextId: 1, retryTimer: null, lastError: null, joinWaiters: [],
  };
  sessions.set(code, s);
  return s;
}

function closeSession(s: Session) {
  s.alive = false;
  if (s.retryTimer) { clearTimeout(s.retryTimer); s.retryTimer = null; }
  safeSend(s.conn, { t: "bye" });
  for (const [, p] of s.pending) { clearTimeout(p.timer); p.reject(new Error("退室しました")); }
  s.pending.clear();
  destroyPeer(s);
  sessions.delete(s.code);
}

// ---------------------------------------------------------------------------
// 公開 API(OnlineScreen が使う)
// ---------------------------------------------------------------------------

/** ルームを作る。hostColor は作成者の色("random" 可) */
export async function createRoom(settings: GameSettings, hostColor: Player | "random"): Promise<{ code: string; myColor: Player }> {
  const uid = await ensureSignedIn();
  const myColor: Player = hostColor === "random" ? (Math.random() < 0.5 ? "white" : "black") : hostColor;
  const now = Date.now();
  const mk = (): RoomData => ({
    createdAt: now, expiresAt: now + ROOM_TTL_MS, settings, host: uid,
    players: { white: myColor === "white" ? uid : null, black: myColor === "black" ? uid : null },
    status: "waiting", moves: "", result: null,
  });
  if (MOCK) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = randomCode();
      if (mockGet(code)) continue;
      mockSet(code, mk());
      return { code, myColor };
    }
    throw new Error("ルームコードの生成に失敗しました");
  }
  const code = randomCode();
  const existing = sessions.get(code);
  if (existing) closeSession(existing);
  const s = newSession(code, "host", uid, myColor, mk());
  persist(s);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error("接続サーバーに到達できません(タイムアウト)")); closeSession(s); forget(code); }, JOIN_TIMEOUT_MS);
    startHost(s, { resolve: () => { clearTimeout(timer); resolve(); }, reject: (e) => { clearTimeout(timer); forget(code); reject(e); } });
  });
  return { code, myColor };
}

/** ルームに参加する。自分が作ったルームなら待ち受けを復活させ、そうでなければホストにつなぐ */
export async function joinRoom(codeRaw: string): Promise<{ code: string; myColor: Player }> {
  const uid = await ensureSignedIn();
  const code = normalizeCode(codeRaw);
  if (code.length !== 6) throw new Error("ルームコードは 6 文字です");
  if (MOCK) {
    let myColor: Player | null = null;
    const r = mockTransaction(code, (cur) => { const j = joinTransition(cur, uid); myColor = j.myColor; return j.next; });
    if (!r.committed || !r.data || !myColor) throw new Error("ルームが見つからないか、満員です");
    return { code, myColor };
  }
  const existing = sessions.get(code);
  if (existing?.alive && existing.uid === uid) {
    // 同一ページ内で既に開いている(戻る→再入室など)
    if (existing.role === "host" || existing.conn?.open) return { code, myColor: existing.myColor };
    closeSession(existing);
  } else if (existing) {
    closeSession(existing);
  }
  const saved = loadSaved(code);
  if (saved && saved.role === "host") {
    if (saved.data.status === "finished") { forget(code); throw new Error("この対局は終了しています"); }
    const s = newSession(code, "host", uid, saved.myColor, saved.data);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error("接続サーバーに到達できません(タイムアウト)")); closeSession(s); }, JOIN_TIMEOUT_MS);
      startHost(s, { resolve: () => { clearTimeout(timer); resolve(); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    });
    return { code, myColor: s.myColor };
  }
  // ゲスト(初回 or 再接続)
  const base: RoomData = saved?.data ?? {
    createdAt: Date.now(), expiresAt: Date.now() + ROOM_TTL_MS, settings: { pieRule: true, rules: "standard" },
    players: {}, status: "waiting", moves: "", result: null,
  };
  const s = newSession(code, "guest", uid, saved?.myColor ?? "black", base);
  if (saved && saved.data.status === "playing") {
    // 再接続: 保存した対局に即入室し、裏でホストにつなぎ続ける(相手は「切断中(復帰待ち)」表示)
    startGuest(s);
    return { code, myColor: s.myColor };
  }
  const myColor = await new Promise<Player>((resolve, reject) => {
    const timer = setTimeout(() => {
      s.joinWaiters = [];
      closeSession(s);
      reject(new Error("ルームが見つかりません(相手がアプリを開いているか、コードを確認してください)"));
    }, JOIN_TIMEOUT_MS);
    s.joinWaiters.push({ resolve: (c) => { clearTimeout(timer); resolve(c); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    startGuest(s);
  });
  return { code, myColor };
}

/** ルームを購読。cb は状態が変わるたびに呼ばれる(相手の接続状態も含む) */
export function subscribeRoom(code: string, uid: string, cb: (view: RoomView | null) => void): () => void {
  if (MOCK) {
    const toView = (data: RoomData | null): RoomView | null => {
      if (!data) return null;
      const myColor: Player | null = data.players?.white === uid ? "white" : data.players?.black === uid ? "black" : null;
      return { code, data: { ...data, moves: data.moves ?? "" }, myUid: uid, myColor, opponentOnline: data.status !== "waiting", hostUid: data.host ?? null };
    };
    return mockSubscribe(code, (d) => cb(toView(d)));
  }
  const s = sessions.get(code);
  if (!s) { cb(null); return () => {}; }
  s.listeners.add(cb);
  cb(view(s));
  return () => { s.listeners.delete(cb); };
}

/** 着手を送る。ホストは自分で判定、ゲストはホストに送って ack を待つ */
export async function sendMove(code: string, uid: string, move: Move, expectedIndex: number): Promise<void> {
  if (MOCK) {
    let reason = "";
    const r = mockTransaction(code, (cur) => {
      if (cur === null) { reason = "ルームがありません"; return; }
      const t = moveTransition(cur, uid, move, expectedIndex);
      if (typeof t === "string") { reason = t; return; }
      return t;
    });
    if (!r.committed) throw new Error(reason || "送信に失敗しました");
    return;
  }
  const s = sessions.get(code);
  if (!s || !s.alive) throw new Error("ルームに接続していません");
  if (s.role === "host") {
    const r = moveTransition(clone(s.data), uid, move, expectedIndex);
    if (typeof r === "string") throw new Error(r);
    s.data = r;
    persist(s);
    safeSend(s.conn, { t: "state", data: clone(s.data) });
    notify(s);
    return;
  }
  if (!s.conn?.open) throw new Error("相手と接続されていません(再接続中)");
  const id = s.nextId++;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { s.pending.delete(id); reject(new Error("相手からの応答がありません")); }, ACK_TIMEOUT_MS);
    s.pending.set(id, { resolve, reject, timer });
    safeSend(s.conn, { t: "move", id, uid, move, expectedIndex });
  });
}

/** 待機中のルーム設定(自分の色・ルール)を変更する。ホストのみ、相手が参加する前だけ */
export async function updateRoomSettings(code: string, uid: string, settings: GameSettings, myColor: Player): Promise<void> {
  const apply = (cur: RoomData): RoomData | string => {
    if (cur.status !== "waiting" && cur.status !== "ready") return "対局が始まっているため変更できません";
    if (cur.host && cur.host !== uid) return "ホストのみ変更できます";
    const players = cur.players ?? {};
    const other = [players.white, players.black].find((p) => p && p !== uid) ?? null;
    cur.settings = settings;
    cur.players = { white: myColor === "white" ? uid : other, black: myColor === "black" ? uid : other };
    if (cur.status === "ready") cur.ready = {}; // 設定が変わったので準備完了をやり直す
    return cur;
  };
  if (MOCK) {
    let reason = "";
    const r = mockTransaction(code, (cur) => { if (!cur) { reason = "ルームがありません"; return; } const t = apply(cur); if (typeof t === "string") { reason = t; return; } return t; });
    if (!r.committed) throw new Error(reason);
    return;
  }
  const s = sessions.get(code);
  if (!s || !s.alive || s.role !== "host") throw new Error("ホストのみ変更できます");
  const r = apply(clone(s.data));
  if (typeof r === "string") throw new Error(r);
  s.data = r;
  s.myColor = myColor;
  persist(s);
  notify(s);
}

/** 準備完了/取り消し。両者そろうと対局開始 */
export async function setReady(code: string, uid: string, ready: boolean): Promise<void> {
  if (MOCK) {
    let reason = "";
    const r = mockTransaction(code, (cur) => { if (!cur) { reason = "ルームがありません"; return; } const t = readyTransition(cur, uid, ready); if (typeof t === "string") { reason = t; return; } return t; });
    if (!r.committed) throw new Error(reason);
    return;
  }
  const s = sessions.get(code);
  if (!s || !s.alive) throw new Error("ルームに接続していません");
  if (s.role === "host") {
    const r = readyTransition(clone(s.data), uid, ready);
    if (typeof r === "string") throw new Error(r);
    s.data = r;
    persist(s);
    safeSend(s.conn, { t: "state", data: clone(s.data) });
    notify(s);
    return;
  }
  if (!s.conn?.open) throw new Error("相手と接続されていません(再接続中)");
  safeSend(s.conn, { t: "ready", uid, ready });
}

/** ホストが対局を開始する */
export async function startGame(code: string, uid: string): Promise<void> {
  if (MOCK) {
    let reason = "";
    const r = mockTransaction(code, (cur) => { if (!cur) { reason = "ルームがありません"; return; } const t = startTransition(cur, uid); if (typeof t === "string") { reason = t; return; } return t; });
    if (!r.committed) throw new Error(reason);
    return;
  }
  const s = sessions.get(code);
  if (!s || !s.alive || s.role !== "host") throw new Error("ホストのみ開始できます");
  const r = startTransition(clone(s.data), uid);
  if (typeof r === "string") throw new Error(r);
  s.data = r;
  persist(s);
  safeSend(s.conn, { t: "state", data: clone(s.data) });
  notify(s);
}

/** 引き分けの提案・受諾・拒否 */
export async function drawAction(code: string, uid: string, action: "offer" | "accept" | "decline"): Promise<void> {
  if (MOCK) {
    let reason = "";
    const r = mockTransaction(code, (cur) => { if (!cur) { reason = "ルームがありません"; return; } const t = drawTransition(cur, uid, action); if (typeof t === "string") { reason = t; return; } return t; });
    if (!r.committed) throw new Error(reason);
    return;
  }
  const s = sessions.get(code);
  if (!s || !s.alive) throw new Error("ルームに接続していません");
  if (s.role === "host") {
    const r = drawTransition(clone(s.data), uid, action);
    if (typeof r === "string") throw new Error(r);
    s.data = r;
    persist(s);
    safeSend(s.conn, { t: "state", data: clone(s.data) });
    notify(s);
    return;
  }
  if (!s.conn?.open) throw new Error("相手と接続されていません(再接続中)");
  safeSend(s.conn, { t: "draw", uid, action });
}

/** ルームを離れる。待機中・終了済みなら保存も消す(対局中は「直前のルームに戻る」用に残す) */
export async function leaveRoom(code: string, uid: string): Promise<void> {
  if (MOCK) {
    const data = mockGet(code);
    if (!data) return;
    const others = [data.players.white, data.players.black].filter((p) => p && p !== uid);
    if ((data.status === "waiting" || data.status === "ready") && others.length === 0) mockSet(code, null);
    return;
  }
  const s = sessions.get(code);
  if (!s) return;
  const status = s.data.status;
  closeSession(s);
  if (status === "waiting" || status === "ready" || status === "finished") forget(code);
}
