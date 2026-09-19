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

## オンライン対戦(PeerJS / P2P)

- サーバーは持たない。PeerJS 公式の無料シグナリングサーバー(0.peerjs.com)で相手を見つけ、あとは端末同士が WebRTC で直接通信する。
- ホストの Peer ID はルームコード(`twixt-<CODE>`)。ホストが審判役で、ゲストの手はホストが検証して両者に配る(`src/net/room.ts`)。
- 両者が対局状態を localStorage に保存する。通信が切れても自動で再接続し、アプリを閉じても「直前のルームに戻る」で同じコードから続きを打てる。
  ただし手を預かるサーバーが無いので、再開には両方が同時にアプリを開いている必要がある。
- TURN サーバーは無いため、キャリア回線同士など一部の NAT 環境ではつながらないことがある。
- 開発時は `?mock=1` を URL に付けると PeerJS を使わず、同一ブラウザの複数タブ間で localStorage 同期して動作確認できる。

## 構成

- `src/core/` ルールエンジン(依存なし・純粋関数)
- `src/ui/` 画面(React)
- `src/net/` オンライン対戦(PeerJS / WebRTC P2P)
- `src/store/` 履歴・進行中対局の保存
- `src/engine/` CPU(twixtbot モデルを ONNX Runtime Web で推論。Lv1〜3 は Policy のみ、MCTS は今後)
- `public/models/twixtbot.onnx` 学習済みモデル(BonyJordan/twixtbot, MIT)
- `public/ort/` ONNX Runtime Web の wasm
- `android/` Capacitor が生成した Android プロジェクト

計画書: `TWIXT_開発計画書_縮小版.md`, `TWIXT_アプリ構成設計.md`, `TWIXT_CPU構築案.md`
