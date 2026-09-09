# TWIXT アプリ構成設計(アプリ化側)

作成日: 2026-09-09 / 前提: 縮小版計画書(React + TypeScript + Vite、Capacitor、GitHub Actionsでビルド)

取り入れる要素: **CPU戦(強さ数段階)/ ローカル対戦 / オンライン対戦(ルームID入力)/ パイルール ON・OFF**

---

## 1. 全体像

```
┌──────────────────────── UI (React) ────────────────────────┐
│  ホーム │ 対局設定 │ 対局画面 │ 棋譜/履歴 │ 設定             │
└──────────────┬──────────────────────────┬──────────────────┘
               │ GameController (対局進行の司令塔)             │
               │   ┌───────────┬───────────┬───────────┐      │
               │   │ LocalMode │ CpuMode   │ OnlineMode│      │
               │   └───────────┴─────┬─────┴─────┬─────┘      │
               │                     │           │             │
      ┌────────┴────────┐   ┌────────┴────┐ ┌────┴──────────┐
      │ core (ルール)    │   │ engine      │ │ net (Firebase)│
      │ 純粋関数・不変    │   │ Web Worker  │ │ Realtime DB   │
      │ 全モード共通      │   │ ONNX + MCTS │ │ ルーム同期     │
      └─────────────────┘   └─────────────┘ └───────────────┘
```

設計の芯は「**対局の状態 = 設定 + 手順のリスト**」に統一することです。ローカル・CPU・オンラインの3モードは「次の一手を誰がどうやって決めるか」だけが違い、盤面の計算・描画・勝敗判定・棋譜保存はすべて共通の `core` で処理します。オンライン対戦ではこの手順リストを Firebase 上で共有するだけで同期が成立します。

---

## 2. ディレクトリ構成

```
src/
  core/                 ルール(依存なし・純粋関数)
    board.ts            盤面型、座標、辺行、4隅の判定
    links.ts            ナイト跳びリンク、交差テーブル(事前計算)、交差判定
    rules.ts            合法手判定、着手適用、リンク除去、スワップ(パイルール)
    winner.ts           Union-Find による連結・勝敗・引き分け判定
    game.ts             GameSettings / GameState / Move 型、reduce(state, move)
    notation.ts         棋譜の文字列化・パース(Little Golem互換 "F12" 形式、swap は "swap")
  engine/               CPU
    engine.worker.ts    Web Worker 本体(ONNX Runtime Web + MCTS)
    features.ts         盤面 → ニューラルネット入力テンソル
    mcts.ts             PUCT 探索
    levels.ts           難易度定義(後述)
    EngineClient.ts     UI側から Worker を呼ぶラッパー(Promise API、キャンセル対応)
  modes/                対局モード(GameController の実装)
    GameController.ts   共通インターフェース
    LocalMode.ts        同一端末で2人
    CpuMode.ts          人間 vs CPU(色・レベル指定、CPUのスワップ判断)
    OnlineMode.ts       Firebase ルーム同期
  net/
    firebase.ts         初期化(匿名認証)
    room.ts             ルーム作成/参加/着手送信/購読/離脱
    presence.ts         接続状態(onDisconnect)
  ui/
    screens/            Home, Setup, Game, History, Settings
    board/              BoardSvg, PegLayer, LinkLayer, HighlightLayer, ZoomPan
    components/         LevelPicker, RoomCodeInput, ResultDialog, TurnIndicator, など
  store/
    settings.ts         永続設定(localStorage: 既定レベル、パイルール既定、テーマ、効果音)
    history.ts          対局履歴(IndexedDB、棋譜と結果)
  App.tsx / main.tsx / router.tsx
public/
  models/twixtbot.onnx  移植したモデル
  ort/*.wasm            ONNX Runtime Web の wasm
  icon-192.png, icon-512.png
```

---

## 3. core: 対局状態と手の表現

```ts
type Player = "white" | "black";           // white = 上下を結ぶ / 先手、black = 左右を結ぶ

interface GameSettings {
  boardSize: 24;                            // 将来 12 / 30 を追加可能に
  pieRule: boolean;                         // パイルール ON/OFF
  linkRemoval: boolean;                     // 標準ルール(true) / PPルール(false)
}

type Move =
  | { type: "place"; x: number; y: number; removeLinks?: LinkId[] }  // ペグを置く(必要なら自リンク除去)
  | { type: "swap" }                                                  // パイルール行使(後手の1手目のみ)
  | { type: "resign" }
  | { type: "offerDraw" } | { type: "acceptDraw" };

interface GameState {
  settings: GameSettings;
  moves: Move[];                            // これが唯一の真実。盤面は毎回 or 差分で再構築
  board: Board;                             // moves から導出したキャッシュ
  toMove: Player;
  result: null | { winner: Player | "draw"; reason: "connect" | "resign" | "draw" | "timeout" };
  canSwap: boolean;                         // settings.pieRule && moves.length === 1
}

function applyMove(state: GameState, move: Move): GameState;   // 不正手なら throw
function legalMoves(state: GameState): Move[];
```

