import { useEffect, useMemo, useRef, useState } from "react";
import type { LinkId, Player } from "../core/board";
import { applyMove, newGame, replay, undo, type GameSettings, type GameState, type Move, type Result } from "../core/game";
import { movesToStr, pointToStr, strToMoves } from "../core/notation";
import { getEngine, type ThinkResult } from "../engine/EngineClient";
import { levelSpec } from "../engine/levels";
import { addRecord, clearInProgress, saveInProgress } from "../store/history";
import { BoardSvg } from "./BoardSvg";

export interface CpuConfig {
  /** CPU が持つ色 */
  color: Player;
  level: number;
  /** Lv6 の思考時間(ms) */
  strongestTimeMs?: number;
}

export interface OnlineConfig {
  code: string;
  myColor: Player;
  /** サーバー上の棋譜(購読で更新される) */
  moves: string;
  status: "waiting" | "playing" | "finished";
  /** サーバーが確定した結果(投了は手番に関係なく起きるので棋譜からは復元できない) */
  result: Result;
  opponentOnline: boolean;
  send: (move: Move, expectedIndex: number) => Promise<void>;
}

export interface GameScreenProps {
  settings: GameSettings;
  cpu?: CpuConfig;
  online?: OnlineConfig;
  /** 再開/局面指定: 開始時点の手順 */
  initialMoves?: Move[];
  startedAt?: string;
  onExit: () => void;
}

const NAME: Record<Player, string> = { white: "白(上下)", black: "黒(左右)" };

