import { useState } from "react";
import { DEFAULT_SETTINGS, type GameSettings } from "./core/game";
import { GameScreen } from "./ui/GameScreen";

type Screen = { name: "home" } | { name: "setup"; mode: "local" } | { name: "game"; mode: "local"; settings: GameSettings };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "home" });
  const [settings, setSettings] = useState<GameSettings>(DEFAULT_SETTINGS);

  if (screen.name === "game") {
    return <GameScreen key={JSON.stringify(screen.settings)} settings={screen.settings} onExit={() => setScreen({ name: "home" })} />;
  }

  if (screen.name === "setup") {
    return (
      <div className="screen setup">
        <header className="bar"><button onClick={() => setScreen({ name: "home" })}>← 戻る</button><h2>ローカル対戦の設定</h2></header>
        <label className="row">
          <span>パイルール(スワップ)</span>
          <input type="checkbox" checked={settings.pieRule} onChange={(e) => setSettings({ ...settings, pieRule: e.target.checked })} />
        </label>
        <label className="row">
          <span>ルール</span>
          <select value={settings.rules} onChange={(e) => setSettings({ ...settings, rules: e.target.value as GameSettings["rules"] })}>
            <option value="standard">標準(リンク除去あり・交差不可)</option>
            <option value="pp">PP(自リンク交差可・除去なし)</option>
          </select>
        </label>
        <button className="primary big" onClick={() => setScreen({ name: "game", mode: "local", settings })}>対局開始</button>
      </div>
    );
  }

  return (
    <div className="screen home">
      <h1>TWIXT</h1>
      <p className="muted">白は上下、黒は左右を先につないだ方が勝ち</p>
      <button className="primary big" onClick={() => setScreen({ name: "setup", mode: "local" })}>ローカル対戦</button>
      <button className="big" disabled>CPU と対戦(準備中)</button>
      <button className="big" disabled>オンライン対戦(準備中)</button>
      <footer className="muted small">v{__APP_VERSION__}</footer>
    </div>
  );
}
