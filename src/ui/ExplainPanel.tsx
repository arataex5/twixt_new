export interface ExplainCandidate {
  coord: string;
  /** Policy 確率 or 訪問割合 */
  p: number;
  n?: number;
  q?: number;
}

export interface Explanation {
  /** 解説対象の手 */
  coord: string;
  level: number;
  headline: string;
  bullets: string[];
  /** CPU 視点の勝率(%)。着手を決めた時点の読み / 着手後の局面評価 */
  winBefore: number | null;
  winAfter: number | null;
  sims?: number;
  candidates: ExplainCandidate[];
}

export function ExplainPanel({ exp, busy }: { exp: Explanation; busy: boolean }) {
  const delta = exp.winBefore !== null && exp.winAfter !== null ? exp.winAfter - exp.winBefore : null;
  return (
    <div className="explain">
      <div className="explain-head">
        <strong>CPU の手: {exp.coord}</strong>
        <span className="muted small">Lv{exp.level}{exp.sims !== undefined ? ` · ${exp.sims} 回読み` : " · 読みなし(直感)"}</span>
      </div>
      <p className="explain-headline">{exp.headline}</p>
      <ul className="explain-list">
        {exp.bullets.map((b, i) => <li key={i}>{b}</li>)}
      </ul>
      <div className="explain-nums">
        {exp.winBefore !== null && <span>選んだ時点の CPU 勝率 <strong>{exp.winBefore}%</strong></span>}
        {exp.winAfter !== null
          ? <span>着手後の評価 <strong>{exp.winAfter}%</strong>{delta !== null ? `(${delta >= 0 ? "+" : ""}${delta})` : ""}</span>
          : busy ? <span className="muted">着手後の評価を計算中…</span> : null}
      </div>
      {exp.candidates.length > 1 && (
        <details className="explain-cands">
          <summary>ほかに考えていた手</summary>
          <ol>
            {exp.candidates.map((c, i) => (
              <li key={c.coord + i}>
                <code>{c.coord}</code>{" "}
                {c.n !== undefined
                  ? <span className="muted small">{c.n} 回読み{c.q !== undefined ? ` · 評価 ${Math.round(((c.q + 1) / 2) * 100)}%` : ""}</span>
                  : <span className="muted small">確信度 {Math.round(c.p * 100)}%</span>}
              </li>
            ))}
          </ol>
        </details>
      )}
      <p className="muted small">
        ※ CPU は言葉で理由を持っていません。ここでの解説は、盤面から計算できる事実(残り距離・ブロック・セットアップ)と CPU の評価値を突き合わせた後付けの説明です。
      </p>
    </div>
  );
}
