// 開発用の隠しメニュー: エンジン同士の自動対局(端末上でレベル間の勝率を測る)
// 開き方: URL に ?calib=1 を付ける、またはホーム画面のバージョン表示を 5 回タップ
import { useEffect, useRef, useState } from "react";
import type { Player } from "../core/board";
import { applyMove, newGame, type GameSettings, type GameState } from "../core/game";
import { movesToStr } from "../core/notation";
import { getEngine, type EngineInfo } from "../engine/EngineClient";
import { LEVELS, levelSpec } from "../engine/levels";

interface GameLog {
  game: number;
  aIsWhite: boolean;
  winner: Player | "draw";
  plies: number;
  moves: string;
  /** 各側の合計思考時間(ms)と手数 */
  ms: Record<"a" | "b", number>;
  moveCount: Record<"a" | "b", number>;
  sims: Record<"a" | "b", number>;
}

const MAX_PLIES = 400;

export function CalibrationScreen({ settings, onExit }: { settings: GameSettings; onExit: () => void }) {
  const [levelA, setLevelA] = useState(3);
  const [levelB, setLevelB] = useState(4);
  const [games, setGames] = useState(10);
  const [strongestSec, setStrongestSec] = useState(5);
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<GameLog[]>([]);
  const [current, setCurrent] = useState<{ game: number; plies: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true;
    getEngine().ready().then((i) => alive && setInfo(i)).catch((e) => alive && setError(`エンジン読み込み失敗: ${(e as Error).message}`));
    return () => { alive = false; };
  }, []);

  const run = async () => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setRunning(true);
    setLogs([]);
    setError(null);
    const engine = getEngine();
    const timeMs = strongestSec * 1000;
    try {
      await engine.ready();
      for (let g = 0; g < games && !ctrl.signal.aborted; g++) {
        const aIsWhite = g % 2 === 0;
        const levelOf = (p: Player) => ((p === "white") === aIsWhite ? levelA : levelB);
        const log: GameLog = { game: g, aIsWhite, winner: "draw", plies: 0, moves: "", ms: { a: 0, b: 0 }, moveCount: { a: 0, b: 0 }, sims: { a: 0, b: 0 } };
        let state: GameState = newGame(settings);
        while (!state.result && state.moves.length < MAX_PLIES && !ctrl.signal.aborted) {
          setCurrent({ game: g, plies: state.moves.length });
          const side: "a" | "b" = (state.toMove === "white") === aIsWhite ? "a" : "b";
          const t0 = performance.now();
          const r = await engine.think(state.settings, state.moves, levelOf(state.toMove), ctrl.signal, timeMs);
          log.ms[side] += performance.now() - t0;
          log.moveCount[side]++;
          log.sims[side] += r.sims ?? 0;
          state = applyMove(state, r.move);
        }
        if (ctrl.signal.aborted) break;
        log.winner = state.result?.winner ?? "draw";
        log.plies = state.moves.length;
        log.moves = movesToStr(state.moves);
        setLogs((prev) => [...prev, log]);
      }
    } catch (e) {
      if (!ctrl.signal.aborted) setError(`エラー: ${(e as Error).message}`);
    } finally {
      setRunning(false);
      setCurrent(null);
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  const n = logs.length;
  const aWins = logs.filter((l) => l.winner !== "draw" && (l.winner === "white") === l.aIsWhite);
  const draws = logs.filter((l) => l.winner === "draw").length;
  const aWhiteGames = logs.filter((l) => l.aIsWhite).length;
  const aWhiteWins = aWins.filter((l) => l.aIsWhite).length;
  const score = n ? ((aWins.length + draws / 2) / n) * 100 : 0;
  const avgMs = (side: "a" | "b") => {
    const m = logs.reduce((s, l) => s + l.moveCount[side], 0);
    return m ? logs.reduce((s, l) => s + l.ms[side], 0) / m : 0;
  };
  const avgSims = (side: "a" | "b") => {
    const m = logs.reduce((s, l) => s + l.moveCount[side], 0);
    return m ? logs.reduce((s, l) => s + l.sims[side], 0) / m : 0;
  };
  const predictedSims = info ? Math.max(1, Math.floor((strongestSec * 1000) / Math.max(1, info.evalMs))) : null;
  const lv6 = levelSpec(6);

  const levelOptions = LEVELS.map((l) => <option key={l.level} value={l.level}>Lv{l.level} {l.name}</option>);

  return (
    <div className="screen setup">
      <header className="bar"><button onClick={onExit} disabled={running}>← 戻る</button><h2>レベル校正(自動対局)</h2></header>
      <p className="muted small">
        A と B を交互に白番・黒番で対局させ、A の勝率を測ります。この端末の実速度で動くので、Lv6(時間制)の実力も測れます。
        {info && ` / この端末: 1 評価 ${info.evalMs.toFixed(0)} ms`}
        {predictedSims !== null && `、Lv6 は ${strongestSec} 秒で約 ${predictedSims} 回読み${lv6.minSims ? `(最低 ${lv6.minSims} 回)` : ""}`}
      </p>
      <label className="row"><span>A</span><select value={levelA} disabled={running} onChange={(e) => setLevelA(Number(e.target.value))}>{levelOptions}</select></label>
      <label className="row"><span>B</span><select value={levelB} disabled={running} onChange={(e) => setLevelB(Number(e.target.value))}>{levelOptions}</select></label>
      <label className="row"><span>局数</span><select value={games} disabled={running} onChange={(e) => setGames(Number(e.target.value))}>{[2, 4, 10, 20, 40].map((g) => <option key={g} value={g}>{g}</option>)}</select></label>
      <label className="row"><span>Lv6 の思考時間</span><select value={strongestSec} disabled={running} onChange={(e) => setStrongestSec(Number(e.target.value))}>{[3, 5, 10, 20, 30].map((s) => <option key={s} value={s}>{s} 秒</option>)}</select></label>
      <div className="controls">
        {!running && <button className="primary" disabled={!info} onClick={run}>開始</button>}
        {running && <button className="danger" onClick={stop}>中止</button>}
        {current && <span className="muted small">第 {current.game + 1} 局 {current.plies} 手目…</span>}
      </div>
      {error && <div className="hint error">{error}</div>}
      {n > 0 && (
        <div className="card">
          <h3>Lv{levelA}(A) vs Lv{levelB}(B): A の勝率 {score.toFixed(0)}%({n} 局)</h3>
          <div className="small">A 白番 {aWhiteWins}/{aWhiteGames} 勝 · A 黒番 {aWins.length - aWhiteWins}/{n - aWhiteGames} 勝 · 引分 {draws}</div>
          <div className="small muted">1 手あたり: A {(avgMs("a") / 1000).toFixed(1)} s / {avgSims("a").toFixed(0)} 回読み · B {(avgMs("b") / 1000).toFixed(1)} s / {avgSims("b").toFixed(0)} 回読み</div>
          <details className="record">
            <summary>各局の棋譜</summary>
            {logs.map((l) => (
              <code key={l.game}>#{l.game + 1} A={l.aIsWhite ? "白" : "黒"} {l.winner === "draw" ? "引分" : `${l.winner === "white" ? "白" : "黒"}勝`}({l.plies} 手): {l.moves}</code>
            ))}
          </details>
        </div>
      )}
    </div>
  );
}
