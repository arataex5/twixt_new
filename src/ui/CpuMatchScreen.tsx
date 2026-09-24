// CPU 同士の対戦。観戦・レベル校正の両方に使う。
// URL に ?calib=1 を付けると設定を引き継いで自動で開始する:
//   ?calib=1&a=5&b=6&n=10&t=10000&pie=1&auto=1
import { useEffect, useRef, useState } from "react";
import type { Player } from "../core/board";
import { applyMove, newGame, type GameSettings, type GameState, type Move } from "../core/game";
import { movesToStr, strToMoves } from "../core/notation";
import { getEngine } from "../engine/EngineClient";
import { AVAILABLE_LEVELS, levelSpec } from "../engine/levels";
import { addRecord } from "../store/history";
import { BoardSvg } from "./BoardSvg";

export interface CpuMatchConfig {
  whiteLevel: number;
  blackLevel: number;
  /** 対局数。色は 1 局ごとに入れ替える */
  games: number;
  /** Lv6 の思考時間(秒) */
  strongestSec: number;
  settings: GameSettings;
  /** 1 局の最大手数(安全弁) */
  maxPlies: number;
}

export const DEFAULT_MATCH: CpuMatchConfig = {
  whiteLevel: 3, blackLevel: 6, games: 1, strongestSec: 10,
  settings: { pieRule: true, rules: "standard" }, maxPlies: 400,
};

export function parseCalibParams(search: string): { config: CpuMatchConfig; autoStart: boolean } {
  const q = new URLSearchParams(search);
  const num = (k: string, d: number) => { const v = Number(q.get(k)); return Number.isFinite(v) && q.get(k) !== null ? v : d; };
  return {
    config: {
      whiteLevel: num("a", DEFAULT_MATCH.whiteLevel),
      blackLevel: num("b", DEFAULT_MATCH.blackLevel),
      games: num("n", DEFAULT_MATCH.games),
      strongestSec: Math.round(num("t", 10000) / 1000),
      settings: { pieRule: q.get("pie") !== "0", rules: q.get("rules") === "pp" ? "pp" : "standard" },
      maxPlies: num("max", DEFAULT_MATCH.maxPlies),
    },
    autoStart: q.get("auto") === "1",
  };
}

