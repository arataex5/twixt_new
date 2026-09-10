# TWIXT

TWIXT を遊べる PWA / Android アプリ。ローカル対戦・CPU 対戦・オンライン対戦(順次実装)。

## 開発

```bash
npm install
npm run dev        # http://localhost:5173/twixt_new/
npm test           # ルールエンジンのテスト
npm run build      # GitHub Pages 用ビルド (dist/)
```

## ビルド・配布(GitHub Actions)

- `main` に push → `.github/workflows/pages.yml` が PWA を GitHub Pages に配置  
  https://arataex5.github.io/twixt_new/
- `main` に push → `.github/workflows/android.yml` が debug APK をビルドし Actions の Artifacts に保存
- `v*` タグを push(例 `git tag v0.1.0 && git push --tags`)→ Releases に APK を添付

初回のみ、リポジトリの Settings → Pages → Source を **GitHub Actions** にしてください。

## オンライン対戦(Firebase)

- Firebase プロジェクト `twixt-online`(Realtime Database + 匿名認証)を使用。接続設定は `src/net/firebase.ts`。
- セキュリティルールは `database.rules.json`。Firebase コンソール → Realtime Database → 「ルール」タブに内容を貼り付けて「公開」する。
- 開発時は `?mock=1` を URL に付けると Firebase を使わず、同一ブラウザの複数タブ間で localStorage 同期して動作確認できる。

## 構成

- `src/core/` ルールエンジン(依存なし・純粋関数)
- `src/ui/` 画面(React)
- `src/net/` オンライン対戦(Firebase Realtime Database)
- `src/store/` 履歴・進行中対局の保存
- `src/engine/` CPU(twixtbot モデルを ONNX Runtime Web で推論。Lv1〜3 は Policy のみ、MCTS は今後)
- `public/models/twixtbot.onnx` 学習済みモデル(BonyJordan/twixtbot, MIT)
- `public/ort/` ONNX Runtime Web の wasm
- `android/` Capacitor が生成した Android プロジェクト

計画書: `TWIXT_開発計画書_縮小版.md`, `TWIXT_アプリ構成設計.md`, `TWIXT_CPU構築案.md`