パイルールの扱いは `canSwap` に集約します。`pieRule: false` の場合は `canSwap` が常に false になり、UI の「スワップ」ボタンも出ません。スワップは Little Golem 方式(初手を主対角線で鏡映して後手の駒にし、次は元の先手が指す)で実装します。

---

## 4. GameController: 3モード共通インターフェース

```ts
interface GameController {
  readonly state: Readable<GameState>;      // UI が購読
  readonly localPlayers: Set<Player>;       // この端末が操作してよい色
  submitMove(move: Move): Promise<void>;    // 人間の着手(自分の手番・自分の色のみ許可)
  undo?(): void;                            // ローカル/CPU のみ
  dispose(): void;
}
```

| モード | 手番の決まり方 | undo | パイルール |
|---|---|---|---|
| Local | 両色とも同じ端末の人間 | あり | 後手側の人が「スワップ」ボタンを押す |
| Cpu | 人間の色は端末、CPU の色は Worker が決定 | あり(CPUの手とセットで2手戻す) | CPUが後手なら value の符号で判断、人間が後手ならボタン |
| Online | 自分の色は端末、相手の色は Firebase から着信 | なし(「待った」は相手承認制を将来検討) | ルーム作成者が設定。後手側の端末にのみボタン表示 |

---

## 5. CPU戦: 難易度の段階設計

強さは「探索量」「Policyのゆらぎ」「意図的なミス」の3軸で作ります。twixtbot-ui の level/temperature/trials と同じ発想です。

| Lv | 名称 | シミュレーション数 | 温度 | 補足 |
|---|---|---|---|---|
| 1 | 入門 | 0(Policyのみ) | 1.0 | Policy上位10手から確率で選ぶ。たまに悪手 |
| 2 | 初級 | 0(Policyのみ) | 0.6 | |
| 3 | 中級 | 0(Policyのみ) | 0.2 | ほぼPolicy最善。twixtbot-ui の "level 1.0, trials 0" 相当 |
| 4 | 上級 | 50 | 0.1 | |
| 5 | 有段 | 200 | 0 | |
| 6 | 最強 | 時間制(既定5秒、設定で変更) | 0 | 端末性能に応じてシミュレーション数が自動で決まる |

実装のポイント: Lv1〜3 は推論1回なので即応答し、Lv4以降は Worker 内で MCTS を回し「思考中」を表示。端末が遅い場合でも Lv6 は時間制なので破綻しません。レベルの並びが実際の勝率と一致するかは、Worker 同士の自動対局(開発用の隠しメニュー)で校正します。

CPU の手番時の流れ: `CpuMode` が `EngineClient.think(state, level)` を呼ぶ → Worker が候補手・勝率を返す → `applyMove`。人間が undo したときは Worker の思考をキャンセル(AbortSignal)。

---

## 6. ローカル対戦

同じ端末で2人。手番の色を上部に大きく表示し、スマホを回さなくて済むように「盤面を手番側に向けて180°回転する」オプションを設けます(TWIXT は180°回転対称なので座標表記だけ補正すれば済みます)。undo は双方合意の代わりに「直前の手だけ戻せる」簡易仕様。

---

## 7. オンライン対戦(ルームID)

### 7.1 バックエンドの選定

サーバーを書かず、GitHub Pages の静的サイトからそのまま使えるものとして **Firebase Realtime Database(無料 Spark プラン)+ 匿名認証** を採用します。無料枠は同時接続 100、ストレージ 1GB、転送 10GB/月で、ターン制ゲームの個人利用には十分です。将来 Play Store に出して人数が増えたら Blaze(従量)に切り替えるだけでコードは変わりません。

代替案: Supabase Realtime(同様に無料枠あり)、PeerJS(WebRTC P2P、サーバー不要だがスマホ回線同士の接続に失敗しやすい)。どちらも `net/room.ts` を差し替えるだけで済むよう抽象化しておきます。

### 7.2 ルームの流れ

1. **作成**: 「ルームを作る」→ 6文字の英数字コード(例 `K7Q2ZP`、紛らわしい 0/O/1/I を除外)を生成 → 設定(パイルール ON/OFF、色は作成者が白/黒/ランダム)を書き込み → コードを表示・共有ボタン(Web Share API)
2. **参加**: 「ルームに入る」→ コード入力 → 存在確認 → `players/black`(空いている側)に自分の uid を登録 → 両者揃ったら `status: "playing"`
3. **対局**: 自分の手番で着手 → `moves` 配列に push(トランザクションで「手番が自分」「手数が一致」を確認) → 相手端末は購読で受け取り `applyMove`
4. **終了**: 勝敗確定 or 投了 → `result` を書き込み → 双方の履歴(IndexedDB)に保存 → ルームは 24 時間後に削除(クライアントが `expiresAt` を見て掃除、または Firebase の TTL ルール)

### 7.3 データモデル(Realtime Database)

