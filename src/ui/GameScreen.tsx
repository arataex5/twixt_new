import { useEffect, useMemo, useRef, useState } from "react";
import type { LinkId, Player } from "../core/board";
import { applyMove, newGame, undo, type GameSettings, type GameState, type Move } from "../core/game";
import { movesToStr, pointToStr } from "../core/notation";
import { getEngine, type ThinkResult } from "../engine/EngineClient";
import { levelSpec } from "../engine/levels";
import { BoardSvg } from "./BoardSvg";

export interface CpuConfig {
  /** CPU が持つ色 */
  color: Player;
  level: number;
}

export interface GameScreenProps {
  settings: GameSettings;
  cpu?: CpuConfig;
  onExit: () => void;
}

const NAME: Record<Player, string> = { white: "白(上下)", black: "黒(左右)" };

export function GameScreen({ settings, cpu, onExit }: GameScreenProps) {
  const [state, setState] = useState<GameState>(() => newGame(settings));
  const [selected, setSelected] = useState<Set<LinkId>>(new Set());
  const [rotateForBlack, setRotateForBlack] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [engineStatus, setEngineStatus] = useState<string>(cpu ? "エンジン読み込み中…" : "");
  const [lastThink, setLastThink] = useState<ThinkResult | null>(null);
  const [showCandidates, setShowCandidates] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const humanColor: Player | "both" = cpu ? (cpu.color === "white" ? "black" : "white") : "both";

  const play = (m: Move) => {
    try {
      setState((s) => applyMove(s, m));
      setSelected(new Set());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // エンジン初期化
  useEffect(() => {
    if (!cpu) return;
    let alive = true;
    getEngine().ready().then((info) => {
      if (alive) setEngineStatus(`エンジン準備完了(読込 ${(info.loadMs / 1000).toFixed(1)}s / 1評価 ${info.evalMs.toFixed(0)}ms)`);
    }).catch((e) => alive && setEngineStatus(`エンジン読み込み失敗: ${(e as Error).message}`));
    return () => { alive = false; };
  }, [cpu]);

  // CPU の手番
  useEffect(() => {
    if (!cpu || state.result || state.toMove !== cpu.color) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setThinking(true);
    const engine = getEngine();
    engine.ready()
      .then(() => engine.think(state.settings, state.moves, cpu.level, ctrl.signal))
      .then((r) => {
        if (ctrl.signal.aborted) return;
        setLastThink(r);
        play(r.move);
      })
      .catch((e) => { if (!ctrl.signal.aborted) setError(`CPU エラー: ${(e as Error).message}`); })
      .finally(() => { if (abortRef.current === ctrl) { setThinking(false); abortRef.current = null; } });
    return () => { ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.moves.length, state.result, cpu?.color, cpu?.level]);

  const onPlace = (x: number, y: number) => {
    play({ type: "place", x, y, removeLinks: selected.size ? [...selected] : undefined });
  };

  const onToggleLink = (id: LinkId) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const doUndo = () => {
    abortRef.current?.abort();
    // CPU 戦では自分の手と CPU の手をセットで戻す
    const count = cpu && state.moves.length >= 2 && state.toMove !== cpu.color ? 2 : 1;
    setState((s) => undo(s, count));
    setSelected(new Set());
  };

  const rotated = rotateForBlack && state.toMove === "black" && !state.result;
  const status = useMemo(() => {
    if (state.result) {
      if (state.result.winner === "draw") return "引き分け";
      return `${NAME[state.result.winner]} の勝ち(${state.result.reason === "connect" ? "連結" : "投了"})`;
    }
    const who = cpu && state.toMove === cpu.color ? "CPU" : cpu ? "あなた" : "";
    return `${NAME[state.toMove]} の番${who ? `(${who})` : ""}${thinking ? " 思考中…" : ""}`;
  }, [state, cpu, thinking]);

  // スワップ(パイルール)の説明: 初手のペグは主対角線で鏡映されて黒の駒になる
  const swapNotice = useMemo(() => {
    const last = state.moves[state.moves.length - 1];
    const first = state.moves[0];
    if (!last || last.type !== "swap" || !first || first.type !== "place") return null;
    const from = pointToStr(first.x, first.y), to = pointToStr(first.y, first.x);
    const who = cpu ? (cpu.color === "black" ? "CPU" : "あなた") : "後手";
    return `${who}がスワップしました: 初手 ${from}(白) は ${to}(黒) に鏡映され、後手の駒になりました。白の番です。`;
  }, [state.moves, cpu]);

  const overlay = useMemo(() => {
    if (!showCandidates || !lastThink) return undefined;
    const m = new Map<number, number>();
    const max = Math.max(...lastThink.candidates.map((c) => c.p), 1e-9);
    for (const c of lastThink.candidates) m.set(c.cell, c.p / max);
    return m;
  }, [showCandidates, lastThink]);

  const interactive: Player | "both" | null = state.result ? null : thinking ? null : humanColor;
  const canHumanSwap = state.canSwap && !state.result && (humanColor === "both" || humanColor === "black");

  return (
    <div className="screen game">
      <header className="bar">
        <button onClick={onExit}>← 戻る</button>
        <div className={`status ${state.result ? "over" : state.toMove}`}>{status}</div>
        <span className="muted">{state.moves.length} 手</span>
      </header>

      <BoardSvg
        state={state}
        interactive={interactive}
        onPlace={onPlace}
        selectedLinks={selected}
        onToggleLink={onToggleLink}
        rotated={rotated}
        overlay={overlay}
      />

      {selected.size > 0 && (
        <div className="hint">選択した自リンク {selected.size} 本を外して着手します(もう一度タップで解除)</div>
      )}
      {error && <div className="hint error">{error}</div>}
      {swapNotice && <div className="hint swap">{swapNotice}</div>}
      {cpu && (
        <div className="muted small">
          {engineStatus}
          {lastThink && ` / CPU評価 ${(lastThink.value * 100).toFixed(0)}%(CPU視点) ${lastThink.evalMs.toFixed(0)}ms`}
          {" / Lv"}{cpu.level} {levelSpec(cpu.level).name}
        </div>
      )}

      <div className="controls">
        {canHumanSwap && (
          <button className="primary" onClick={() => play({ type: "swap" })}>スワップ(パイルール)</button>
        )}
        <button disabled={state.moves.length === 0} onClick={doUndo}>待った</button>
        <button disabled={!!state.result} onClick={() => { if (confirm("投了しますか?")) { abortRef.current?.abort(); play({ type: "resign" }); } }}>投了</button>
        {!cpu && <button disabled={!!state.result} onClick={() => { if (confirm("引き分けにしますか?")) play({ type: "draw" }); }}>引き分け</button>}
        {!cpu && <label className="toggle"><input type="checkbox" checked={rotateForBlack} onChange={(e) => setRotateForBlack(e.target.checked)} /> 黒番で盤を回転</label>}
        {cpu && <label className="toggle"><input type="checkbox" checked={showCandidates} onChange={(e) => setShowCandidates(e.target.checked)} /> CPUの候補手を表示</label>}
      </div>

      <details className="record">
        <summary>棋譜</summary>
        <code>{movesToStr(state.moves) || "(まだ手がありません)"}</code>
        <button onClick={() => navigator.clipboard?.writeText(movesToStr(state.moves))}>コピー</button>
      </details>

      {state.result && (
        <div className="result">
          <strong>{status}</strong>
          <button className="primary" onClick={() => { setState(newGame(settings)); setSelected(new Set()); setLastThink(null); }}>もう一度</button>
        </div>
      )}
    </div>
  );
}
