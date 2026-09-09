import { useMemo, useState } from "react";
import type { LinkId, Player } from "../core/board";
import { applyMove, newGame, undo, type GameSettings, type GameState, type Move } from "../core/game";
import { movesToStr } from "../core/notation";
import { BoardSvg } from "./BoardSvg";

export interface GameScreenProps {
  settings: GameSettings;
  /** ローカル対戦: "both"。CPU 戦などは後で拡張 */
  onExit: () => void;
}

const NAME: Record<Player, string> = { white: "白(上下)", black: "黒(左右)" };

export function GameScreen({ settings, onExit }: GameScreenProps) {
  const [state, setState] = useState<GameState>(() => newGame(settings));
  const [selected, setSelected] = useState<Set<LinkId>>(new Set());
  const [rotateForBlack, setRotateForBlack] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const play = (m: Move) => {
    try {
      setState((s) => applyMove(s, m));
      setSelected(new Set());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

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

  const rotated = rotateForBlack && state.toMove === "black" && !state.result;
  const status = useMemo(() => {
    if (state.result) {
      if (state.result.winner === "draw") return "引き分け";
      return `${NAME[state.result.winner]} の勝ち(${state.result.reason === "connect" ? "連結" : "投了"})`;
    }
    return `${NAME[state.toMove]} の番`;
  }, [state]);

  return (
    <div className="screen game">
      <header className="bar">
        <button onClick={onExit}>← 戻る</button>
        <div className={`status ${state.result ? "over" : state.toMove}`}>{status}</div>
        <span className="muted">{state.moves.length} 手</span>
      </header>

      <BoardSvg
        state={state}
        interactive={state.result ? null : "both"}
        onPlace={onPlace}
        selectedLinks={selected}
        onToggleLink={onToggleLink}
        rotated={rotated}
      />

      {selected.size > 0 && (
        <div className="hint">選択した自リンク {selected.size} 本を外して着手します(もう一度タップで解除)</div>
      )}
      {error && <div className="hint error">{error}</div>}

      <div className="controls">
        {state.canSwap && !state.result && (
          <button className="primary" onClick={() => play({ type: "swap" })}>スワップ(パイルール)</button>
        )}
        <button disabled={state.moves.length === 0} onClick={() => { setState((s) => undo(s)); setSelected(new Set()); }}>待った</button>
        <button disabled={!!state.result} onClick={() => { if (confirm("投了しますか?")) play({ type: "resign" }); }}>投了</button>
        <button disabled={!!state.result} onClick={() => { if (confirm("引き分けにしますか?")) play({ type: "draw" }); }}>引き分け</button>
        <label className="toggle"><input type="checkbox" checked={rotateForBlack} onChange={(e) => setRotateForBlack(e.target.checked)} /> 黒番で盤を回転</label>
      </div>

      <details className="record">
        <summary>棋譜</summary>
        <code>{movesToStr(state.moves) || "(まだ手がありません)"}</code>
        <button onClick={() => navigator.clipboard?.writeText(movesToStr(state.moves))}>コピー</button>
      </details>

      {state.result && (
        <div className="result">
          <strong>{status}</strong>
          <button className="primary" onClick={() => { setState(newGame(settings)); setSelected(new Set()); }}>もう一度</button>
        </div>
      )}
    </div>
  );
}
