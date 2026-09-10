# CLAUDE.md — twixt_new 作業ガイド

このファイルは Claude(Claude Code / Cowork)が毎セッション最初に読む前提メモ。
計画・設計の本体はリポジトリ直下の計画書にある。先にここを読み、必要な計画書を参照すること。

- `TWIXT_開発計画書_縮小版.md` … 現在採用している計画(これが正)
- `TWIXT_アプリ構成設計.md` … 画面・データモデル(オンライン対戦のルーム構造は 7.3)
- `TWIXT_CPU構築案.md` … CPU(twixtbot モデル移植)の方針
- `TWIXT_開発計画書.md` … 初期の広い計画(参考のみ)

## プロジェクトの目的とスコープ

- TWIXT で「最強 CPU」と対戦できるアプリ。PWA と Android APK の両対応が必須。
- 規模は控えめ: 出先でスマホから最強 CPU と対戦できれば十分。過剰な汎用化はしない。
- 必須機能: CPU 戦(強さ数段階)、ローカル対戦、オンライン対戦(ルーム ID 入力)、パイルール ON/OFF。
- 技術: Vite + React + TypeScript のみ(Python は照合テスト用途だけ)。CPU は twixtbot の学習済みモデルを
  ONNX Runtime Web で端末内推論(Worker)。サーバー側の推論は行わない。
- オーナー: arata(GitHub: arataex5)。学習環境は個人 PC(GPU 1 枚程度)。

## 進捗(2026-09-10 時点)

| サイクル | 内容 | 状態 |
| --- | --- | --- |
| 1 | 雛形、`src/core` ルールエンジン(+テスト)、ローカル対戦 UI、PWA、Capacitor、Actions | 完了 |
| 2 | CPU 戦 Lv1〜3(Policy のみ、ONNX in Worker、Python 照合テスト 36 件一致) | 完了 |
| 3 | MCTS Lv4〜6、時間制、進捗表示、キャンセル | 完了 |
| 4 | 対局履歴・棋譜再生・続きから・局面から対局 | 完了 |
| 5 | オンライン対戦(Firebase RTDB)。本番 Firebase で 2 クライアント検証済み | 完了 |
| 6 | レベル校正。`?calib=1&a=5&b=6&n=10&t=10000&pie=1` で自動対局(`src/ui/CalibScreen.tsx`)。Lv6 = 10 秒 + 最低 60 回読み | 完了 |

- レベル設定は `src/engine/levels.ts`。スマホ実測: 1 評価 ≈ 250 ms(PC は ≈ 170 ms)。Lv4 = 12 sims、Lv5 = 40 sims。
- 校正結果 2026-09-10(PC、パイ無し): Lv5 vs Lv6(5 秒) 10 局 = 5-5、白 8 勝。Lv6 5 秒 ≈ 29 評価 < Lv5 40 sims で
  「最強」が最強でなかった → Lv6 を既定 10 秒 + 最低 60 回読む(`minSims`)に変更。校正は先手有利を避けるため `pie=1` で回す。
- 再計測 2026-09-10(PC、pie=1、Lv6 10 秒): Lv6 6 勝 4 敗、白黒 5-5(先手有利は解消)。Lv5 1 手平均 4.0 s、Lv6 9.9 s(最大 11.2 s)。
  スマホでは Lv6 は 1 手 15 秒前後になる見込み。これで必須機能はすべて完了。さらに強くするなら minSims を 100 に上げるか Lv5 を 30 sims に下げる。
- Pages 公開先: https://arataex5.github.io/twixt_new/

## 運用ルール

- `main` に push → Pages デプロイと debug APK ビルドが自動で走る(`.github/workflows/`)。
  `v*` タグで Releases に APK 添付。
- Claude Code(クラウド)から作業する場合はブランチに push → PR → arata がマージ。`main` へ直接 push しない。
- Cowork(フォルダ接続)から作業する場合は Claude がファイルを書き、arata が GitHub Desktop で Commit & Push する。
  PC のコマンドプロンプトでは git が PATH に無いので、バッチで git 操作をさせない。
- 変更後は必ず `npm test`(vitest)、`npx tsc -b`、`npm run build` を通す。lint は `npm run lint`(oxlint)。
- 大きなバイナリ(`public/models/twixtbot.onnx`、`public/ort/*.wasm`)は差し替えない限り触らない。
- 行き詰まったら計画の見直しも含めて PDCA で回す(arata の希望)。

## オンライン対戦(Firebase)の注意

- Firebase プロジェクト `twixt-online`(RTDB asia-southeast1、匿名認証)。設定は `src/net/firebase.ts` に同梱。
- セキュリティルールは `database.rules.json`(コンソールに貼って公開する運用)。
- RTDB は `null` の値をキーごと落とす。受信側では空き枠が `undefined` になるので判定は `== null`。
  `?mock=1` の localStorage バックエンドも同じ挙動に揃えてある(`src/net/mockBackend.ts`)。
- トランザクション本体は純粋関数 `joinTransition` / `moveTransition`(`src/net/room.ts`)。テストは `src/net/room.test.ts`。
- Anthropic のクラウド環境から Firebase ドメインへは(ネットワーク許可を Custom にしても)到達できなかった実績あり。
  本番検証は Pages 版をユーザー側ブラウザで開いて行う。同一ページ内で `initializeAuth(app, { persistence: inMemoryPersistence })`
  の別インスタンスを作れば 2 人目のプレイヤーを再現できる。
- ルームコードは `normalizeCode` で O→0、I→1 に正規化される。テスト用コードに O/I を含めないこと。

## コード構成

- `src/core/` ルールエンジン(依存なし・純粋関数)。座標表記は Little Golem 互換(`A1`〜`X24`)。
- `src/engine/` CPU(`net.ts` 推論、`mcts.ts`、`levels.ts`、`engine.worker.ts`、`EngineClient.ts`)。
- `src/ui/` 画面(React)。`GameScreen.tsx` が対局画面の中心。setState の更新関数内で throw しない(画面が真っ黒になる)。
- `src/net/` オンライン対戦。`src/store/` 履歴保存。
- `android/` Capacitor 生成物。`npm run build:cap` で同期。
