import { useEffect, useRef, useState } from "react";
import type { Player } from "../core/board";
import type { GameSettings, Move } from "../core/game";
import { createRoom, drawAction, ensureSignedIn, joinRoom, leaveRoom, normalizeCode, sendMove, setReady, startGame, subscribeRoom, updateRoomSettings, type RoomView } from "../net/room";
import { GameScreen } from "./GameScreen";
import { HelpButton, PIE_RULE_HELP, RULES_HELP } from "./Help";

export interface OnlineScreenProps {
  settings: GameSettings;
  onSettingsChange: (s: GameSettings) => void;
  onExit: () => void;
}

type Phase =
  | { name: "menu" }
  | { name: "busy"; message: string }
  | { name: "room"; code: string; myColor: Player; uid: string };

const LAST_ROOM_KEY = "twixt.online.lastRoom";
const NAME: Record<Player, string> = { white: "白(先手・上下)", black: "赤(後手・左右)" };

export function OnlineScreen({ settings, onSettingsChange, onExit }: OnlineScreenProps) {
  const [phase, setPhase] = useState<Phase>({ name: "menu" });
  const [codeInput, setCodeInput] = useState(() => normalizeCode(new URLSearchParams(location.search).get("room") ?? ""));
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<RoomView | null>(null);
  const [busy, setBusy] = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);

  // 直前のルームに戻れるように
  const last = (() => { try { return localStorage.getItem(LAST_ROOM_KEY); } catch { return null; } })();

  const enterRoom = async (fn: () => Promise<{ code: string; myColor: Player }>, msg: string) => {
    setError(null);
    setPhase({ name: "busy", message: msg });
    try {
      const uid = await ensureSignedIn();
      const { code, myColor } = await fn();
      try { localStorage.setItem(LAST_ROOM_KEY, code); } catch { /* ignore */ }
      setPhase({ name: "room", code, myColor, uid });
    } catch (e) {
      setError((e as Error).message);
      setPhase({ name: "menu" });
    }
  };

  // ルーム購読
  useEffect(() => {
    if (phase.name !== "room") return;
    const unsub = subscribeRoom(phase.code, phase.uid, setView);
    unsubRef.current = unsub;
    return () => { unsub(); unsubRef.current = null; };
  }, [phase]);

  const exitRoom = async () => {
    if (phase.name === "room") {
      unsubRef.current?.();
      await leaveRoom(phase.code, phase.uid).catch(() => {});
      const st = view?.data.status;
      if (st === "finished" || st === "waiting" || st === "ready") {
        try { localStorage.removeItem(LAST_ROOM_KEY); } catch { /* ignore */ }
      }
    }
    setView(null);
    setError(null);
    setPhase({ name: "menu" });
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  if (phase.name === "busy") {
    return <div className="screen"><p className="muted">{phase.message}</p></div>;
  }

  if (phase.name === "room") {
    if (!view) return <div className="screen"><p className="muted">ルームに接続中…</p><button onClick={exitRoom}>戻る</button></div>;
    const myColor: Player = view.myColor ?? phase.myColor;
    const status = view.data.status;
    const url = `${location.origin}${location.pathname}?room=${phase.code}`;
    const isHost = view.hostUid === phase.uid;
    const canEdit = isHost && (status === "waiting" || status === "ready");

    if (status === "waiting" || status === "ready") {
      const oppColor: Player = myColor === "white" ? "black" : "white";
      const myReady = !!view.data.ready?.[myColor];
      const oppReady = !!view.data.ready?.[oppColor];
      const oppPresent = !!view.data.players?.[oppColor];
      return (
        <div className="screen">
          <header className="bar"><button onClick={exitRoom}>← 戻る</button><h2>{status === "waiting" ? "相手を待っています" : "準備確認"}</h2></header>
          <div className="roomcode">{phase.code}</div>
          {status === "waiting" ? (
            <>
              <p className="muted">相手にこのルームコードを伝えてください。</p>
              <div className="controls">
                <button onClick={() => navigator.clipboard?.writeText(phase.code)}>コードをコピー</button>
                {"share" in navigator && (
                  <button className="primary" onClick={() => (navigator as Navigator).share({ title: "TWIXT 対戦", text: `TWIXT で対戦しよう。ルームコード: ${phase.code}`, url }).catch(() => {})}>共有</button>
                )}
              </div>
            </>
          ) : (
            <section className="card ready">
              <h3>プレイヤー</h3>
              <div className="ready-row"><span className="pill white">白(先手)</span><span>{playerLabel(view, "white", phase.uid)}</span><span className={`ready-mark ${view.data.ready?.white ? "on" : ""}`}>{readyLabel(view, "white")}</span></div>
              <div className="ready-row"><span className="pill black">赤(後手)</span><span>{playerLabel(view, "black", phase.uid)}</span><span className={`ready-mark ${view.data.ready?.black ? "on" : ""}`}>{readyLabel(view, "black")}</span></div>
              {!view.opponentOnline && oppPresent && <div className="hint">相手との接続が切れています(復帰待ち)</div>}
              {isHost ? (
                <>
                  <button className="primary big" disabled={busy || !oppReady || !view.opponentOnline} onClick={() => run(() => startGame(phase.code, phase.uid))}>
                    ゲーム開始
                  </button>
                  <p className="muted small">{oppReady ? "相手の準備ができました。「ゲーム開始」で対局を始めます。" : "相手が「準備完了」を押すと開始できます。"}</p>
                </>
              ) : (
                <>
                  <button className={`big ${myReady ? "" : "primary"}`} disabled={busy || !view.opponentOnline} onClick={() => run(() => setReady(phase.code, phase.uid, !myReady))}>
                    {myReady ? "準備完了を取り消す" : "準備完了"}
                  </button>
                  <p className="muted small">{myReady ? "ホストが「ゲーム開始」を押すのを待っています…" : "設定を確認して「準備完了」を押してください。"}</p>
                </>
              )}
            </section>
          )}

          <section className="card">
            <h3>ルームの設定 {canEdit ? <span className="muted small">(ホストが変更できます)</span> : <span className="muted small">(ホストが設定します)</span>}</h3>
            {canEdit ? (
              <SettingsForm
                hostColor={myColor}
                settings={view.data.settings}
                onChange={(color, s) => {
                  onSettingsChange(s);
                  run(() => updateRoomSettings(phase.code, phase.uid, s, color));
                }}
              />
            ) : (
              <SettingsSummary settings={view.data.settings} myColor={myColor} />
            )}
          </section>
          {error && <div className="hint error">{error}</div>}
        </div>
      );
    }

    const send = (move: Move, expectedIndex: number) => sendMove(phase.code, phase.uid, move, expectedIndex);
    return (
      <GameScreen
        key={phase.code}
        settings={view.data.settings}
        online={{ code: phase.code, myColor, moves: view.data.moves, status: view.data.status, result: view.data.result ?? null, opponentOnline: view.opponentOnline, send, drawOffer: view.data.drawOffer ?? null, draw: (action) => drawAction(phase.code, phase.uid, action) }}
        initialMoves={[]}
        onExit={exitRoom}
      />
    );
  }

  return (
    <div className="screen">
      <header className="bar"><button onClick={onExit}>← 戻る</button><h2>オンライン対戦</h2></header>
      {error && <div className="hint error">{error}</div>}

      <section className="card">
        <h3>ルームを作る</h3>
        <p className="muted small">ルームを作ったあとに、色・パイルール・ルールを設定できます。</p>
        <button className="primary big" onClick={() => enterRoom(() => createRoom(settings, "random"), "ルームを作成中…")}>ルームを作る</button>
      </section>

      <section className="card">
        <h3>ルームに入る</h3>
        <input type="text" className="codeinput" value={codeInput} placeholder="ルームコード(6文字)" maxLength={8}
          autoCapitalize="characters" autoCorrect="off" spellCheck={false}
          onChange={(e) => setCodeInput(normalizeCode(e.target.value))} />
        <button className="primary big" disabled={codeInput.length !== 6} onClick={() => enterRoom(() => joinRoom(codeInput), "ルームに参加中…")}>参加</button>
      </section>

      {last && (
        <button className="big" onClick={() => enterRoom(() => joinRoom(last), "ルームに再接続中…")}>直前のルーム({last})に戻る</button>
      )}
      <p className="muted small">ルームは相手が入るまで開いたままです。対局中に通信が切れても、同じコードで再接続すれば続きから打てます(相手もアプリを開いている必要があります)。</p>
    </div>
  );
}

