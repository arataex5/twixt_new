# TWIXT 最強CPUアプリ 開発計画書(縮小版)

作成日: 2026-09-09 / 目的: **出先でスマホから強いCPUと対戦できるアプリ**を、PWA + APK(GitHub Actionsでビルド)で作る

元の計画書(フル版)は同フォルダの `TWIXT_開発計画書.md` を参照。本書はそのうち「本当に必要な部分」だけを残し、AIはゼロから育てずに公開済みモデルを移植する方針に変更したものです。

---

## 1. 全体方針

| 項目 | 方針 |
|---|---|
| 目標 | 自分のスマホで、オフラインで、twixtbot級の強さのCPUと対戦できる |
| 技術 | React + TypeScript + Vite(PWA)、Capacitor(APK)。エンジンもTypeScriptのみ(Rust/WASMは使わない) |
| AI | twixtbot の学習済みモデル(twixtbot-ui 同梱)をONNXに変換し、ONNX Runtime Web で端末内推論。探索は小規模MCTSをTSで実装 |
| ビルド・配布 | GitHub Actions で PWA(GitHub Pages)と APK(Artifacts / Releases)を自動生成。Play Store には出さない |
| 期間の目安 | 1〜2ヶ月 |

---

## 2. 作業ステップ

### ステップ1: ルールエンジン + 盤面UI(TypeScript)

- `src/core/`: 24×24盤(4隅なし)、ペグ配置、ナイト跳びリンクの自動生成、リンク交差判定(交差しうるリンクは各候補につき最大9本なので事前テーブル化)、自リンク除去、スワップ、Union-Findによる勝敗判定、引き分け、棋譜(Little Golem互換の座標表記)の入出力。
- テスト(vitest): Little Golemの実戦棋譜を数局再生して勝敗が一致することを確認。
- `src/ui/`: SVG盤面、タップで着手、ピンチズーム、直近手ハイライト、undo、ローカル2人対戦、棋譜保存。

### ステップ2: twixtbot モデルの移植

1. twixtbot-ui をPCにセットアップし、同梱モデル(`model/pb`、TensorFlow SavedModel)を確認。
2. `tf2onnx` で ONNX に変換(`python -m tf2onnx.convert --saved-model model/pb --output twixtbot.onnx`)。
3. twixtbot のソースから入力プレーンの並び(自ペグ/相手ペグ/リンク面など)と出力(policy 572点 + value)の仕様を読み取り、TSで同じ前処理を実装。**PC上でtwixtbot-uiの評価値とONNXの出力が一致することを確認**してからアプリに組み込む。
4. `src/engine/`: ONNX Runtime Web(WASMバックエンド)で推論 + PUCT型MCTS(数十〜数百シミュレーション)。Web Worker で動かしUIを止めない。
5. 難易度: シミュレーション数・温度・貪欲度で5〜10段階。最強はスマホで1手3〜5秒を目安。
6. 保険: モデル変換で詰まった場合は、フル版計画書 Stage 1 の評価関数+αβ探索をTSで実装して代替。

### ステップ3: PWA化 + GitHub Actions で APK 化(本書のメイン)

以下に手順を詳述します。

---

## 3. GitHub でビルドする手順(PWA + APK)

### 3.1 リポジトリ構成

```
twixt_new/
  package.json
  vite.config.ts        ← vite-plugin-pwa と base パスを設定
  capacitor.config.ts   ← Capacitor 設定
  src/                  ← アプリ本体
  android/              ← Capacitor が生成(コミットする)
  .github/workflows/
    pages.yml           ← PWA を GitHub Pages に配置
    android.yml         ← APK をビルドして Artifacts / Releases に置く
```

### 3.2 PC側で一度だけやる初期設定

(Node.js だけあれば可。Android Studio は不要。APK の生成は GitHub 側で行う)

```bash
npm create vite@latest twixt_new -- --template react-ts
cd twixt_new
npm install
npm install -D vite-plugin-pwa
npm install @capacitor/core @capacitor/android
npm install -D @capacitor/cli
npx cap init "TWIXT" "com.arata.twixt" --web-dir dist
npm run build
npx cap add android        # android/ フォルダが生成される → git にコミット
```

