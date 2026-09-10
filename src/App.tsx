import { useState } from "react";
import type { Player } from "./core/board";
import { DEFAULT_SETTINGS, replay, type GameSettings, type Move } from "./core/game";
import { strToMoves } from "./core/notation";
import { loadInProgress } from "./store/history";
import { HistoryScreen } from "./ui/HistoryScreen";
import { ReplayScreen } from "./ui/ReplayScreen";
import { OnlineScreen } from "./ui/OnlineScreen";
import { AVAILABLE_LEVELS } from "./engine/levels";
import { GameScreen, type CpuConfig } from "./ui/GameScreen";
import { CalibScreen, parseCalibParams } from "./ui/CalibScreen";

type Mode = "local" | "cpu";
type Screen =
  | { name: "home" }
  | { name: "setup"; mode: Mode }
  | { name: "game"; mode: Mode; settings: GameSettings; cpu?: CpuConfig; initialMoves?: Move[]; startedAt?: string; nonce?: number }
  | { name: "history" }
  | { name: "online" }
  | { name: "calib" }
  | { name: "replay"; title: string; settings: GameSettings; moves: Move[] };

const STORAGE_KEY = "twixt.settings.v1";

interface Prefs {
  settings: GameSettings;
  humanColor: Player | "random";
  level: number;
  strongestSec: number;
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { settings: DEFAULT_SETTINGS, humanColor: "white", level: 3, strongestSec: 5, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { settings: DEFAULT_SETTINGS, humanColor: "white", level: 3, strongestSec: 5 };
}

function replayToMove(settings: GameSettings, moves: Move[]): Player {
  // 手番を求めるだけなので core の replay を使う
  return replay(settings, moves).toMove;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>(() => {
    const q = new URLSearchParams(location.search);
    if (q.get("calib") === "1") return { name: "calib" };
    return q.get("room") ? { name: "online" } : { name: "home" };
  });
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
        key={`${screen.mode}-${JSON.stringify(screen.settings)}-${JSON.stringify(screen.cpu ?? null)}-${screen.nonce ?? 0}`}
        settings={screen.settings}
        cpu={screen.cpu}
        initialMoves={screen.initialMoves}
        startedAt={screen.startedAt}
        onExit={() => setScreen({ name: "home" })}
      />
    );
  }

  if (screen.name === "calib") {
    return <CalibScreen params={parseCalibParams(location.search)} onExit={() => setScreen({ name: "home" })} />;
  }

  if (screen.name === "online") {
    return <OnlineScreen settings={settings} onSettingsChange={setSettings} onExit={() => setScreen({ name: "home" })} />;
  }

  if (screen.name === "history") {
    return <HistoryScreen onExit={() => setScreen({ name: "home" })} onOpen={(title, s, moves) => setScreen({ name: "replay", title, settings: s, moves })} />;
  }

  if (screen.name === "replay") {
    return (
      <ReplayScreen
        title={screen.title}
        settings={screen.settings}
        moves={screen.moves}
        onExit={() => setScreen({ name: "history" })}
        onPlayFrom={(moves) => {
          // 手番側が人間、相手が CPU(現在のレベル設定)
          const st = replayToMove(screen.settings, moves);
          const cpu: CpuConfig = { color: st === "white" ? "black" : "white", level: prefs.level, strongestTimeMs: prefs.strongestSec * 1000 };
          setScreen({ name: "game", mode: "cpu", settings: screen.settings, cpu, initialMoves: moves, nonce: Date.now() });
        }}
      />
    );
  }

  if (screen.name === "setup") {
    const isCpu = screen.mode === "cpu";
    const start = () => {
      let cpu: CpuConfig | undefined;
      if (isCpu) {
        const human: Player = prefs.humanColor === "random" ? (Math.random() < 0.5 ? "white" : "black") : prefs.humanColor;
        cpu = { color: human === "white" ? "black" : "white", level: prefs.level, strongestTimeMs: prefs.strongestSec * 1000 };
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
            {prefs.level === 6 && (
              <label className="row">
                <span>最強レベルの思考時間</span>
                <select value={prefs.strongestSec} onChange={(e) => setPrefs({ ...prefs, strongestSec: Number(e.target.value) })}>
                  {[3, 5, 10, 20, 30, 60].map((s) => <option key={s} value={s}>{s} 秒</option>)}
                </select>
              </label>
            )}
          </>
        )}
        <label className="row">
          <span>パイルール(スワップ)<br /><small className="muted">後手は先手の初手を「奪う」ことができる。初手は主対角線で鏡映され黒の駒になる</small></span>
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

  const inProgress = loadInProgress();
  const resume = () => {
    const g = loadInProgress();
    if (!g) return;
    setScreen({ name: "game", mode: g.mode, settings: g.settings, cpu: g.cpu, initialMoves: strToMoves(g.moves), startedAt: g.startedAt, nonce: Date.now() });
  };

  return (
    <div className="screen home">
      <h1>TWIXT</h1>
      <p className="muted">白は上下、黒は左右を先につないだ方が勝ち</p>
      {inProgress && (
        <button className="primary big" onClick={resume}>
          続きから({inProgress.mode === "cpu" && inProgress.cpu ? `CPU Lv${inProgress.cpu.level}` : "ローカル対戦"} · {inProgress.moves.split(/\s+/).filter(Boolean).length} 手目)
        </button>
      )}
      <button className={`${inProgress ? "" : "primary "}big`} onClick={() => setScreen({ name: "setup", mode: "cpu" })}>CPU と対戦</button>
      <button className="big" onClick={() => setScreen({ name: "setup", mode: "local" })}>ローカル対戦</button>
      <button className="big" onClick={() => setScreen({ name: "online" })}>オンライン対戦(ルームID)</button>
      <button className="big" onClick={() => setScreen({ name: "history" })}>対局履歴・棋譜再生</button>
      <footer className="muted small">v{__APP_VERSION__} · CPU: twixtbot model (MIT) by Jordan Lampe / twixtbot-ui by stevens68</footer>
    </div>
  );
}