function readyLabel(view: RoomView, color: Player): string {
  const uid = view.data.players?.[color];
  if (!uid) return "";
  if (uid === view.hostUid) return "ホスト";
  return view.data.ready?.[color] ? "準備完了" : "未完了";
}

function playerLabel(view: RoomView, color: Player, uid: string): string {
  const p = view.data.players?.[color];
  if (!p) return "(空き)";
  return p === uid ? "あなた" : "相手";
}

/** ルーム設定フォーム(ホスト用)。ソロモードの設定画面と同じ説明を付ける */
function SettingsForm({ hostColor, settings, onChange }: {
  hostColor: Player;
  settings: GameSettings;
  onChange: (color: Player, s: GameSettings) => void;
}) {
  return (
    <>
      <label className="row">
        <span>あなたの色</span>
        <select value={hostColor} onChange={(e) => onChange(e.target.value as Player, settings)}>
          <option value="white">白(先手・上下)</option>
          <option value="black">赤(後手・左右)</option>
        </select>
      </label>
      <label className="row">
        <span>パイルール(スワップ) <HelpButton title="パイルール(スワップ)">{PIE_RULE_HELP}</HelpButton><br /><small className="muted">後手は先手の初手を「奪う」ことができる。初手は主対角線で鏡映され赤の駒になる</small></span>
        <input type="checkbox" checked={settings.pieRule} onChange={(e) => onChange(hostColor, { ...settings, pieRule: e.target.checked })} />
      </label>
      <label className="row">
        <span>ルール <HelpButton title="ルールの違い">{RULES_HELP.standard}{RULES_HELP.pp}</HelpButton></span>
        <select value={settings.rules} onChange={(e) => onChange(hostColor, { ...settings, rules: e.target.value as GameSettings["rules"] })}>
          <option value="standard">標準(リンク除去あり・交差不可)</option>
          <option value="pp">PP(自リンク交差可・除去なし)</option>
        </select>
      </label>
      <p className="muted small">
        {settings.rules === "pp"
          ? "PP(ペーパー・アンド・ペンシル): 自分のリンク同士は交差できる。リンクを外す操作はない。相手のリンクとは交差できない。"
          : "標準: リンクはどのリンクとも交差できない。着手時に自分のリンクを選んで外し、道を空けることができる。"}
      </p>
    </>
  );
}

function SettingsSummary({ settings, myColor }: { settings: GameSettings; myColor: Player }) {
  return (
    <>
      <div className="row"><span>あなたの色</span><strong>{NAME[myColor]}</strong></div>
      <div className="row"><span>パイルール(スワップ) <HelpButton title="パイルール(スワップ)">{PIE_RULE_HELP}</HelpButton></span><strong>{settings.pieRule ? "あり" : "なし"}</strong></div>
      <div className="row"><span>ルール <HelpButton title="ルールの違い">{RULES_HELP.standard}{RULES_HELP.pp}</HelpButton></span><strong>{settings.rules === "pp" ? "PP(自リンク交差可・除去なし)" : "標準(リンク除去あり・交差不可)"}</strong></div>
    </>
  );
}
