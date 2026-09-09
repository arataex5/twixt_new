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

## 構成

- `src/core/` ルールエンジン(依存なし・純粋関数)
- `src/ui/` 画面(React)
- `src/engine/` CPU(ONNX Runtime Web + MCTS)※これから
- `android/` Capacitor が生成した Android プロジェクト

計画書: `TWIXT_開発計画書_縮小版.md`, `TWIXT_アプリ構成設計.md`, `TWIXT_CPU構築案.md`
