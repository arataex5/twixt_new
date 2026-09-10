# TWIXT CPU(最強化)構築案

作成日: 2026-09-09 / 前提: 縮小版計画(TypeScriptのみ、端末内推論、GitHub Actionsでビルド)

方針は「**twixtbot の学習済みモデルを移植して端末で動かす**」です。本書を書くにあたり、実際にモデルを ONNX に変換して動作を検証したので、その結果(入出力の仕様・速度)を織り込んでいます。変換済みの `twixtbot.onnx`(10.3MB)は twixt_new フォルダに置いてあります。

---

## 0. 検証済みの事実(この構築案の土台)

| 項目 | 結果 |
|---|---|
| 移植元 | twixtbot-ui 同梱モデル `model/pb`(BonyJordan/twixtbot 2020年12月版、MIT License) |
| 変換 | TF1 SavedModel → 変数を定数化 → `is_training=False` を畳み込み → tf2onnx(opset 17)で **変換成功** |
| 精度 | TF と ONNX Runtime の出力差: value 1e-5、policy logits 1.5e-5(実質同一) |
| サイズ | ONNX 10.27MB(Conv 49層、Abs 活性化、BatchNorm 2、MatMul 2) |
| 速度 | デスクトップCPU(ONNX Runtime、1バッチ)で **13.6ms/評価** |
| 動作確認 | 空盤で白の勝率 +0.45(先手有利を正しく認識)、初手候補は L12・M12・L13・M13(中央)で妥当 |

### 入出力の仕様(TypeScript で前処理を書くときの正解)

すべて **手番側が「上下(y=0 と y=23)を結ぶ白」になるように正規化**して入力します。黒番のときは盤を転置(x↔y)して色を入れ替えます。座標は x=列(A〜X)、y=行(1〜24)、配列は `[y][x]` ではなく **`[x][y]`**(numpy の `pegs[x, y]`)である点に注意。

| テンソル | 形 | 内容 |
|---|---|---|
| `pegx:0` | [1,24,24,2] float32 | ch0 = 相手(黒)のペグ、ch1 = 自分(白)のペグ。1/0 |
| `linkx:0` | [1,24,24,8] float32 | リンク面。index = color(0=黒,1=白) + 2×diffsign + 4×longy。longy = リンクの長い方が y 方向(`(a.x+b.x) % 2 != 0` のとき1)。diffsign = `(b.y−a.y)×(b.x−a.x) < 0` のとき1。格納位置は両端の中点を切り捨てた `(floor((ax+bx)/2), floor((ay+by)/2))`。**入力直前に**、`longy or diffsign` なら x 方向に +1、`(not longy) or diffsign` なら y 方向に +1 だけ面全体をずらす(端は0埋め) |
| `locx:0` | [1,24,24,2] float32 | 定数。ch0[x][y] = y/24、ch1[x][y] = x/24(位置エンコーディング) |
| `pwin:0` | [1,3] | (負け, 引分, 勝ち) のロジット。value = softmax後の P(勝ち) − P(負け) で −1〜+1 |
| `movelogits:0` | [1,528] | 白番視点の着手ロジット。index = (x−1)×24 + y、x∈1..22(自分が置けない左右の辺行 x=0,23 を除く)、y∈0..23。合法手(空き穴)でマスクして softmax |

黒番時は入力を転置した上で、出力の index を `(y−1)×24 + x` として読み替えれば元の座標に戻ります。

### モデルが前提とするルール

twixtbot は **リンク除去なし**で学習されており、元の twixtbot は「自分のリンク同士の交差を許可」(PPルール相当)、twixtbot-ui の既定は「自リンク交差も禁止」です。どちらでもほぼ同じ強さで打つと報告されています。本アプリの CPU は「置く手」だけを Policy から取り、リンクの張り方(交差・除去)は **アプリ側で選択中のルールに従って core が処理**します。標準ルールで自リンクが邪魔になる稀なケースは「その自リンクを外して置く」を自動で行います。

---

## 1. エンジンの構成(Web Worker 内)

```
engine/
  features.ts      GameState → {pegx, linkx, locx}(上記仕様。黒番は転置)
  net.ts           ONNX Runtime Web セッション、evaluate(state) → {value, policy[572]}
  mcts.ts          PUCT 探索(twixtbot-ui の nnmcts.py を TS に移植)
  swap.ts          パイルール判断
  levels.ts        難易度 → {sims, temperature, timeMs, noise}
  engine.worker.ts メッセージ処理(think / cancel / analyze)
```

