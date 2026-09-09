import { useEffect, useMemo, useState } from "react";
import { replay, type GameSettings, type Move } from "../core/game";
import { moveToStr, movesToStr } from "../core/notation";
import { BoardSvg } from "./BoardSvg";

export interface ReplayScreenProps {
  title: string;
  settings: GameSettings;
  moves: Move[];
  onExit: () => void;
  /** 「この局面から対局」: 手順を渡す */
  onPlayFrom?: (moves: Move[]) => void;
}

export function ReplayScreen({ title, settings, moves, onExit, onPlayFrom }: ReplayScreenProps) {
  const [ply, setPly] = useState(moves.length);
  const state = useMemo(() => replay(settings, moves.slice(0, ply)), [settings, moves, ply]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") setPly((p) => Math.max(0, p - 1));
      if (e.key === "ArrowRight") setPly((p) => Math.min(moves.length, p + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moves.length]);

  const last = ply > 0 ? moves[ply - 1] : null;

  return (
    <div className="screen game">
      <header className="bar">
        <button onClick={onExit}>← 戻る</button>
        <div className="status over">{title}</div>
        <span className="muted">{ply}/{moves.length}</span>
      </header>

      <BoardSvg state={state} interactive={null} onPlace={() => {}} />

      <div className="controls replay">
        <button onClick={() => setPly(0)} disabled={ply === 0}>|◀</button>
        <button onClick={() => setPly((p) => Math.max(0, p - 1))} disabled={ply === 0}>◀</button>
        <input type="range" min={0} max={moves.length} value={ply} onChange={(e) => setPly(Number(e.target.value))} />
        <button onClick={() => setPly((p) => Math.min(moves.length, p + 1))} disabled={ply === moves.length}>▶</button>
        <button onClick={() => setPly(moves.length)} disabled={ply === moves.length}>▶|</button>
      </div>
      <div className="muted small">
        {last ? `${ply} 手目: ${moveToStr(last)}` : "開始局面"}
        {state.result ? ` — ${state.result.winner === "draw" ? "引き分け" : state.result.winner === "white" ? "白の勝ち" : "黒の勝ち"}` : ""}
      </div>

      <div className="controls">
        {onPlayFrom && !state.result && (
          <button className="primary" onClick={() => onPlayFrom(moves.slice(0, ply))}>この局面から CPU と対局</button>
        )}
        <button onClick={() => navigator.clipboard?.writeText(movesToStr(moves))}>棋譜をコピー</button>
      </div>

      <details className="record">
        <summary>棋譜</summary>
        <code>
          {moves.map((m, i) => (
            <span key={i} className={i === ply - 1 ? "cur" : ""} onClick={() => setPly(i + 1)}>{moveToStr(m)} </span>
          ))}
        </code>
      </details>
    </div>
  );
}
