// Firebase 初期化(Realtime Database + 匿名認証)。
// この設定値は公開して問題ない種類のもの(アクセス制御はセキュリティルールで行う)。
import { initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, signInAnonymously, onAuthStateChanged, connectAuthEmulator, type Auth } from "firebase/auth";
import { getDatabase, connectDatabaseEmulator, type Database } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyC7DNsYwWPgdTPP3Un7BqM44yJAhs128U0",
  authDomain: "twixt-online.firebaseapp.com",
  databaseURL: "https://twixt-online-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "twixt-online",
};

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Database | null = null;

function ensure() {
  if (!app) {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getDatabase(app);
    // 開発用: ?emu=1 でローカルの Firebase エミュレータに接続
    if (new URLSearchParams(location.search).get("emu") === "1") {
      connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
      connectDatabaseEmulator(db, "127.0.0.1", 9000);
    }
  }
  return { app: app!, auth: auth!, db: db! };
}

export function getDb(): Database {
  return ensure().db;
}

/** 匿名ログインして uid を返す(2 回目以降は保存済みのセッションを再利用) */
export async function ensureSignedIn(): Promise<string> {
  const { auth } = ensure();
  if (auth.currentUser) return auth.currentUser.uid;
  const existing = await new Promise<string | null>((resolve) => {
    const unsub = onAuthStateChanged(auth, (u) => { unsub(); resolve(u ? u.uid : null); });
  });
  if (existing) return existing;
  const cred = await signInAnonymously(auth);
  return cred.user.uid;
}