### 1.1 推論(net.ts)

- ONNX Runtime Web、実行プロバイダは `webgpu` → 失敗時 `wasm`(SIMD、スレッド数は Capacitor では 1 になり得る)。
- セッションは Worker 起動時に1回だけ作成し、モデルは PWA の precache / APK の assets から読む。
- 合法手マスク → softmax → Policy。value は 3値ロジットから `P(勝)−P(負)`。
- 対称性: 白番視点では左右反転(x → 23−x)と上下反転(y → 23−y)が同色対称なので、評価時にランダムに反転して入力し、出力を戻す(twixtbot-ui の ROT_RAND と同じ。同じ局面で毎回同じ手を打たない効果もある)。

### 1.2 探索(mcts.ts)

twixtbot-ui の `nnmcts.py` をそのまま TS に移植します(実績のあるロジックを変えない)。

- ノード: N, W, Q, P を Float32Array(572) で持つ。子は Map。
- 選択: PUCT、`cpuct = 1.0`(twixtbot-ui 既定)。
- 展開: core で着手 → 勝ち/引き分けなら proven ノード、そうでなければ net.evaluate。
- 勝ちが確定した枝の伝播(proven win/loss)を入れる。接続ゲームは終盤で「あと1手で勝ち」が頻出するので効果が大きい。
- ルートの Dirichlet ノイズは対局用ではオフ(学習用機能なので不要)。
- **smart accept**(twixtbot-ui の機能): 最善手の訪問数が2位を「残りシミュレーション数」以上引き離したら探索を打ち切る。スマホでは体感速度に直結。
- キャンセル: `think` は `AbortSignal` で中断し、その時点の最善手を返す(undo・画面遷移対策)。
- 木の再利用: 相手の手が予想内なら部分木を引き継ぐ。

### 1.3 パイルール判断(swap.ts)

2段構え。**まず value で判断**し、ネットの評価が読めない場合の保険として twixtbot の経験則を使います。

1. 初手が打たれた局面を(自分が後手として)評価し、value < 0(自分が不利)ならスワップ。
2. 保険の経験則(twixtbot-ui の swapmodel): 初手が 7〜18 行目、または B6/C6/V6/W6/B19/C19/V19/W19 ならスワップ。
3. CPU が先手のときの初手は、twixtbot-ui と同様に「スワップされてもされなくても五分に近い点」から確率的に選ぶ(swapmodel の回帰式を移植するか、value で 500 点程度を事前評価したテーブルを同梱)。

---

## 2. 難易度の設計(実測値ベース)

デスクトップCPUで 13.6ms/評価なので、スマホの WASM(単スレッド)では **50〜150ms/評価** 程度を見込みます(WebGPU が使える端末では大幅に速い)。これを前提に各レベルを決めます。

| Lv | 名称 | 方式 | パラメータ(2026-09-10 校正後) | スマホでの1手 |
|---|---|---|---|---|
| 1 | 入門 | Policy のみ | 温度 1.3、上位 16 手から抽選 | 即時 |
| 2 | 初級 | Policy のみ | 温度 1.0、上位 12 手から抽選 | 即時 |
| 3 | 中級 | Policy のみ | 貪欲(温度 0)。twixtbot-ui の level 1.0 / trials 0 相当 | 即時 |
| 4 | 上級 | MCTS | 12 sims | 3 秒程度 |
| 5 | 有段 | MCTS | 40 sims | 10 秒程度(smart accept で短縮) |
| 6 | 最強 | MCTS 時間制 | 既定 5 秒(設定で 3〜60 秒)、ただし最低 60 sims は読む。WebGPU 端末では同じ時間で数倍の sims | 設定した時間(遅い端末では最低回数ぶん) |

校正の経緯と勝率は `docs/level_calibration.md` を参照。当初案(Lv4 = 30、Lv5 = 100 sims)はスマホの実測(1 評価 ≈ 250 ms)では遅すぎたため減らした。

Lv3(Policy のみ)でも twixtbot-ui の作者は「ほとんどの人間に勝てる」としており、実用上はここが「強い CPU」の入口です。Lv6 は端末性能に比例して強くなるので、端末の推論速度を起動時に計測して「この端末での予想 sims 数」を設定画面に表示します。

レベル間の勝率が単調になっているかは、Node の自動対局スクリプト(`npm run selfplay`)と、開発用の隠しメニュー「レベル校正(自動対局)」(`?calib=1`、色を入れ替えて対局)で校正します。

