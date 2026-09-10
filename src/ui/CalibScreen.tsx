// レベル校正モード。URL に ?calib=1 を付けると起動する(開発・検証用、メニューからは出さない)。
//   ?calib=1&a=5&b=6&n=10&t=10000&pie=1
//   a, b: 対戦させるレベル / n: 局数 / t: Lv6 の思考時間(ms) / pie: パイルール(1=あり)
// 色は 1 局ごとに入れ替える。結果は画面に表示し、localStorage(twixt.calib.results)にも追記する。
import { useEffect, useRef, useState } from "react";
import type { Player } from "../core/board";
import { applyMove, newGame, type GameSettings, type GameState } from "../core/game";
import { movesToStr } from "../core/notation";
import { getEngine } from "../engine/EngineClient";
import { LEVELS } from "../engine/levels";
import { BoardSvg } from "./BoardSvg";

interface GameRecord {
  index: number;
  whiteLevel: number;
  blackLevel: number;
  winner: Player | "draw" | null;
  winnerLevel: number | null;
  plies: number;
  msByLevel: Record<number, number[]>;
  moves: string;
  error?: string;
}

export interface CalibParams {
  a: number;
  b: number;
  n: number;
  strongestTimeMs: number;
  settings: GameSettings;
  /** 1 局の最大手数(安全弁) */
  maxPlies: number;
}

export function parseCalibParams(search: string): CalibParams {
  const q = new URLSearchParams(search);
  const num = (k: string, d: number) => { const v = Number(q.get(k)); return Number.isFinite(v) && q.get(k) !== null ? v : d; };
  return {
    a: num("a", 5),
    b: num("b", 6),
    n: num("n", 10),
    strongestTimeMs: num("t", 10000),
    settings: { pieRule: q.get("pie") === "1", rules: q.get("rules") === "pp" ? "pp" : "standard" },
    maxPlies: num("max", 400),
  };
}

const STORAGE_KEY = "twixt.calib.results";

function stats(xs: number[]) {
  if (xs.length === 0) return { n: 0, avg: 0, max: 0 };
  return { n: xs.length, avg: xs.reduce((s, x) => s + x, 0) / xs.length, max: Math.max(...xs) };
}

