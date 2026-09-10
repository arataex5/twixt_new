import { useState } from "react";
import { DEFAULT_SETTINGS, type GameSettings, type Move } from "../core/game";
import { strToMoves } from "../core/notation";
import { levelSpec } from "../engine/levels";
import { clearHistory, deleteRecord, loadHistory, resultLabel, type GameRecord } from "../store/history";

export interface HistoryScreenProps {
  onExit: () => void;
  onOpen: (title: string, settings: GameSettings, moves: Move[]) => void;
}

function fmt(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function HistoryScreen({ onExit, onOpen }: HistoryScreenProps) {
  const [list, setList] = useState<GameRecord[]>(loadHistory);
  const [paste, setPaste] = useState("");
  const [pasteErr, setPasteErr] = useState<string | null>(null);

  const openPasted = () => {
    try {
      const moves = strToMoves(paste);
      if (moves.length === 0) throw new Error("棋譜が空です");
      onOpen("貼り付けた棋譜", { ...DEFAULT_SETTINGS, pieRule: true }, moves);
    } catch (e) {
      setPasteErr((e as Error).message);
    }
  };

  return (
    <div className="screen">
      <header className="bar"><button onClick={onExit}>← 戻る</button><h2>対局履歴</h2><span className="muted small">{list.length} 局</span></header>

      {list.length === 0 && <p className="muted">まだ対局がありません。対局が終わると自動で保存されます。</p>}

      <ul className="history">
        {list.map((r) => {
          const title = r.mode === "cpu" && r.cpu
            ? `CPU Lv${r.cpu.level} ${levelSpec(r.cpu.level).name}(あなた: ${r.cpu.color === "white" ? "黒" : "白"})`
            : r.mode === "online" ? "オンライン対戦" : "ローカル対戦";
          return (
            <li key={r.id} className="history-item">
              <div className="history-main" onClick={() => onOpen(`${title} — ${resultLabel(r.result, r.cpu)}`, r.settings, strToMoves(r.moves))}>
                <div><strong>{resultLabel(r.result, r.cpu)}</strong> <span className="muted small">{fmt(r.endedAt)}</span></div>
                <div className="muted small">{title} · {r.moves.split(/\s+/).filter(Boolean).length} 手{r.settings.pieRule ? "" : " · パイ無し"}{r.settings.rules === "pp" ? " · PP" : ""}</div>
              </div>
              <button className="small" onClick={() => { if (confirm("この対局を削除しますか?")) { deleteRecord(r.id); setList(loadHistory()); } }}>削除</button>
            </li>
          );
        })}
      </ul>

      <details className="record">
        <summary>棋譜を貼り付けて再生</summary>
        <textarea rows={3} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="例: L12 swap F9 H12 ..." />
        {pasteErr && <div className="hint error">{pasteErr}</div>}
        <button onClick={openPasted}>再生</button>
      </details>

      {list.length > 0 && (
        <button className="danger" onClick={() => { if (confirm("履歴をすべて削除しますか?")) { clearHistory(); setList([]); } }}>履歴をすべて削除</button>
      )}
    </div>
  );
}