`vite.config.ts` の要点:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  // GitHub Pages で https://<user>.github.io/twixt_new/ に置く場合。Capacitor 用ビルドでは "./" にする
  base: process.env.CAP_BUILD ? "./" : "/twixt_new/",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["models/*.onnx", "ort/*.wasm"],
      manifest: {
        name: "TWIXT",
        short_name: "TWIXT",
        display: "standalone",
        orientation: "portrait",
        theme_color: "#1e1e1e",
        background_color: "#1e1e1e",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" }
        ]
      },
      workbox: {
        // ONNX モデルと ORT の wasm もオフラインキャッシュに含める
        globPatterns: ["**/*.{js,css,html,png,svg,wasm,onnx}"],
        maximumFileSizeToCacheInBytes: 50 * 1024 * 1024
      }
    })
  ]
});
```

`capacitor.config.ts`:

```ts
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.arata.twixt",
  appName: "TWIXT",
  webDir: "dist",
  android: { allowMixedContent: false }
};
export default config;
```

`package.json` の scripts に追加:

```json
"build:pages": "vite build",
"build:cap": "CAP_BUILD=1 vite build && npx cap sync android"
```

### 3.3 PWA を GitHub Pages に配置するワークフロー

`.github/workflows/pages.yml`

```yaml
name: Deploy PWA to GitHub Pages
on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build:pages
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

リポジトリの Settings → Pages → Source を **GitHub Actions** にしておきます。push すると `https://<ユーザー名>.github.io/twixt_new/` に公開され、スマホのChromeで開いて「ホーム画面に追加」すれば PWA として動きます(HTTPS は GitHub Pages が自動で満たすので Service Worker も有効)。

### 3.4 APK をビルドするワークフロー

`.github/workflows/android.yml`

```yaml
name: Build Android APK
on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: 21          # Capacitor 7 以降は JDK 21 が必須

      - uses: android-actions/setup-android@v3

      - uses: gradle/actions/setup-gradle@v4   # Gradle キャッシュ

      - name: Build web + sync Capacitor
        run: |
          npm ci
          npm run build:cap

      - name: Build debug APK (自分の端末用なら署名不要)
        run: |
          cd android
          chmod +x gradlew
          ./gradlew assembleDebug

      - uses: actions/upload-artifact@v4
        with:
          name: twixt-debug-apk
          path: android/app/build/outputs/apk/debug/app-debug.apk
          retention-days: 30
```

Actions の実行が終わると、ワークフロー画面の **Artifacts** に `twixt-debug-apk` が出ます。zipをスマホに転送 → 解凍 → 「提供元不明のアプリ」を許可してインストール、で動きます。debug APK は自動生成される debug 鍵で署名されているため、自分用ならこれで十分です(同じリポジトリの後続ビルドも同じ鍵になるので上書きインストールも通ります。ただし Actions のランナーは毎回新しいため debug 鍵が変わる可能性があり、更新時に「署名が違う」と言われたら一度アンインストールしてください。これを避けたい場合は 3.5 の署名付きビルドにします)。

### 3.5 (任意)署名付き release APK + GitHub Releases への自動配置

更新のたびにアンインストール不要にしたい場合は、自前の鍵で署名します。鍵は一度だけ作ってGitHub Secretsに保存します。

鍵の生成(PC に JDK があれば `keytool`。無ければ GitHub Actions の `workflow_dispatch` で1回だけ実行するジョブを作って Artifacts でダウンロードしても可):

```bash
keytool -genkeypair -v -keystore twixt.keystore -alias twixt -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 twixt.keystore > twixt.keystore.b64
```

GitHub Secrets(Settings → Secrets and variables → Actions)に登録:

- `ANDROID_KEYSTORE_B64` … 上の base64 文字列
- `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`(= twixt), `ANDROID_KEY_PASSWORD`

`android/app/build.gradle` の `android { }` 内に追記(環境変数が無ければ署名設定をスキップ):

```groovy
signingConfigs {
    release {
        if (System.getenv("KEYSTORE_PATH")) {
            storeFile file(System.getenv("KEYSTORE_PATH"))
            storePassword System.getenv("KEYSTORE_PASSWORD")
            keyAlias System.getenv("KEY_ALIAS")
            keyPassword System.getenv("KEY_PASSWORD")
        }
    }
}
buildTypes {
    release {
        signingConfig signingConfigs.release
        minifyEnabled false
    }
}
```