interface MatchRecord {
  index: number;
  whiteLevel: number;
  blackLevel: number;
  winner: Player | "draw" | null;
  winnerLevel: number | null;
  plies: number;
  msByLevel: Record<number, number[]>;
  moves: string;
  settings: GameSettings;
  aborted?: boolean;
  error?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function stats(xs: number[]) {
  if (xs.length === 0) return { n: 0, avg: 0, max: 0 };
  return { n: xs.length, avg: xs.reduce((s, x) => s + x, 0) / xs.length, max: Math.max(...xs) };
}

export interface CpuMatchScreenProps {
  initial?: CpuMatchConfig;
  autoStart?: boolean;
  onExit: () => void;
  onReplay: (title: string, settings: GameSettings, moves: Move[]) => void;
}

export function CpuMatchScreen({ initial, autoStart, onExit, onReplay }: CpuMatchScreenProps) {
  const [cfg, setCfg] = useState<CpuMatchConfig>(initial ?? DEFAULT_MATCH);
  const [records, setRecords] = useState<MatchRecord[]>([]);
  const [current, setCurrent] = useState<{ index: number; state: GameState; whiteLevel: number; blackLevel: number } | null>(null);
  const [phase, setPhase] = useState<"idle" | "running" | "paused" | "done">("idle");
  const [status, setStatus] = useState("エンジン読み込み中…");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const stopRef = useRef(false);
  const pauseRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  useEffect(() => {
    getEngine().ready()
      .then((info) => setStatus(`エンジン準備完了(1 評価 ${info.evalMs.toFixed(0)}ms)`))
      .catch((e) => setStatus(`エンジン読み込み失敗: ${(e as Error).message}`));
  }, []);

  // 画面を離れたら必ず止める
  useEffect(() => () => { stopRef.current = true; abortRef.current?.abort(); }, []);

  const stop = () => {
    stopRef.current = true;
    pauseRef.current = false;
    abortRef.current?.abort();
    setStatus("中断しました");
    setPhase("done");
  };

  const run = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    stopRef.current = false;
    pauseRef.current = false;
    setPhase("running");
    const engine = getEngine();
    engine.onProgress = (_id, done, total) => { if (!stopRef.current) setProgress({ done, total }); };
    try {
      await engine.ready();
    } catch (e) {
      setStatus(`エンジン読み込み失敗: ${(e as Error).message}`);
      runningRef.current = false;
      setPhase("done");
      return;
    }

    const results: MatchRecord[] = [];
    const c = cfgRef.current;
    for (let g = 0; g < c.games; g++) {
      if (stopRef.current) break;
      // 偶数局は設定どおり、奇数局は色を入れ替える
      const whiteLevel = g % 2 === 0 ? c.whiteLevel : c.blackLevel;
      const blackLevel = g % 2 === 0 ? c.blackLevel : c.whiteLevel;
      let state = newGame(c.settings);
      const msByLevel: Record<number, number[]> = { [c.whiteLevel]: [], [c.blackLevel]: [] };
      const rec: MatchRecord = {
        index: g + 1, whiteLevel, blackLevel, winner: null, winnerLevel: null,
        plies: 0, msByLevel, moves: "", settings: c.settings,
      };
      const startedAt = new Date().toISOString();
      setCurrent({ index: g + 1, state, whiteLevel, blackLevel });

      while (!state.result && state.moves.length < c.maxPlies) {
        if (stopRef.current) break;
        // 一時停止中はここで待つ(中断はいつでも効く)
        while (pauseRef.current && !stopRef.current) {
          setPhase("paused");
          setStatus(`一時停止中(第 ${g + 1} 局 ${state.moves.length} 手目)`);
          await sleep(150);
        }
        if (stopRef.current) break;
        setPhase("running");

        const level = state.toMove === "white" ? whiteLevel : blackLevel;
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        const t0 = performance.now();
        setStatus(`第 ${g + 1} 局 ${state.moves.length + 1} 手目 — ${state.toMove === "white" ? "白" : "赤"} Lv${level} が考えています`);
        try {
          const r = await engine.think(state.settings, state.moves, level, ctrl.signal, c.strongestSec * 1000);
          (msByLevel[level] ??= []).push(performance.now() - t0);
          state = applyMove(state, r.move);
          setCurrent({ index: g + 1, state, whiteLevel, blackLevel });
          setProgress(null);
        } catch (e) {
          if (stopRef.current || ctrl.signal.aborted) { rec.aborted = true; break; }
          rec.error = (e as Error).message;
          break;
        } finally {
          abortRef.current = null;
        }
      }

      rec.plies = state.moves.length;
      rec.moves = movesToStr(state.moves);
      if (state.result) {
        rec.winner = state.result.winner;
        rec.winnerLevel = state.result.winner === "white" ? whiteLevel : state.result.winner === "black" ? blackLevel : null;
        // 終局した対局だけ履歴に保存する
        addRecord({
          startedAt, endedAt: new Date().toISOString(),
          mode: "cpuvscpu", settings: c.settings,
          cpu: { color: "white", level: whiteLevel, strongestTimeMs: c.strongestSec * 1000 },
          cpu2: { color: "black", level: blackLevel, strongestTimeMs: c.strongestSec * 1000 },
          moves: rec.moves, result: state.result,
        });
      } else if (!rec.error) {
        rec.aborted = true;
      }
      results.push(rec);
      setRecords([...results]);
      if (stopRef.current) break;
    }

    runningRef.current = false;
    setProgress(null);
    setPhase("done");
    setStatus(stopRef.current ? "中断しました" : "全局終了");
  };

  const finished = records.filter((r) => !r.error && r.winner !== null);
  const winsA = finished.filter((r) => r.winnerLevel === cfg.whiteLevel).length;
  const winsB = finished.filter((r) => r.winnerLevel === cfg.blackLevel).length;
  const draws = finished.filter((r) => r.winner === "draw").length;
  const msA = stats(records.flatMap((r) => r.msByLevel[cfg.whiteLevel] ?? []));
  const msB = stats(records.flatMap((r) => r.msByLevel[cfg.blackLevel] ?? []));
  const label = (l: number) => `Lv${l} ${levelSpec(l).name}`;
  const busy = phase === "running" || phase === "paused";

