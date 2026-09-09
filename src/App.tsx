import { useState } from "react";
import type { Player } from "./core/board";
import { DEFAULT_SETTINGS, type GameSettings } from "./core/game";
import { AVAILABLE_LEVELS } from "./engine/levels";
import { GameScreen, type CpuConfig } from "./ui/GameScreen";

type Mode = "local" | "cpu";
type Screen =
  | { name: "home" }
  | { name: "setup"; mode: Mode }
  | { name: "game"; mode: Mode; settings: GameSettings; cpu?: CpuConfig };

const STORAGE_KEY = "twixt.settings.v1";

interface Prefs {
  settings: GameSettings;
  humanColor: Player | "random";
  level: number;
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { settings: DEFAULT_SETTINGS, humanColor: "white", level: 3, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { settings: DEFAULT_SETTINGS, humanColor: "white", level: 3 };
}

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "home" });
  const [prefs, setPrefsState] = useState<Prefs>(loadPrefs);
  const setPrefs = (p: Prefs) => {
    setPrefsState(p);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); } catch { /* ignore */ }
  };
  const { settings } = prefs;
  const setSettings = (s: GameSettings) => setPrefs({ ...prefs, settings: s });

  if (screen.name === "game") {
    return (
      <GameScreen
        key={`${screen.mode}-${JSON.stringify(screen.settings)}-${screen.cpu?.color}-${screen.cpu?.level}`}
        settings={screen.settings}
        cpu={screen.cpu}
        onExit={() => setScreen({ name: "home" })}
      />
    );
  }

  if (screen.name === "setup") {
    const isCpu = screen.mode === "cpu";
    const start = () => {
      let cpu: CpuConfig | undefined;
      if (isCpu) {
        const human: Player = prefs.humanColor === "random" ? (Math.random() < 0.5 ? "white" : "black") : prefs.humanColor;
        cpu = { color: human === "white" ? "black" : "white", level: prefs.level };
      }
      setScreen({ name: "game", mode: screen.mode, settings, cpu });
    };
    return (
      <div className="screen setup">
        <header className="bar"><button onClick={() => setScreen({ name: "home" })}>← 戻る</button><h2>{isCpu ? "CPU 対戦" : "ローカル対戦"}の設定</h2></header>
        {isCpu && (
          <>
            <label className="row">
              <span>あなたの色</span>
              <select value={prefs.humanColor} onChange={(e) => setPrefs({ ...prefs, humanColor: e.target.value as Prefs["humanColor"] })}>
                <option value="white">白(先手・上下)</option>
                <option value="black">黒(後手・左右)</option>
                <option value="random">ランダム</option>
              </select>
            </label>
            <label className="row">
              <span>CPU の強さ</span>
              <select value={prefs.level} onChange={(e) => setPrefs({ ...prefs, level: Number(e.target.value) })}>
                {AVAILABLE_LEVELS.map((l) => <option key={l.level} value={l.level}>Lv{l.level} {l.name}</option>)}
              </select>
            </label>
            <p className="muted small">{AVAILABLE_LEVELS.find((l) => l.level === prefs.level)?.description}</p>
          </>
        )}
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
        <button className="primary big" onClick={start}>対局開始</button>
      </div>
    );
  }

  return (
    <div className="screen home">
      <h1>TWIXT</h1>
      <p className="muted">白は上下、黒は左右を先につないだ方が勝ち</p>
      <button className="primary big" onClick={() => setScreen({ name: "setup", mode: "cpu" })}>CPU と対戦</button>
      <button className="big" onClick={() => setScreen({ name: "setup", mode: "local" })}>ローカル対戦</button>
      <button className="big" disabled>オンライン対戦(準備中)</button>
      <footer className="muted small">v{__APP_VERSION__} · CPU: twixtbot model (MIT) by Jordan Lampe / twixtbot-ui by stevens68</footer>
    </div>
  );
}