ワークフローに追加するステップ(3.4 の debug ビルドの代わり):

```yaml
      - name: Decode keystore
        run: echo "${{ secrets.ANDROID_KEYSTORE_B64 }}" | base64 -d > ${{ runner.temp }}/twixt.keystore

      - name: Build signed release APK
        env:
          KEYSTORE_PATH: ${{ runner.temp }}/twixt.keystore
          KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}
          KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}
        run: |
          cd android
          ./gradlew assembleRelease

      - uses: actions/upload-artifact@v4
        with:
          name: twixt-release-apk
          path: android/app/build/outputs/apk/release/app-release.apk

      # タグを打ったときだけ Releases に添付(スマホのブラウザから直接ダウンロードできて便利)
      - uses: softprops/action-gh-release@v2
        if: startsWith(github.ref, 'refs/tags/v')
        with:
          files: android/app/build/outputs/apk/release/app-release.apk
```

`git tag v0.1.0 && git push --tags` で Releases ページに APK が並ぶので、スマホから GitHub の Releases を開いて直接ダウンロード → インストールできます(Artifacts の zip 展開が要らなくなります)。

### 3.6 ハマりやすい点

- **base パス**: GitHub Pages は `/twixt_new/` 配下、Capacitor は `./` 相対でないと真っ白になる。上記の `CAP_BUILD` 切替で対処。
- **ONNX Runtime Web の wasm**: `onnxruntime-web` の `.wasm` ファイルを `public/ort/` にコピーし、`ort.env.wasm.wasmPaths = "./ort/"` を指定する。Capacitor の WebView は `https://localhost` 扱いなので `fetch` は通るが、パスは相対にする。
- **モデルサイズ**: 数十MBになる場合、PWA の precache 上限(`maximumFileSizeToCacheInBytes`)を上げる。APK 側は assets に同梱されるので問題なし。
- **Android の WebView バージョン**: WASM SIMD / マルチスレッドは端末の Chrome/WebView が新しければ使える。`ort.env.wasm.numThreads` は Capacitor では COOP/COEP ヘッダが無いため 1 になることがある → 単スレッドでも動く前提でシミュレーション数を調整。
- **targetSdk**: Capacitor が生成する `android/variables.gradle` の値をそのまま使う(Play Store に出さないので年次要求は気にしなくてよい)。
- **`android/` をコミットし忘れる**: `npx cap add android` の生成物は必ずコミット。`.gitignore` に `android/app/build/` と `android/.gradle/` だけ追加。

---

## 4. 完成の定義

1. GitHub に push すると PWA が GitHub Pages に、APK が Artifacts(またはReleases)に自動で出る。
2. スマホで機内モードにしても対局できる(モデル・wasm がキャッシュ/同梱されている)。
3. 最強レベルで twixtbot-ui(PC、trials 数百)と互角以上の手を打つ(同じモデルなので、探索量が同等なら同等の強さになる)。

## 5. 将来、もっと強くしたくなったら

フル版計画書の Stage 3〜5(自己対戦学習、蒸留、量子化)へ進む。エンジンは Web Worker の裏に閉じ込めてあるので、モデルの差し替えだけで済む設計にしておく。

---

## 参考資料

- [Updating to 7.0 | Capacitor Documentation](https://capacitorjs.com/docs/updating/7-0)(JDK 21、SDK 35 などの要件)
- [Automatic Capacitor Android build with GitHub actions | Capgo](https://capgo.app/blog/automatic-capacitor-android-build-github-action/)
- [Android Setup for Capacitor Apps | Capgo](https://capgo.app/blog/android-setup-for-capacitor-apps/)
- [How to build an APK from GitHub — step-by-step (2026)](https://corenna.dev/blog/how-to-build-apk-from-github)
- [capacitor-android-action - GitHub Marketplace](https://github.com/marketplace/actions/capacitor-android-action)
- [Automate Android App Builds and Releases with GitHub Actions | Medium](https://medium.com/@vafeen/automate-android-app-builds-and-releases-with-github-actions-3ecafeeb25cd)
- [GitHub - stevens68/twixtbot-ui](https://github.com/stevens68/twixtbot-ui)(移植元モデル)
- [GitHub - BonyJordan/twixtbot](https://github.com/BonyJordan/twixtbot)