export function CalibScreen({ params, onExit }: { params: CalibParams; onExit: () => void }) {
  const [records, setRecords] = useState<GameRecord[]>([]);
  const [current, setCurrent] = useState<{ index: number; state: GameState; whiteLevel: number; blackLevel: number } | null>(null);
  const [status, setStatus] = useState("エンジン読み込み中…");
  const [running, setRunning] = useState(false);
  const stopRef = useRef(false);

  const run = async () => {
    setRunning(true);
    stopRef.current = false;
    const engine = getEngine();
    const info = await engine.ready();
    setStatus(`エンジン準備完了(読込 ${(info.loadMs / 1000).toFixed(1)}s / 1評価 ${info.evalMs.toFixed(0)}ms)`);
    const results: GameRecord[] = [];
    for (let g = 0; g < params.n; g++) {
      if (stopRef.current) break;
      // 偶数局は a が白、奇数局は b が白
      const whiteLevel = g % 2 === 0 ? params.a : params.b;
      const blackLevel = g % 2 === 0 ? params.b : params.a;
      let state = newGame(params.settings);
      const msByLevel: Record<number, number[]> = { [params.a]: [], [params.b]: [] };
      const rec: GameRecord = { index: g + 1, whiteLevel, blackLevel, winner: null, winnerLevel: null, plies: 0, msByLevel, moves: "" };
      setCurrent({ index: g + 1, state, whiteLevel, blackLevel });
      try {
        while (!state.result && state.moves.length < params.maxPlies) {
          if (stopRef.current) break;
          const level = state.toMove === "white" ? whiteLevel : blackLevel;
          const t0 = performance.now();
          const r = await engine.think(state.settings, state.moves, level, undefined, params.strongestTimeMs);
          msByLevel[level].push(performance.now() - t0);
          state = applyMove(state, r.move);
          setCurrent({ index: g + 1, state, whiteLevel, blackLevel });
          setStatus(`第 ${g + 1} 局 ${state.moves.length} 手目(白 Lv${whiteLevel} / 黒 Lv${blackLevel})`);
        }
        rec.winner = state.result ? state.result.winner : null;
        rec.winnerLevel = rec.winner === "white" ? whiteLevel : rec.winner === "black" ? blackLevel : null;
      } catch (e) {
        rec.error = (e as Error).message;
      }
      rec.plies = state.moves.length;
      rec.moves = movesToStr(state.moves);
      results.push(rec);
      setRecords([...results]);
      try {
        const prev = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown[];
        prev.push({ at: new Date().toISOString(), ua: navigator.userAgent, params, ...rec });
        localStorage.setItem(STORAGE_KEY, JSON.stringify(prev.slice(-200)));
      } catch { /* ignore */ }
    }
    setRunning(false);
    setStatus(stopRef.current ? "中断しました" : "全局終了");
  };

  useEffect(() => {
    getEngine().ready().then((info) => setStatus(`エンジン準備完了(読込 ${(info.loadMs / 1000).toFixed(1)}s / 1評価 ${info.evalMs.toFixed(0)}ms)。「開始」を押してください`))
      .catch((e) => setStatus(`エンジン読み込み失敗: ${(e as Error).message}`));
  }, []);

  const finished = records.filter((r) => !r.error && r.winner !== null);
  const winsA = finished.filter((r) => r.winnerLevel === params.a).length;
  const winsB = finished.filter((r) => r.winnerLevel === params.b).length;
  const draws = records.filter((r) => !r.error && r.winner === "draw").length;
  const msA = stats(records.flatMap((r) => r.msByLevel[params.a] ?? []));
  const msB = stats(records.flatMap((r) => r.msByLevel[params.b] ?? []));
  const name = (l: number) => `Lv${l} ${LEVELS.find((x) => x.level === l)?.name ?? ""}`;

  const summary = {
    params,
    games: records.length,
    [`Lv${params.a}`]: { wins: winsA, avgMs: Math.round(msA.avg), maxMs: Math.round(msA.max), moves: msA.n },
    [`Lv${params.b}`]: { wins: winsB, avgMs: Math.round(msB.avg), maxMs: Math.round(msB.max), moves: msB.n },
    draws,
    records: records.map((r) => ({ index: r.index, white: r.whiteLevel, black: r.blackLevel, winner: r.winner, winnerLevel: r.winnerLevel, plies: r.plies, error: r.error })),
  };

  return (
    <div className="screen calib">
      <header className="bar"><button onClick={onExit}>← 戻る</button><h2>レベル校正 {name(params.a)} vs {name(params.b)}</h2></header>
      <p className="muted small">{params.n} 局・色は毎局交代・パイルール{params.settings.pieRule ? "あり" : "なし"}・Lv6 思考時間 {params.strongestTimeMs / 1000} 秒</p>
      <div className="controls">
        <button className="primary" disabled={running} onClick={run}>開始</button>
        <button disabled={!running} onClick={() => { stopRef.current = true; }}>中断</button>
      </div>
      <p className="muted">{status}</p>
      <table className="calib-table">
        <thead><tr><th></th><th>勝ち</th><th>1手平均</th><th>1手最大</th><th>手数</th></tr></thead>
        <tbody>
          <tr><td>{name(params.a)}</td><td>{winsA}</td><td>{(msA.avg / 1000).toFixed(2)}s</td><td>{(msA.max / 1000).toFixed(2)}s</td><td>{msA.n}</td></tr>
          <tr><td>{name(params.b)}</td><td>{winsB}</td><td>{(msB.avg / 1000).toFixed(2)}s</td><td>{(msB.max / 1000).toFixed(2)}s</td><td>{msB.n}</td></tr>
        </tbody>
      </table>
      {draws > 0 && <p className="muted small">引き分け {draws}</p>}
      <ol className="calib-list">
        {records.map((r) => (
          <li key={r.index}>
            第{r.index}局 白 Lv{r.whiteLevel} / 黒 Lv{r.blackLevel} → {r.error ? `エラー: ${r.error}` : r.winner === "draw" ? "引き分け" : r.winner ? `${r.winner === "white" ? "白" : "黒"}(Lv${r.winnerLevel}) の勝ち` : "未終了"}({r.plies} 手)
          </li>
        ))}
      </ol>
      {current && (
        <div className="board-wrap">
          <BoardSvg state={current.state} interactive={null} selectedLinks={new Set()} onPlace={() => {}} onToggleLink={() => {}} />
        </div>
      )}
      <details>
        <summary>JSON(コピー用)</summary>
        <textarea id="calib-json" readOnly rows={12} value={JSON.stringify(summary, null, 1)} />
      </details>
    </div>
  );
}