  useEffect(() => {
    if (autoStart) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const summary = {
    config: cfg,
    games: records.length,
    [`Lv${cfg.whiteLevel}`]: { wins: winsA, avgMs: Math.round(msA.avg), maxMs: Math.round(msA.max), moves: msA.n },
    [`Lv${cfg.blackLevel}`]: { wins: winsB, avgMs: Math.round(msB.avg), maxMs: Math.round(msB.max), moves: msB.n },
    draws,
    records: records.map((r) => ({ index: r.index, white: r.whiteLevel, black: r.blackLevel, winner: r.winner, plies: r.plies, aborted: r.aborted, error: r.error })),
  };

  return (
    <div className="screen calib">
      <header className="bar">
        <button onClick={() => { stop(); onExit(); }}>← 戻る</button>
        <h2>CPU 同士の対戦</h2>
      </header>

      <label className="row">
        <span>白(先手・上下)</span>
        <select disabled={busy} value={cfg.whiteLevel} onChange={(e) => setCfg({ ...cfg, whiteLevel: Number(e.target.value) })}>
          {AVAILABLE_LEVELS.map((l) => <option key={l.level} value={l.level}>{label(l.level)}</option>)}
        </select>
      </label>
      <label className="row">
        <span>赤(後手・左右)</span>
        <select disabled={busy} value={cfg.blackLevel} onChange={(e) => setCfg({ ...cfg, blackLevel: Number(e.target.value) })}>
          {AVAILABLE_LEVELS.map((l) => <option key={l.level} value={l.level}>{label(l.level)}</option>)}
        </select>
      </label>
      <label className="row">
        <span>対局数<br /><small className="muted">2 局以上なら 1 局ごとに色を入れ替える</small></span>
        <select disabled={busy} value={cfg.games} onChange={(e) => setCfg({ ...cfg, games: Number(e.target.value) })}>
          {[1, 2, 4, 6, 10, 20].map((n) => <option key={n} value={n}>{n} 局</option>)}
        </select>
      </label>
      <label className="row">
        <span>Lv6 の思考時間</span>
        <select disabled={busy} value={cfg.strongestSec} onChange={(e) => setCfg({ ...cfg, strongestSec: Number(e.target.value) })}>
          {[3, 5, 10, 20, 30, 60].map((s) => <option key={s} value={s}>{s} 秒</option>)}
        </select>
      </label>
      <label className="row">
        <span>パイルール(スワップ)</span>
        <input type="checkbox" disabled={busy} checked={cfg.settings.pieRule} onChange={(e) => setCfg({ ...cfg, settings: { ...cfg.settings, pieRule: e.target.checked } })} />
      </label>

      <div className="controls">
        {!busy && <button className="primary" onClick={() => { setRecords([]); void run(); }}>{records.length ? "もう一度始める" : "開始"}</button>}
        {phase === "running" && <button onClick={() => { pauseRef.current = true; }}>一時停止</button>}
        {phase === "paused" && <button className="primary" onClick={() => { pauseRef.current = false; }}>再開</button>}
        {busy && <button className="danger" onClick={stop}>中断</button>}
      </div>

      <p className="muted small">
        {status}
        {progress && progress.done > 0 ? ` · ${progress.done} 回読み` : ""}
      </p>
      <p className="muted small">中断はいつでも押せます(考え中でもすぐ止まります)。一時停止は今の 1 手を打ち終えてから止まります。</p>

      {records.length > 0 && (
        <>
          <table className="calib-table">
            <thead><tr><th></th><th>勝ち</th><th>1手平均</th><th>1手最大</th><th>手数</th></tr></thead>
            <tbody>
              <tr><td>{label(cfg.whiteLevel)}</td><td>{winsA}</td><td>{(msA.avg / 1000).toFixed(1)}s</td><td>{(msA.max / 1000).toFixed(1)}s</td><td>{msA.n}</td></tr>
              <tr><td>{label(cfg.blackLevel)}</td><td>{winsB}</td><td>{(msB.avg / 1000).toFixed(1)}s</td><td>{(msB.max / 1000).toFixed(1)}s</td><td>{msB.n}</td></tr>
            </tbody>
          </table>
          {draws > 0 && <p className="muted small">引き分け {draws}</p>}
          <ul className="history">
            {records.map((r) => (
              <li key={r.index} className="history-item">
                <div className="history-main">
                  <div>
                    <strong>
                      {r.error ? `エラー: ${r.error}`
                        : r.aborted ? "中断"
                          : r.winner === "draw" ? "引き分け"
                            : r.winner ? `${r.winner === "white" ? "白" : "赤"}(Lv${r.winnerLevel})の勝ち` : "未終了"}
                    </strong>{" "}
                    <span className="muted small">{r.plies} 手</span>
                  </div>
                  <div className="muted small">第{r.index}局 白 {label(r.whiteLevel)} / 赤 {label(r.blackLevel)}</div>
                </div>
                <button className="small" disabled={!r.moves} onClick={() => onReplay(`CPU対戦 白Lv${r.whiteLevel} vs 赤Lv${r.blackLevel}`, r.settings, strToMoves(r.moves))}>再生</button>
              </li>
            ))}
          </ul>
          <p className="muted small">終局した対局は「対局履歴」にも自動保存されます(中断した対局は上の「再生」からのみ見られます)。</p>
        </>
      )}

      {current && (
        <div className="board-wrap">
          <BoardSvg state={current.state} interactive={null} selectedLinks={new Set()} onPlace={() => {}} onToggleLink={() => {}} />
        </div>
      )}

      <details className="record">
        <summary>結果 JSON(校正用)</summary>
        <textarea readOnly rows={10} value={JSON.stringify(summary, null, 1)} />
      </details>
    </div>
  );
}