---

## 3. 構築ステップ

| # | 作業 | 完了条件 |
|---|---|---|
| C1 | `features.ts` の実装と**照合テスト** | twixtbot-ui(Python)で数十局面の `pegx/linkx` をダンプし、TS 側の出力とビット単位で一致。ここが唯一の「間違えると静かに弱くなる」箇所 |
| C2 | `net.ts` + Worker + ONNX Runtime Web | ブラウザで空盤の value ≈ +0.45、初手候補が L12/M12 になる。Capacitor 実機でも同じ |
| C3 | Lv1〜3(Policy のみ)を対局画面に接続 | スマホで即応答の対局ができる |
| C4 | `mcts.ts` 移植 + proven 伝播 + smart accept + キャンセル | 同一局面で twixtbot-ui(trials 100)と同じ最善手を高頻度で選ぶ。1手で「あと1手勝ち」を逃さない |
| C5 | Lv4〜6、端末速度計測、時間制 | Lv6 が設定時間内に返る。メモリが増え続けない(木の破棄) |
| C6 | パイルール判断、先手初手テーブル | 後手 CPU が中央初手をスワップし、端の初手はスワップしない |
| C7 | 自動対局による校正、解析表示(勝率バー・候補手) | Lv が上がるほど勝率が上がる。勝率グラフが対局画面で見える |

C1 の照合テストは、Python 側で `NetInputs(game).to_input_arrays()` の結果を JSON に落とし、vitest で比較するだけなので、最初に作っておくと以降の全作業が安全になります。

---

## 4. 端末での高速化(必要になったら)

1. **fp16 化**: ONNX の重みを fp16 に変換(約5MB)。WebGPU では速度も上がる。
2. **int8 量子化**: ONNX Runtime の静的量子化。WASM CPU で 2〜3 倍。精度低下は自動対局で確認。
3. **バッチ評価**: MCTS で複数リーフをまとめて1回の推論に(virtual loss を使う)。WebGPU で効果大。
4. **WebGPU の有効化確認**: Android Chrome/WebView は新しいバージョンなら WebGPU 対応。`ort.env.webgpu` の可否を起動時に判定してレベル表示に反映。

---

## 5. 「twixtbot 超え」を目指す場合の道筋(任意・後日)

ゼロから学習せず、**変換済みモデルを出発点に自分の GPU で追加学習**する方法が現実的です。

1. `onnx2torch` で ONNX → PyTorch に変換し、同じ構造のまま重みを引き継ぐ(twixtbot の元コードは TF1/Python2 なので再現より変換の方が早い)。
2. 自己対戦生成: 上記 TS エンジンではなく、Python(または Rust)でバッチ推論付き MCTS を書き、GPU1枚で回す。KataGo 流の効率化(playout cap randomization、補助ターゲット)を入れる。
3. 新旧モデルを自動対局でゲーティングし、勝率 55% 超なら ONNX に書き出してアプリのモデルを差し替える(アプリ側はファイル差し替えのみ)。
4. 目標の目安: 変換済み twixtbot に対して勝率 70% 以上。そこから先はフル版計画書の Stage 4(証明探索・ネット拡大)へ。

---

## 6. リスクと対策

- **前処理のズレ**(最大のリスク): C1 の照合テストで潰す。特にリンク面の「1マスずらし」と黒番の転置。
- **スマホでの推論が遅い**: Lv6 を時間制にしてあるので破綻はしない。fp16/int8 で改善。
- **メモリ**: 24×24 で 572 要素 × 4 配列 × ノード数。1手あたり数千ノードなら数十MB以内。手が進んだら古い木を破棄。
- **ルール差(リンク除去)**: 標準ルール選択時のみ稀に発生。core が自動処理するので CPU の強さには影響しない。
- **ライセンス**: twixtbot / twixtbot-ui はいずれも MIT。アプリ内のクレジット表記に両者を記載する。

---

## 参考資料

- [GitHub - BonyJordan/twixtbot](https://github.com/BonyJordan/twixtbot)(モデル、MIT)
- [GitHub - stevens68/twixtbot-ui](https://github.com/stevens68/twixtbot-ui)(TF2用モデル、MCTS・swapmodel の移植元、MIT)
- [Twixt | LG-Docs - Little Golem](https://docs.littlegolem.net/games/twixt/)(スワップ仕様)