export function GameScreen({ settings, cpu, online, initialMoves, startedAt, onExit }: GameScreenProps) {
  const [state, setState] = useState<GameState>(() => (initialMoves?.length ? replay(settings, initialMoves) : newGame(settings)));
  const startedAtRef = useRef(startedAt ?? new Date().toISOString());
  const savedRef = useRef(false);
  const [selected, setSelected] = useState<Set<LinkId>>(new Set());
  const [rotateForBlack, setRotateForBlack] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [engineStatus, setEngineStatus] = useState<string>(cpu ? "エンジン読み込み中…" : "");
  const [lastThink, setLastThink] = useState<ThinkResult | null>(null);
  const [showCandidates, setShowCandidates] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const humanColor: Player | "both" = online ? online.myColor : cpu ? (cpu.color === "white" ? "black" : "white") : "both";
  const [sending, setSending] = useState(false);

  // オンライン: サーバーの棋譜が更新されたら盤面を同期
  const onlineMoves = online?.moves;
  useEffect(() => {
    if (online === undefined || onlineMoves === undefined) return;
    try {
      const next = replay(settings, strToMoves(onlineMoves).filter((m) => m.type !== "resign"));
      if (online.result) next.result = online.result;
      stateRef.current = next;
      setState(next);
      setSelected(new Set());
    } catch (e) {
      setError(`同期エラー: ${(e as Error).message}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlineMoves, online?.result]);

  // 注意: setState の更新関数の中で throw すると React ごと落ちる(画面が真っ黒になる)ので、
  // 先に次の状態を計算してから setState する
  const stateRef = useRef(state);
  stateRef.current = state;
  const play = (m: Move) => {
    try {
      const prev = stateRef.current;
      if (online && m.type === "resign") {
        setSending(true);
        online.send(m, prev.moves.length).catch((e) => setError(`送信失敗: ${(e as Error).message}`)).finally(() => setSending(false));
        return;
      }
      const next = applyMove(prev, m);
      if (online) {
        // 楽観的に反映してから送信。失敗したらサーバーの状態に戻す
        setSending(true);
        stateRef.current = next;
        setState(next);
        setSelected(new Set());
        setError(null);
        online.send(m, prev.moves.length)
          .catch((e) => {
            setError(`送信失敗: ${(e as Error).message}`);
            const back = replay(settings, strToMoves(online.moves));
            stateRef.current = back;
            setState(back);
          })
          .finally(() => setSending(false));
        return;
      }
      stateRef.current = next;
      setState(next);
      setSelected(new Set());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // 自動保存: 進行中は「続きから」用に、終了したら履歴へ
  useEffect(() => {
    const mode = online ? "online" : cpu ? "cpu" : "local";
    if (online && !state.result) return;
    if (state.result) {
      if (!savedRef.current && state.moves.length > 0) {
        savedRef.current = true;
        addRecord({
          startedAt: startedAtRef.current,
          endedAt: new Date().toISOString(),
          mode, settings: state.settings, cpu,
          moves: movesToStr(state.moves), result: state.result,
        });
      }
      clearInProgress();
    } else if (state.moves.length > 0 && mode !== "online") {
      savedRef.current = false;
      saveInProgress({ startedAt: startedAtRef.current, mode, settings: state.settings, cpu, moves: movesToStr(state.moves), updatedAt: new Date().toISOString() });
    } else {
      clearInProgress();
    }
  }, [state, cpu, online]);

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
    setProgress(null);
    engine.onProgress = (_id, done, total) => { if (!ctrl.signal.aborted) setProgress({ done, total }); };
    engine.ready()
      .then(() => engine.think(state.settings, state.moves, cpu.level, ctrl.signal, cpu.strongestTimeMs))
      .then((r) => {
        if (ctrl.signal.aborted) return;
        setLastThink(r);
        play(r.move);
      })
      .catch((e) => { if (!ctrl.signal.aborted) setError(`CPU エラー: ${(e as Error).message}`); })
      .finally(() => { if (abortRef.current === ctrl) { setThinking(false); setProgress(null); abortRef.current = null; } });
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
    abortRef.current = null;
    setThinking(false);
    setProgress(null);
    // CPU 戦では自分の手と CPU の手をセットで戻す
    const count = cpu && state.moves.length >= 2 && state.toMove !== cpu.color ? 2 : 1;
    try {
      const next = undo(state, count);
      stateRef.current = next;
      setState(next);
    } catch (e) {
      setError((e as Error).message);
    }
    setSelected(new Set());
  };

  const rotated = rotateForBlack && state.toMove === "black" && !state.result;
  const status = useMemo(() => {
    if (state.result) {
      if (state.result.winner === "draw") return "引き分け";
      return `${NAME[state.result.winner]} の勝ち(${state.result.reason === "connect" ? "連結" : "投了"})`;
    }
    if (online?.status === "waiting") return "相手の参加を待っています…";
    const who = online ? (state.toMove === online.myColor ? "あなた" : "相手") : cpu && state.toMove === cpu.color ? "CPU" : cpu ? "あなた" : "";
    const prog = thinking && progress ? (progress.total > 0 ? ` ${progress.done}/${progress.total}` : ` ${progress.done}回`) : "";
    return `${NAME[state.toMove]} の番${who ? `(${who})` : ""}${thinking ? ` 思考中…${prog}` : ""}${sending ? " 送信中…" : ""}`;
  }, [state, cpu, online, thinking, progress, sending]);

  // スワップ(パイルール)の説明: 初手のペグは主対角線で鏡映されて黒の駒になる
  const swapNotice = useMemo(() => {
    const last = state.moves[state.moves.length - 1];
    const first = state.moves[0];
    if (!last || last.type !== "swap" || !first || first.type !== "place") return null;
    const from = pointToStr(first.x, first.y), to = pointToStr(first.y, first.x);
    const who = online ? (online.myColor === "black" ? "あなた" : "相手") : cpu ? (cpu.color === "black" ? "CPU" : "あなた") : "後手";
    return `${who}がスワップしました: 初手 ${from}(白) は ${to}(黒) に鏡映され、後手の駒になりました。白の番です。`;
  }, [state.moves, cpu]);

  const overlay = useMemo(() => {
    if (!showCandidates || !lastThink) return undefined;
    const m = new Map<number, number>();
    const max = Math.max(...lastThink.candidates.map((c) => c.p), 1e-9);
    for (const c of lastThink.candidates) m.set(c.cell, c.p / max);
    return m;
  }, [showCandidates, lastThink]);

  const interactive: Player | "both" | null = state.result ? null : thinking || sending ? null : online?.status === "waiting" ? null : humanColor;
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
      {online && (
        <div className="muted small">
          ルーム <strong>{online.code}</strong> · あなたは {NAME[online.myColor]} · 相手: {online.status === "waiting" ? "未参加" : online.opponentOnline ? "接続中" : "切断中(復帰待ち)"}
        </div>
      )}
      {cpu && (
        <div className="muted small">
          {engineStatus}
          {lastThink && ` / CPU評価 ${(lastThink.value * 100).toFixed(0)}%(CPU視点) ${(lastThink.evalMs / 1000).toFixed(1)}s${lastThink.sims !== undefined ? ` ${lastThink.sims}回読み` : ""}`}
          {" / Lv"}{cpu.level} {levelSpec(cpu.level).name}
        </div>
      )}

      <div className="controls">
        {canHumanSwap && (
          <button className="primary" onClick={() => play({ type: "swap" })}>スワップ(パイルール)</button>
        )}
        {!online && <button disabled={state.moves.length === 0} onClick={doUndo}>待った</button>}
        <button disabled={!!state.result} onClick={() => { if (confirm("投了しますか?")) { abortRef.current?.abort(); play({ type: "resign" }); } }}>投了</button>
        {!cpu && !online && <button disabled={!!state.result} onClick={() => { if (confirm("引き分けにしますか?")) play({ type: "draw" }); }}>引き分け</button>}
        {!cpu && !online && <label className="toggle"><input type="checkbox" checked={rotateForBlack} onChange={(e) => setRotateForBlack(e.target.checked)} /> 黒番で盤を回転</label>}
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
          {!online && <button className="primary" onClick={() => { const n = newGame(settings); stateRef.current = n; setState(n); setSelected(new Set()); setLastThink(null); savedRef.current = false; startedAtRef.current = new Date().toISOString(); }}>もう一度</button>}
        </div>
      )}
    </div>
  );
}
