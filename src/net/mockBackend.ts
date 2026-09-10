// 開発・テスト用: Firebase の代わりに localStorage + storage イベントで同一ブラウザ内の複数タブを同期する。
// ?mock=1 で有効。本番では使わない。
import type { RoomData } from "./room";

const KEY = (code: string) => `twixt.mockroom.${code}`;
const UID_KEY = "twixt.mock.uid";

export function mockUid(): string {
  let uid = sessionStorage.getItem(UID_KEY);
  if (!uid) { uid = `mock-${Math.random().toString(36).slice(2, 10)}`; sessionStorage.setItem(UID_KEY, uid); }
  return uid;
}

export function mockGet(code: string): RoomData | null {
  const raw = localStorage.getItem(KEY(code));
  return raw ? (JSON.parse(raw) as RoomData) : null;
}

export function mockSet(code: string, data: RoomData | null): void {
  if (data === null) localStorage.removeItem(KEY(code));
  else localStorage.setItem(KEY(code), JSON.stringify(data));
  // 同一タブ内の購読者にも通知(storage イベントは他タブにしか飛ばない)
  window.dispatchEvent(new CustomEvent("twixt-mock-room", { detail: code }));
}

/** 疑似トランザクション(同一ブラウザなので競合はほぼ無い) */
export function mockTransaction(code: string, fn: (cur: RoomData | null) => RoomData | null | undefined): { committed: boolean; data: RoomData | null } {
  const cur = mockGet(code);
  const next = fn(cur ? (JSON.parse(JSON.stringify(cur)) as RoomData) : null);
  if (next === undefined) return { committed: false, data: cur };
  mockSet(code, next);
  return { committed: true, data: next };
}

export function mockSubscribe(code: string, cb: (data: RoomData | null) => void): () => void {
  const fire = () => cb(mockGet(code));
  const onStorage = (e: StorageEvent) => { if (e.key === KEY(code)) fire(); };
  const onLocal = (e: Event) => { if ((e as CustomEvent).detail === code) fire(); };
  window.addEventListener("storage", onStorage);
  window.addEventListener("twixt-mock-room", onLocal);
  fire();
  return () => { window.removeEventListener("storage", onStorage); window.removeEventListener("twixt-mock-room", onLocal); };
}
