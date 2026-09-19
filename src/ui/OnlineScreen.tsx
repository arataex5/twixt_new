import { useEffect, useRef, useState } from "react";
import type { Player } from "../core/board";
import type { GameSettings, Move } from "../core/game";
import { createRoom, ensureSignedIn, joinRoom, leaveRoom, normalizeCode, sendMove, subscribeRoom, updateRoomSettings, type RoomView } from "../net/room";
import { GameScreen } from "./GameScreen";

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

export function OnlineScreen({ settings, onSettingsChange, onExit }: OnlineScreenProps) {
  const [phase, setPhase] = useState<Phase>({ name: "menu" });
  const [hostColor, setHostColor] = useState<Player | "random">("random");
  const [codeInput, setCodeInput] = useState(() => normalizeCode(new URLSearchParams(location.search).get("room") ?? ""));
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<RoomView | null>(null);
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
      if (view?.data.status === "finished" || view?.data.status === "waiting") {
        try { localStorage.removeItem(LAST_ROOM_KEY); } catch { /* ignore */ }
      }
    }
    setView(null);
    setPhase({ name: "menu" });
  };

  if (phase.name === "busy") {
    return <div className="screen"><p className="muted">{phase.message}</p></div>;
  }

  if (phase.name === "room") {
    if (!view) return <div className="screen"><p className="muted">ルームに接続中…</p><button onClick={exitRoom}>戻る</button></div>;
    const myColorNow: Player = view.myColor ?? phase.myColor;
    if (view.data.status === "waiting") {
      const url = `${location.origin}${location.pathname}?room=${phase.code}`;
      return (
        <div className="screen">
          <header className="bar"><button onClick={exitRoom}>← 戻る</button><h2>相手を待っています</h2></header>
          <div className="roomcode">{phase.code}</div>
          <p className="muted">相手にこのルームコードを伝えてください。あなたは {myColorNow === "white" ? "白(先手・上下)" : "赤(後手・左右)"} です。</p>
          <div className="controls">
            <button onClick={() => navigator.clipboard?.writeText(phase.code)}>コードをコピー</button>
            {"share" in navigator && (
              <button className="primary" onClick={() => (navigator as Navigator).share({ title: "TWIXT 対戦", text: `TWIXT で対戦しよう。ルームコード: ${phase.code}`, url }).catch(() => {})}>共有</button>
            )}
          </div>
          {myColorNow && (
            <section className="card">
              <h3>ルームの設定 <span className="muted small">(相手が入るまで変更できます)</span></h3>
              <SettingsForm
                hostColor={myColorNow}
                settings={view.data.settings}
                allowRandom={false}
                onChange={(color, s) => {
                  if (color === "random") return;
                  onSettingsChange(s);
                  updateRoomSettings(phase.code, phase.uid, s, color).catch((e) => setError((e as Error).message));
                }}
              />
              {error && <div className="hint error">{error}</div>}
            </section>
          )}
        </div>
      );
    }
    const send = (move: Move, expectedIndex: number) => sendMove(phase.code, phase.uid, move, expectedIndex);
    return (
      <GameScreen
        key={phase.code}
        settings={view.data.settings}
        online={{ code: phase.code, myColor: myColorNow, moves: view.data.moves, status: view.data.status, result: view.data.result ?? null, opponentOnline: view.opponentOnline, send }}
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
        <SettingsForm hostColor={hostColor} settings={settings} allowRandom onChange={(color, s) => { setHostColor(color); onSettingsChange(s); }} />
        <button className="primary big" onClick={() => enterRoom(() => createRoom(settings, hostColor), "ルームを作成中…")}>ルームを作る</button>
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
      <p className="muted small">ルームは 24 時間で消えます。対局中に通信が切れても、同じコードで再接続すれば続きから打てます。</p>
    </div>
  );
}

/** ルーム設定フォーム(作成前・待機中で共通)。ソロモードの設定画面と同じ説明を付ける */
function SettingsForm({ hostColor, settings, allowRandom, onChange }: {
  hostColor: Player | "random";
  settings: GameSettings;
  allowRandom: boolean;
  onChange: (color: Player | "random", s: GameSettings) => void;
}) {
  return (
    <>
      <label className="row">
        <span>あなたの色</span>
        <select value={hostColor} onChange={(e) => onChange(e.target.value as Player | "random", settings)}>
          {allowRandom && <option value="random">ランダム</option>}
          <option value="white">白(先手・上下)</option>
          <option value="black">赤(後手・左右)</option>
        </select>
      </label>
      <label className="row">
        <span>パイルール(スワップ)<br /><small className="muted">後手は先手の初手を「奪う」ことができる。初手は主対角線で鏡映され赤の駒になる</small></span>
        <input type="checkbox" checked={settings.pieRule} onChange={(e) => onChange(hostColor, { ...settings, pieRule: e.target.checked })} />
      </label>
      <label className="row">
        <span>ルール</span>
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