```
rooms/{roomCode}
  createdAt: 1757400000000
  expiresAt: 1757486400000
  settings: { boardSize: 24, pieRule: true, linkRemoval: true }
  players: { white: "<uid>", black: "<uid>" | null }
  status: "waiting" | "playing" | "finished"
  moves: [ { type:"place", x:11, y:5 }, { type:"swap" }, ... ]   // 追記のみ
  result: null | { winner:"white", reason:"connect" }
  presence: { "<uid>": { online: true, lastSeen: 1757400123456 } }
```

### 7.4 セキュリティルール(要点)

匿名認証の uid で本人性を担保し、「自分の色の手番のときだけ moves に1件追記できる」「settings と players は status が waiting の間だけ書ける」をルールで強制します。盤面の合法性チェックはクライアント側 `core` で行い、不正手が来たら受信側が無視して警告を出す方針(個人利用なので厳密なサーバー検証は不要)。

### 7.5 接続の扱い

- `onDisconnect` で presence を offline にし、相手画面に「相手が切断中」を表示。ターン制なので復帰すればそのまま続行。
- アプリ再起動時は「進行中のルーム」を localStorage から復元して再購読。
- 手番の持ち時間は設けない(将来「1手○分」を追加可能)。

### 7.6 GitHub Actions との関係

Firebase の Web 設定(apiKey など)は秘密ではないものの、リポジトリ公開時の見た目上、GitHub Secrets → `VITE_FIREBASE_*` 環境変数としてビルド時に注入します。Realtime Database のセキュリティルールは `database.rules.json` をリポジトリに置き、`firebase deploy --only database` を手動(または Actions)で反映します。Capacitor の WebView でも Firebase JS SDK はそのまま動きます。

---

## 8. パイルール ON/OFF の反映箇所

| 場所 | ON | OFF |
|---|---|---|
| 対局設定画面 | トグル(既定は ON、設定で既定値変更可) | |
| core | `canSwap` が後手1手目で true | 常に false |
| CPU戦 | CPU後手: 初手の value を評価し、負なら swap。人間後手: ボタン表示 | ボタン非表示 |
| ローカル | 後手の1手目にボタン | 非表示 |
| オンライン | ルーム設定に保存、参加者に表示。後手端末のみボタン | 非表示 |
| 棋譜 | "swap" を1手として記録 | |

---

## 9. 画面一覧

1. **ホーム**: 「CPUと対戦」「ローカル対戦」「オンライン対戦(作る/入る)」「履歴」「設定」
2. **対局設定**: モード別の設定(色、レベル、パイルール、リンク除去ルール)→「開始」
3. **対局画面**: SVG盤面(ピンチズーム・ドラッグ)、手番表示、直近手ハイライト、スワップ/投了/undo ボタン、CPU戦は勝率バー(任意表示)、オンラインはルームコードと相手の接続状態
4. **結果ダイアログ**: 勝敗・理由、「もう一度」「棋譜を保存」「共有」
5. **履歴**: 過去の対局一覧 → 棋譜再生(1手ずつ送り戻し)
6. **設定**: 既定レベル、既定パイルール、テーマ、効果音、盤の回転、最強レベルの思考時間

---

## 10. 実装順序(アプリ側マイルストーン)

| # | 内容 | 完了条件 |
|---|---|---|
| A1 | core + テスト | 実戦棋譜再生で勝敗一致、パイルール/リンク除去の単体テスト |
| A2 | 対局画面 + ローカル対戦 | スマホ実機でズーム・着手が快適、パイルールON/OFFが効く |
| A3 | PWA + GitHub Actions(Pages / APK) | push で PWA と APK が自動生成される |
| A4 | CPU戦(Lv1〜3: Policyのみ) | ONNX モデルが端末内で動き、即応答で対局できる |
| A5 | CPU戦(Lv4〜6: MCTS) | Worker で思考、キャンセル可能、最強レベルが時間制で動く |
| A6 | オンライン対戦 | 2台のスマホでルームコード対戦、切断・復帰が動く |
| A7 | 履歴・棋譜再生・共有、仕上げ | 一通りの機能が揃い、機内モードでも CPU戦・ローカル戦が動く |

A3 を早めに置いているのは、以降の A4〜A6 をすべて「実機の APK / PWA」で確認しながら進めるためです。

---

## 参考資料

- [Firebase Realtime Database Limits](https://firebase.google.com/docs/database/usage/limits?hl=en)
- [Is Firebase Free in 2026? Spark vs Blaze Pricing Explained](https://unanswered.io/guide/is-firebase-free-pricing-free-tier)
- [Firebase Pricing 2026: Realtime Database Plans & Costs](https://airbyte.com/data-engineering-resources/firebase-database-pricing)
- [Twixt | LG-Docs - Little Golem](https://docs.littlegolem.net/games/twixt/)(スワップの仕様)
- [GitHub - stevens68/twixtbot-ui](https://github.com/stevens68/twixtbot-ui)(難易度パラメータの参考)
