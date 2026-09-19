// ヘルプ部品: 「?」ボタン(押すと説明が開く)と、TWIXT の基本形リファレンス
import { useState, type ReactNode } from "react";

/** 丸い「?」ボタン。押すと直下に説明ボックスを開閉する */
export function HelpButton({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="help">
      <button type="button" className="help-btn" aria-label={`${title}の説明`} aria-expanded={open} onClick={(e) => { e.preventDefault(); setOpen((o) => !o); }}>?</button>
      {open && (
        <div className="help-box" onClick={(e) => e.preventDefault()}>
          <strong>{title}</strong>
          <div>{children}</div>
        </div>
      )}
    </span>
  );
}

export const PIE_RULE_HELP = (
  <>
    <p>先手(白)が有利になりすぎないための決まりです。</p>
    <p>白が 1 手目を置いたあと、赤(後手)は次のどちらかを選べます。</p>
    <p>1. そのまま自分の手を打つ。<br />2. <b>スワップ</b>: 白の 1 手目を「奪う」。その駒は盤の対角線で折り返した位置に移り、赤の駒になります。そのあと白が続けて打ちます。</p>
    <p>スワップされると損なので、白は「奪われても奪われなくても五分」くらいの場所に 1 手目を置くのがコツです。</p>
  </>
);

export const RULES_HELP: Record<"standard" | "pp", ReactNode> = {
  standard: (
    <>
      <p><b>標準ルール</b>: リンク(橋)は自分のものも相手のものも交差できません。</p>
      <p>自分のリンクが邪魔で新しいリンクを張れないときは、着手のときに自分のリンクを選んで外せます(盤上のリンクをタップして選択 → 着手で確定)。</p>
    </>
  ),
  pp: (
    <>
      <p><b>PP(ペーパー&ペンシル)ルール</b>: 自分のリンク同士は交差してかまいません。相手のリンクとは交差できません。</p>
      <p>リンクを外す操作はありません。紙と鉛筆で遊ぶときの簡易ルールで、CPU(twixtbot)はこのルールで学習しています。</p>
    </>
  ),
};

// ---- 基本形 ----

interface Pattern {
  name: string;
  offset: [number, number];
  summary: string;
  detail: string;
}

/** 2 つの駒が「どちらか一方の中継点」で必ずつながる形(相手は両方は塞げない) */
const PATTERNS: Pattern[] = [
  { name: "ナイト跳び(リンク)", offset: [1, 2], summary: "縦 2・横 1(または縦 1・横 2)離れた駒は自動で橋がかかる", detail: "TWIXT の基本。チェスのナイトと同じ動きの位置に置くと、間に他の橋がなければ自動でリンクされます。" },
  { name: "斜め隣", offset: [1, 1], summary: "斜めに隣り合う 2 駒は、2 通りの中継点でつながる", detail: "中継点が 2 か所あるので、相手が片方を塞いでももう片方でつながります。最も手堅い形です。" },
  { name: "縦 4(横 4)", offset: [0, 4], summary: "同じ列(行)で 4 つ離れた 2 駒", detail: "中継点は左右に 1 つずつ。まっすぐ遠くまで伸ばしたいときの形で、相手の妨害に強いです。" },
  { name: "1・3 の形", offset: [1, 3], summary: "横 1・縦 3 離れた 2 駒", detail: "L 字のような形。中継点は 2 か所あり、進む方向を少しずらしながら伸ばせます。" },
  { name: "斜め 3", offset: [3, 3], summary: "斜めに 3 つ離れた 2 駒", detail: "中継点は 2 か所。斜めに大きく進める形で、盤の広い範囲を一気にカバーします。" },
];

const K = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];

function commonKnight(a: [number, number], b: [number, number]): [number, number][] {
  const na = new Set(K.map(([dx, dy]) => `${a[0] + dx},${a[1] + dy}`));
  return K.map(([dx, dy]) => [b[0] + dx, b[1] + dy] as [number, number]).filter(([x, y]) => na.has(`${x},${y}`));
}

function PatternSvg({ offset }: { offset: [number, number] }) {
  const a: [number, number] = [0, 0];
  const b: [number, number] = [offset[0], offset[1]];
  const mids = commonKnight(a, b);
  const pts = [a, b, ...mids];
  const minX = Math.min(...pts.map((p) => p[0])) - 1, maxX = Math.max(...pts.map((p) => p[0])) + 1;
  const minY = Math.min(...pts.map((p) => p[1])) - 1, maxY = Math.max(...pts.map((p) => p[1])) + 1;
  const C = 22, PADD = 12;
  const W = (maxX - minX) * C + PADD * 2, H = (maxY - minY) * C + PADD * 2;
  const px = (p: [number, number]) => [PADD + (p[0] - minX) * C, PADD + (p[1] - minY) * C];
  const holes: ReactNode[] = [];
  for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) { const [cx, cy] = px([x, y]); holes.push(<circle key={`${x},${y}`} cx={cx} cy={cy} r={2.4} fill="#a08a5e" />); }
  const linked = Math.abs(b[0]) + Math.abs(b[1]) === 3 && Math.abs(b[0]) !== 0 && Math.abs(b[1]) !== 0;
  const [ax, ay] = px(a), [bx, by] = px(b);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W * 1.6} height={H * 1.6} className="pattern-svg" aria-hidden="true">
      <rect x={0} y={0} width={W} height={H} rx={8} fill="#dcc59c" />
      {holes}
      {linked && <line x1={ax} y1={ay} x2={bx} y2={by} stroke="#fffdf8" strokeWidth={5} strokeLinecap="round" />}
      {!linked && mids.map((m, i) => { const [mx, my] = px(m); return (
        <g key={i}>
          <line x1={ax} y1={ay} x2={mx} y2={my} stroke="#fffdf8" strokeWidth={3} strokeDasharray="4 3" opacity={0.85} />
          <line x1={mx} y1={my} x2={bx} y2={by} stroke="#fffdf8" strokeWidth={3} strokeDasharray="4 3" opacity={0.85} />
          <circle cx={mx} cy={my} r={6} fill="none" stroke="#2f5fb3" strokeWidth={2} strokeDasharray="3 2" />
        </g>
      ); })}
      {[a, b].map((p, i) => { const [cx, cy] = px(p); return <circle key={i} cx={cx} cy={cy} r={7} fill="#fffdf8" stroke="#6f6350" strokeWidth={1.8} />; })}
    </svg>
  );
}

/** 基本形の一覧。各項目はタップで展開 */
export function PatternsPanel() {
  return (
    <details className="record patterns">
      <summary>基本形(タップで展開)</summary>
      <p className="muted small">2 つの駒が「2 通りの中継点」でつながる形は、相手が両方を同時に塞げないので確実につながります。点線の丸が中継点です。</p>
      {PATTERNS.map((p) => (
        <details key={p.name} className="pattern">
          <summary><strong>{p.name}</strong> <span className="muted small">— {p.summary}</span></summary>
          <div className="pattern-body">
            <PatternSvg offset={p.offset} />
            <p className="small">{p.detail}</p>
          </div>
        </details>
      ))}
    </details>
  );
}
