# TWIXT

TWIXT を遊べる PWA / Android アプリ。ローカル対戦・CPU 対戦・オンライン対戦(順次実装)。

## 開発

```bash
npm install
npm run dev        # http://localhost:5173/twixt_new/
npm test           # ルールエンジンのテスト
npm run build      # GitHub Pages 用ビルド (dist/)
```

### CPU のレベル校正(自動対局)

```bash
npm run selfplay -- --pairs 3:4,4:5 --games 20 --jobs 4 --out scripts/results/x.json
```

エンジン同士を白黒交互に対局させ、A 側の勝率と 95% 信頼区間を表にする(`scripts/selfplay.ts`)。
レベル指定は `1`〜`6`(`src/engine/levels.ts`)のほか、`s20`(MCTS 20 回)、`t5000`(時間制 5 秒)、
`p1.5_20`(Policy のみ・温度 1.5・上位 20 手)が使える。
端末実機で測るときは、アプリの URL に `?calib=1` を付ける(またはホーム画面のバージョン表示を 5 回タップ)と
「レベル校正(自動対局)」画面が開く。結果と調整の記録は `docs/level_calibration.md`。

## ビルド・配布(GitHub Actions)

- `main` に push → `.github/workflows/pages.yml` が PWA を GitHub Pages に配置  
  https://arataex5.github.io/twixt_new/
- `main` に push → `.github/workflows/android.yml` が debug APK をビルドし Actions の Artifacts に保存
- `v*` タグを push(例 `git tag v0.1.0 && git push --tags`)→ Releases に APK を添付

初回のみ、リポジトリの Settings → Pages → Source を **GitHub Actions** にしてください。

## オンライン対戦(Firebase)

- Firebase プロジェクト `twixt-online`(Realtime Database + 匿名認証)を使用。接続設定は `src/net/firebase.ts`。
- セキュリティルールは `database.rules.json`。Firebase コンソール → Realtime Database → 「ルール」タブに内容を貼り付けて「公開」する。
- 開発時は `?mock=1` を URL に付けると Firebase を使わず、同一ブラウザの複数タブ間で localStorage 同期して動作確認できる(Firebase と同じく null の値はキーごと落とす)。
- 注意: Firebase RTDB は `null` の値をキーごと削除するため、受信データでは空き枠が `undefined` になる。判定は `== null` で行うこと(`src/net/room.test.ts` 参照)。
- 2026-09-10 本番 Firebase で 2 クライアント検証済み: 作成 → 参加 → 着手同期(双方向) → スワップ → 投了 → 在席表示。

## 構成

- `src/core/` ルールエンジン(依存なし・純粋関数)
- `src/ui/` 画面(React)
- `src/net/` オンライン対戦(Firebase Realtime Database)
- `src/store/` 履歴・進行中対局の保存
- `src/engine/` CPU(twixtbot モデルを ONNX Runtime Web で推論。Lv1〜3 は Policy のみ、Lv4〜6 は MCTS。着手選択は `think.ts`)
- `scripts/selfplay.ts` エンジン同士の自動対局(レベル校正用、Node で実行)
- `public/models/twixtbot.onnx` 学習済みモデル(BonyJordan/twixtbot, MIT)
- `public/ort/` ONNX Runtime Web の wasm
- `android/` Capacitor が生成した Android プロジェクト

計画書: `TWIXT_開発計画書_縮小版.md`, `TWIXT_アプリ構成設計.md`, `TWIXT_CPU構築案.md`
